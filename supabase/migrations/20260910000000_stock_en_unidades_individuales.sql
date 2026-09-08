-- Venta fraccionada: el stock permanente pasa a medirse en UNIDADES
-- INDIVIDUALES (comprimido / ml / g — lo que diga productos.unidad), no
-- en envases.
--
-- El problema: pdvlat vende suelto. Un cliente se lleva 1 comprimido de
-- una caja de 30, o 200 ml de un frasco de 500. Se decidió NO hacer que
-- el POS resuelva eso (llevaría fracciones y reglas de redondeo a su
-- carrito): Farmacia normaliza todo a "unidad individual" en el borde de
-- la API, y del lado de pdvlat la cuenta sigue siendo, siempre,
-- cantidad × precio_unitario — compre 1 comprimido o la caja entera.
--
--
-- ── Qué NO cambia (a propósito) ────────────────────────────────
--
-- El CONTEO FÍSICO sigue siendo en envases, sin una sola modificación:
-- `conteo_lineas.cantidad`, `lotes.cantidad`, `escaneos.delta` y toda
-- apps/conteo quedan exactamente como estaban. La regla de
-- 20260806000001 en adelante ("la unidad de stock es lo que se escanea",
-- por eso registrar_escaneos_batch no multiplica por
-- codigos_barra.unidades_por_codigo) sigue viva y es correcta: lo que se
-- pasa por el lector es la caja, porque es la caja la que tiene el EAN
-- impreso. Nadie va a escanear comprimidos sueltos.
--
-- `movimientos_stock.delta` tampoco cambia de TIPO: sigue siendo
-- `integer`. La cantidad que manda pdvlat es siempre un entero de
-- unidades sueltas (1 comprimido, 200 ml), así que del lado de los
-- movimientos nunca hace falta aritmética fraccionaria. Lo que cambia es
-- qué SIGNIFICA ese entero.
--
--
-- ── Qué SÍ cambia ──────────────────────────────────────────────
--
-- La conversión ocurre en un solo lugar: stock_actual / stock_actual_lote.
-- Ahí la FOTO base (sum(conteo_lineas.cantidad), en envases) se multiplica
-- por productos.contenido — las unidades que trae cada envase — ANTES de
-- sumarle los movimientos posteriores, que ya vienen denominados en
-- unidades individuales. Las dos puntas quedan en la misma unidad y la
-- resta cierra:
--
--     stock_en_unidades = (envases contados × contenido) + Σ delta
--
-- El factor es `coalesce(nullif(contenido, 0), 1)`, y cada mitad tapa un
-- caso distinto:
--   * nullif(..., 0): un producto cargado con contenido = 0 (dato malo de
--     una importación) multiplicaría TODO el stock por cero y lo dejaría
--     en 0 sin que nadie se entere. Con el nullif cae al fallback en vez
--     de mentir.
--   * coalesce(..., 1): contenido nulo = nunca se cargó el tamaño del
--     envase. Se asume envase == unidad, o sea "este producto ya se
--     maneja suelto". Es el default seguro: deja el stock como estaba
--     antes de esta migración en vez de inventar un múltiplo.
--
-- El tipo de retorno pasa de integer a numeric. contenido es `numeric` y
-- nullable, así que el producto (envases × contenido) puede no ser
-- entero — p. ej. un contenido cargado como 2.5. Castear de vuelta a
-- integer perdería eso en silencio. Los deltas siguen siendo enteros; el
-- que puede tener decimales es el término de la foto.
--
-- No hay backfill: se verificó en producción que movimientos_stock no
-- tiene NI UNA fila con tipo = 'venta' (pdvlat todavía no sincronizó
-- ninguna orden). No hay dato viejo que reinterpretar — es un corte
-- limpio, no una migración de datos.
--
--
-- ═══════════════════════════════════════════════════════════════
--  ⚠  PARA QUIEN CONSTRUYA EL PRÓXIMO RPC DE 'ingreso' / 'ajuste'
-- ═══════════════════════════════════════════════════════════════
-- movimientos_stock.delta SE MIDE EN UNIDADES INDIVIDUALES.
--
-- Si vas a registrar una compra de 10 cajas de 30 comprimidos, el delta
-- es +300, no +10. Nada en el esquema te lo va a impedir: la columna es
-- un integer suelto, sin unidad, y un +10 va a entrar sin chistar y va a
-- descuadrar el stock por un factor de 30 contra su propia foto base.
-- Este comentario, el `comment on column` de abajo y el de registrar_venta
-- son lo único que documenta la convención — hoy el único escritor de la
-- tabla es registrar_venta, y le llega la cantidad ya en unidades desde
-- pdvlat, así que la conversión no existe en ningún lado del código.
-- ═══════════════════════════════════════════════════════════════

comment on column movimientos_stock.delta is
  'Unidades INDIVIDUALES (comprimido/ml/g, según productos.unidad), NO envases. '
  'Negativo descuenta. Un ingreso de 10 cajas de 30 se registra como +300. '
  'La foto base del conteo físico sí está en envases y stock_actual la '
  'convierte multiplicándola por productos.contenido — ver '
  '20260910000000_stock_en_unidades_individuales.sql.';


-- ═══════════════════════════════════════════════════════════════
-- 1. stock_actual
-- ═══════════════════════════════════════════════════════════════
-- Mismo criterio que 20260901000000 (por qué la base es conteo_lineas y
-- no lotes, por qué el "último conteo cerrado" se resuelve por producto,
-- por qué el ámbito es (sucursal, bodega) con null como su propio ámbito,
-- por qué un ámbito sin conteo aporta base 0 y todos sus movimientos):
-- está documentado allá y no se repite acá. Lo único nuevo es el factor
-- de conversión sobre el término de la foto.
--
-- DROP + CREATE en vez de CREATE OR REPLACE: Postgres no deja cambiar el
-- tipo de retorno de una función existente ("cannot change return type of
-- existing function"), y acá pasa de integer a numeric. registrar_venta
-- la sigue llamando sin problema — es plpgsql, resuelve el nombre en
-- tiempo de ejecución, así que el drop no le rompe el cuerpo.
--
-- Sin grants explícitos, como antes: SECURITY INVOKER, la RLS de
-- conteos/conteo_lineas/movimientos_stock filtra sola. El join nuevo a
-- `productos` no abre nada: productos_select es
-- `auth.uid() is not null` (20260806000001), o sea que cualquiera que
-- pueda leer una línea de conteo puede leer el contenido del producto.
drop function if exists public.stock_actual(uuid, uuid, uuid);

create function stock_actual(
  p_empresa_id uuid,
  p_producto_id uuid,
  p_sucursal_id uuid default null
)
returns numeric
language sql
stable
set search_path = ''
as $$
  with ambito as (
    select distinct on (c.sucursal_id, coalesce(c.bodega_id::text, ''))
      c.sucursal_id,
      c.bodega_id,
      c.cerrado_at,
      cl.cantidad
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
  base as (
    -- Envases contados → unidades individuales. El nullif va adentro del
    -- subselect y el coalesce afuera a propósito: así el fallback a 1
    -- cubre los tres casos de una sola vez — contenido = 0, contenido
    -- null, y producto que directamente no existe (subselect sin filas).
    select coalesce(sum(cantidad), 0)::numeric
         * coalesce(
             (select nullif(p.contenido, 0)
                from public.productos p
               where p.id = p_producto_id),
             1
           ) as q
    from ambito
  ),
  posteriores as (
    -- Ya en unidades individuales: no se toca.
    select coalesce(sum(m.delta), 0)::integer as q
    from public.movimientos_stock m
    left join ambito a
      on a.sucursal_id = m.sucursal_id
     and coalesce(a.bodega_id::text, '') = coalesce(m.bodega_id::text, '')
    where m.empresa_id = p_empresa_id
      and m.producto_id = p_producto_id
      and (p_sucursal_id is null or m.sucursal_id = p_sucursal_id)
      and (a.sucursal_id is null or m.created_at > a.cerrado_at)
  )
  select base.q + posteriores.q from base, posteriores;
$$;


-- ═══════════════════════════════════════════════════════════════
-- 2. stock_actual_lote
-- ═══════════════════════════════════════════════════════════════
-- La versión batch de lo mismo (20260908000000): una fila por producto
-- pedido, incluidos los que no tienen ninguna historia (stock 0) y los
-- que no existen. Si alguna vez cambia una de las dos funciones, tienen
-- que cambiar las dos.
--
-- Acá el factor no puede ser un subselect escalar (hay muchos productos),
-- así que sale de un CTE `factor` con left join a productos: la fila
-- siempre existe porque arranca de `pedidos`, y un producto inexistente o
-- sin contenido cae en el mismo fallback a 1.
--
-- Ojo con multiplicar en el lugar correcto: el factor va sobre la base,
-- NUNCA sobre el total. `(base × contenido) + movimientos`, no
-- `(base + movimientos) × contenido` — los movimientos ya están en
-- unidades y volver a multiplicarlos los inflaría por el tamaño del
-- envase.
drop function if exists public.stock_actual_lote(uuid, uuid[], uuid);

create function stock_actual_lote(
  p_empresa_id uuid,
  p_producto_ids uuid[],
  p_sucursal_id uuid default null
)
returns table (producto_id uuid, stock numeric)
language sql
stable
set search_path = ''
as $$
  with pedidos as (
    select distinct u.producto_id
    from unnest(coalesce(p_producto_ids, '{}'::uuid[])) as u(producto_id)
    where u.producto_id is not null
  ),
  factor as (
    select
      ped.producto_id,
      coalesce(nullif(p.contenido, 0), 1) as unidades_por_envase
    from pedidos ped
    left join public.productos p on p.id = ped.producto_id
  ),
  ambito as (
    select distinct on (cl.producto_id, c.sucursal_id, coalesce(c.bodega_id::text, ''))
      cl.producto_id,
      c.sucursal_id,
      c.bodega_id,
      c.cerrado_at,
      cl.cantidad
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
  base as (
    -- Todavía en envases: la conversión se aplica abajo, en el select
    -- final, donde ya está a mano el factor de cada producto.
    select a.producto_id, coalesce(sum(a.cantidad), 0)::numeric as q
    from ambito a
    group by a.producto_id
  ),
  posteriores as (
    -- Ya en unidades individuales: no se toca.
    select m.producto_id, coalesce(sum(m.delta), 0)::integer as q
    from public.movimientos_stock m
    join pedidos ped
      on ped.producto_id = m.producto_id
    left join ambito a
      on a.producto_id = m.producto_id
     and a.sucursal_id = m.sucursal_id
     and coalesce(a.bodega_id::text, '') = coalesce(m.bodega_id::text, '')
    where m.empresa_id = p_empresa_id
      and (p_sucursal_id is null or m.sucursal_id = p_sucursal_id)
      and (a.sucursal_id is null or m.created_at > a.cerrado_at)
    group by m.producto_id
  )
  -- Todas las referencias van calificadas con su alias a propósito:
  -- `producto_id` también es el nombre de una columna de salida de la
  -- función, y sin calificar Postgres corta con "column reference is
  -- ambiguous".
  select
    ped.producto_id,
    (coalesce(b.q, 0) * coalesce(f.unidades_por_envase, 1)
      + coalesce(mov.q, 0))::numeric
  from pedidos ped
  left join factor f on f.producto_id = ped.producto_id
  left join base b on b.producto_id = ped.producto_id
  left join posteriores mov on mov.producto_id = ped.producto_id;
$$;


-- ═══════════════════════════════════════════════════════════════
-- 3. registrar_venta: sin cambios de lógica, solo la convención
-- ═══════════════════════════════════════════════════════════════
-- No hace falta tocar el cuerpo. p_lineas[].cantidad ya se escribía tal
-- cual en delta (`-v_cantidad`), sin conversión de ninguna clase — bajo
-- la convención nueva eso queda automáticamente correcto, porque
-- `cantidad` pasa a significar "unidades individuales vendidas" en vez de
-- "envases vendidos". El contrato con pdvlat no cambia de forma, cambia
-- de unidad.
--
-- Y sigue sin multiplicar por codigos_barra.unidades_por_codigo, por el
-- mismo motivo de siempre: eso convertiría DOS veces (pdvlat ya manda
-- unidades) y descuadraría el stock contra su foto.
comment on function registrar_venta(uuid, uuid, text, jsonb, uuid) is
  'Descarga de stock por venta del POS pdvlat. p_lineas[].cantidad está en '
  'UNIDADES INDIVIDUALES (comprimido/ml/g), no en envases: pdvlat vende '
  'suelto y Farmacia normaliza todo a unidad en el borde de la API. Se '
  'escribe tal cual en movimientos_stock.delta, que usa la misma unidad. '
  'Idempotente por (empresa_id, referencia). Ver '
  '20260910000000_stock_en_unidades_individuales.sql.';
