-- Desglose caja / sueltas del stock, para mostrar el picado en el panel.
--
-- 20260919000000 hizo que el picado (unidades sueltas de una caja ya
-- abierta) entre al stock, pero se lo tragó adentro de un único número
-- total: stock_actual devuelve `(Σ cantidad × contenido) + Σ
-- unidades_sueltas + Σ delta` y nadie puede ver qué parte era picado.
-- El panel de productos quiere mostrarlo ("140 + 10 sueltas"), así que
-- hacen falta las dos partes por separado.
--
--
-- ── Por qué DOS funciones nuevas y no un cambio en stock_actual ─
--
-- stock_actual / stock_actual_lote tienen tres consumidores que NO
-- quieren un desglose y sí dependen de que el retorno sea un escalar /
-- una fila por producto: registrar_venta y ajustar_stock (que hacen
-- aritmética con el número), y /api/pdvlat/catalogo (que lo publica como
-- el campo `stock` del SKU). Cambiarles el tipo de retorno para que un
-- solo lugar del panel muestre dos números sería romperle el contrato a
-- los tres. Estas dos funciones son puramente aditivas: nadie que exista
-- hoy cambia de comportamiento.
--
--
-- ── Dónde se corta el desglose (la decisión de fondo) ──────────
--
-- Un movimiento de `movimientos_stock` (una venta de pdvlat, un ajuste
-- manual por rotura) NO sabe de dónde salió la unidad: al vender un
-- comprimido nadie registra si se sacó del pilón suelto o si se abrió una
-- caja nueva. Esa información no existe en la base y no se puede inventar
-- repartiéndola con alguna heurística — sería un número inventado
-- mostrado con cara de dato.
--
-- Entonces lo único honesto y atribuible como "sueltas" es la FOTO del
-- último conteo cerrado: Σ conteo_lineas.unidades_sueltas, exactamente lo
-- que el operario contó a mano. Todo lo demás — los envases convertidos a
-- unidades Y todos los movimientos posteriores — cae en "caja", que es
-- justo donde caía implícitamente antes de que el picado existiera.
--
--     sueltas = Σ unidades_sueltas del último conteo cerrado (por ámbito)
--     total   = stock_actual(...)  ← tal cual, sin recalcular nada
--     caja    = total − sueltas    ← derivado, no calculado aparte
--
-- `caja` se DERIVA a propósito en vez de computarse por su cuenta. Dos
-- ventajas concretas:
--   1. caja + sueltas = total por construcción, siempre. No hay un
--      segundo camino aritmético que pueda redondear distinto ni un
--      coalesce que cubra un borde y el otro no.
--   2. Si algún día stock_actual vuelve a cambiar (ya cambió dos veces:
--      20260910000000 y 20260919000000), esto sigue siendo correcto
--      gratis, sin que nadie se acuerde de tocar este archivo.
--
-- Por eso el `total` sale de LLAMAR a stock_actual, no de copiar su
-- cuenta acá. Duplicar la aritmética sería garantizar que algún día los
-- dos números que ve el usuario en dos pantallas distintas no coincidan.
--
--
-- Sin grants explícitos, igual que stock_actual / stock_actual_lote:
-- SECURITY INVOKER, así que la RLS de conteos / conteo_lineas /
-- movimientos_stock filtra exactamente igual que hoy. `unidades_sueltas`
-- es una columna más de una fila que quien llama ya podía leer entera.


-- ═══════════════════════════════════════════════════════════════
-- 1. stock_actual_desglose — un producto
-- ═══════════════════════════════════════════════════════════════
-- El CTE `ambito` es el MISMO de stock_actual (20260919000000): el
-- DISTINCT ON resuelve "último conteo cerrado por (sucursal, bodega)",
-- con bodega null tratada como ámbito propio vía coalesce a ''. Si los
-- dos divergieran, `sueltas` estaría mirando un conteo y `total` otro, y
-- `caja` saldría con la diferencia adentro. Van juntos: si cambia el
-- ámbito allá, cambia acá.
--
-- Lo único que no se replica es el resto de la cuenta (el factor
-- contenido, el término `posteriores`): eso ya viene resuelto adentro de
-- stock_actual y volver a escribirlo sería justo lo que este diseño
-- evita.

create or replace function stock_actual_desglose(
  p_empresa_id uuid,
  p_producto_id uuid,
  p_sucursal_id uuid default null
)
returns table (caja numeric, sueltas numeric, total numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with ambito as (
    select distinct on (c.sucursal_id, coalesce(c.bodega_id::text, ''))
      c.sucursal_id,
      c.bodega_id,
      c.cerrado_at,
      cl.unidades_sueltas
    from public.conteos c
    join public.conteo_lineas cl
      on cl.conteo_id = c.id
     and cl.producto_id = p_producto_id
    where c.empresa_id = p_empresa_id
      and c.estado = 'cerrado'
      and c.cerrado_at is not null
      and (p_sucursal_id is null or c.sucursal_id = p_sucursal_id)
    order by c.sucursal_id, coalesce(c.bodega_id::text, ''), c.cerrado_at desc
  ),
  foto as (
    -- Sin multiplicar por productos.contenido: unidades_sueltas ya está
    -- en unidades individuales (son los comprimidos que contó el
    -- operario). El factor es exclusivo del término en envases, que acá
    -- ni se toca. Agregado sin GROUP BY: siempre devuelve una fila, aun
    -- sin ningún conteo (el coalesce da 0).
    select coalesce(sum(a.unidades_sueltas), 0)::numeric as sueltas
    from ambito a
  ),
  medida as (
    select public.stock_actual(p_empresa_id, p_producto_id, p_sucursal_id) as total
  )
  -- Todo calificado con su alias: `sueltas` y `total` también son nombres
  -- de columnas de salida de la función, y sin calificar Postgres corta
  -- con "column reference is ambiguous".
  select (m.total - f.sueltas)::numeric, f.sueltas, m.total
  from foto f, medida m;
$$;

comment on function stock_actual_desglose(uuid, uuid, uuid) is
  'Mismo total que stock_actual, partido en caja + sueltas para mostrarlo. '
  '`sueltas` es la foto del último conteo cerrado (Σ conteo_lineas.unidades_sueltas); '
  '`caja` es todo el resto (envases convertidos + ventas y ajustes posteriores), '
  'derivado como total − sueltas. Los movimientos no son atribuibles a un lado u '
  'otro: nadie sabe si un comprimido vendido salió del picado o de una caja nueva. '
  'Ver 20260920000000_desglose_caja_sueltas_del_stock.sql.';


-- ═══════════════════════════════════════════════════════════════
-- 2. stock_actual_lote_desglose — muchos productos, una consulta
-- ═══════════════════════════════════════════════════════════════
-- La versión batch, para la columna "Stock" de la lista de productos:
-- 50 filas por página = 50 round-trips si se llamara a la de arriba por
-- fila, y encima por cada tecla del buscador. Es el mismo N+1 que
-- stock_actual_lote (20260908000000) ya evita, y este archivo mantiene la
-- regla que rige desde entonces: si cambia una versión, cambia la otra.
--
-- Arranca de `pedidos` (no de `ambito`) para garantizar una fila por
-- producto pedido, incluidos los que no tienen ninguna historia y los que
-- directamente no existen: ahí los left join dan null y los coalesce
-- dejan 0/0/0. La lista necesita poder mostrar "0" y no un hueco.
--
-- No hay CTE `factor` acá, a diferencia de stock_actual_lote: nada se
-- convierte de envases a unidades en esta función. Esa conversión vive
-- entera adentro de stock_actual_lote, que se llama tal cual para el
-- total.

create or replace function stock_actual_lote_desglose(
  p_empresa_id uuid,
  p_producto_ids uuid[],
  p_sucursal_id uuid default null
)
returns table (producto_id uuid, caja numeric, sueltas numeric, total numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with pedidos as (
    select distinct u.producto_id
    from unnest(coalesce(p_producto_ids, '{}'::uuid[])) as u(producto_id)
    where u.producto_id is not null
  ),
  ambito as (
    -- Idéntico al de stock_actual_lote salvo que acá solo interesa
    -- unidades_sueltas: mismo DISTINCT ON por (producto, sucursal,
    -- bodega), mismo orden por cerrado_at desc.
    select distinct on (cl.producto_id, c.sucursal_id, coalesce(c.bodega_id::text, ''))
      cl.producto_id,
      c.sucursal_id,
      c.bodega_id,
      c.cerrado_at,
      cl.unidades_sueltas
    from public.conteos c
    join public.conteo_lineas cl
      on cl.conteo_id = c.id
    join pedidos ped
      on ped.producto_id = cl.producto_id
    where c.empresa_id = p_empresa_id
      and c.estado = 'cerrado'
      and c.cerrado_at is not null
      and (p_sucursal_id is null or c.sucursal_id = p_sucursal_id)
    order by cl.producto_id, c.sucursal_id, coalesce(c.bodega_id::text, ''), c.cerrado_at desc
  ),
  foto as (
    select
      a.producto_id,
      coalesce(sum(a.unidades_sueltas), 0)::numeric as sueltas
    from ambito a
    group by a.producto_id
  ),
  medidas as (
    -- Una sola llamada a la función batch para todos los productos, con
    -- el mismo array que pidió quien llama: así el total de cada fila es
    -- literalmente el mismo número que ya muestran el catálogo de pdvlat
    -- y el modal de edición.
    select sl.producto_id, sl.stock as total
    from public.stock_actual_lote(p_empresa_id, p_producto_ids, p_sucursal_id) sl
  )
  -- Calificado con alias por la misma razón que arriba: producto_id,
  -- caja, sueltas y total son todos nombres de columnas de salida.
  select
    ped.producto_id,
    (coalesce(m.total, 0) - coalesce(f.sueltas, 0))::numeric,
    coalesce(f.sueltas, 0)::numeric,
    coalesce(m.total, 0)::numeric
  from pedidos ped
  left join foto f on f.producto_id = ped.producto_id
  left join medidas m on m.producto_id = ped.producto_id;
$$;

comment on function stock_actual_lote_desglose(uuid, uuid[], uuid) is
  'Versión batch de stock_actual_desglose: una fila por producto pedido (0/0/0 para '
  'los que no tienen historia). `total` sale de stock_actual_lote sin recalcularlo, '
  'así que caja + sueltas = total por construcción. '
  'Ver 20260920000000_desglose_caja_sueltas_del_stock.sql.';
