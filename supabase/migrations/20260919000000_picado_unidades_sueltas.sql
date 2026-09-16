-- PICADO: unidades sueltas en el conteo físico.
--
-- El problema real (planteado por el usuario): una farmacia boliviana casi
-- siempre tiene, además de las cajas cerradas, un "picado" — una caja
-- abierta de la que ya se vendió suelto y quedan N comprimidos flojos en
-- el cajón. Hasta acá el conteo físico solo sabía contar ENVASES: un
-- escaneo = un envase (conteo_lineas.cantidad, entero). Esos comprimidos
-- sueltos no tenían dónde anotarse y desaparecían del stock.
--
--
-- ── Por qué NO alcanza codigos_barra.unidades_por_codigo ───────
--
-- Ese mecanismo (20260813000006) existe para que un código que SÍ está
-- impreso en el blíster/caja valga más de 1 unidad base al escanearse —
-- apps/conteo lo multiplica del lado del cliente (motor-escaneo.ts,
-- deltaReal = delta × unidadesPorCodigo) antes de encolar el evento.
-- Depende, por definición, de que haya un código que pasar por el lector.
-- Un comprimido suelto picado NO tiene código de barras: no hay nada que
-- escanear. Son dos mecanismos paralelos y este no reemplaza ni toca al
-- otro.
--
--
-- ── El mecanismo ───────────────────────────────────────────────
--
-- Se respeta la regla 5 de CONTEXTO.md tal cual: la cantidad de una línea
-- NUNCA se escribe a mano, es siempre la suma de sus eventos en
-- `escaneos`. Un picado entra por el MISMO camino que todo lo demás
-- (cola Dexie → registrar_escaneos_batch → insert en escaneos → trigger),
-- con una sola diferencia: el evento va marcado `es_suelto = true`, y el
-- trigger reparte la suma en dos columnas según esa marca.
--
--     cantidad         = Σ delta donde NOT es_suelto   (envases)
--     unidades_sueltas = Σ delta donde es_suelto       (unidades individuales)
--
-- Dos columnas y no una: son unidades DISTINTAS. Sumarlas sería sumar
-- cajas con comprimidos. La conversión a una unidad común ocurre, como
-- siempre, en stock_actual / stock_actual_lote (punto 4).
--
--
-- ── Qué NO se toca (a propósito) ───────────────────────────────
--
-- * codigos_barra.unidades_por_codigo y el escaneo normal de un envase:
--   sin una sola modificación.
-- * movimientos_stock y el término "posteriores" de stock_actual: igual.
--   Esto cambia solo la FOTO física, no la contabilidad de movimientos.
-- * registrar_venta / ajustar_stock / el endpoint de catálogo de pdvlat:
--   igual. La venta fraccionada ya funciona en unidades individuales
--   desde 20260910000000 y no necesita enterarse de esto.
-- * `lotes` y cerrar_conteo: ver punto 5, con el razonamiento.


-- ═══════════════════════════════════════════════════════════════
-- 1. Columnas nuevas
-- ═══════════════════════════════════════════════════════════════
-- Ambas con NOT NULL DEFAULT, así toda fila vieja queda exactamente como
-- estaba (es_suelto = false: todo lo contado hasta hoy son envases) y
-- ningún cliente viejo que no mande el campo cambia de comportamiento.

alter table escaneos
  add column es_suelto boolean not null default false;

alter table conteo_lineas
  add column unidades_sueltas integer not null default 0;

comment on column escaneos.es_suelto is
  'true = este evento cuenta UNIDADES SUELTAS (picado: comprimidos/ml que quedaron '
  'de una caja abierta), no envases cerrados. Suma a conteo_lineas.unidades_sueltas '
  'en vez de a conteo_lineas.cantidad. Ver 20260919000000_picado_unidades_sueltas.sql.';

comment on column conteo_lineas.unidades_sueltas is
  'Unidades INDIVIDUALES sueltas contadas en esta línea (picado), derivadas por '
  'el trigger recalcular_cantidad_linea como Σ escaneos.delta con es_suelto. '
  'NO se suma a `cantidad`: esa está en envases y esta en unidades. '
  'stock_actual las suma sin multiplicar por productos.contenido — ya son unidades.';


-- ═══════════════════════════════════════════════════════════════
-- 2. recalcular_cantidad_linea: una pasada, dos columnas
-- ═══════════════════════════════════════════════════════════════
-- Mismo trigger de 20260806000001 (AFTER INSERT ON escaneos FOR EACH ROW,
-- no hace falta recrearlo) y misma garantía: las dos columnas se derivan
-- enteras de `escaneos`, nunca se escriben desde afuera.
--
-- Un solo UPDATE con FROM (subconsulta agregada) en vez de dos subselects
-- correlacionados: recorre `escaneos` una sola vez por inserción en vez de
-- dos, y la subconsulta es un agregado sin GROUP BY, así que siempre
-- devuelve exactamente una fila (incluso si no hubiera escaneos: los
-- coalesce dan 0/0).
create or replace function recalcular_cantidad_linea()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.conteo_lineas cl
  set cantidad = agg.envases,
      unidades_sueltas = agg.sueltas
  from (
    select
      coalesce(sum(e.delta) filter (where not e.es_suelto), 0) as envases,
      coalesce(sum(e.delta) filter (where e.es_suelto), 0) as sueltas
    from public.escaneos e
    where e.linea_id = new.linea_id
  ) agg
  where cl.id = new.linea_id;
  return new;
end;
$$;


-- ═══════════════════════════════════════════════════════════════
-- 3. registrar_escaneos_batch: acepta es_suelto por item
-- ═══════════════════════════════════════════════════════════════
-- Idéntico a 20260806000002 salvo por v_es_suelto: misma idempotencia por
-- client_uuid, mismos chequeos de rol / empresa / sucursal / conteo
-- abierto, misma normalización server-side del código (nunca se confía en
-- codigo_norm/lote/vencimiento del cliente), mismo manejo de
-- no_encontrados.
--
-- coalesce a false: un cliente viejo (o una cola Dexie encolada antes de
-- desplegar esta versión) no manda el campo y tiene que seguir contando
-- envases, que es lo que siempre hizo.
create or replace function registrar_escaneos_batch(p_conteo uuid, p_escaneos jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conteo record;
  v_item jsonb;
  v_codigo_raw text;
  v_client_uuid uuid;
  v_dispositivo text;
  v_delta integer;
  v_es_suelto boolean;
  v_norm record;
  v_producto_id uuid;
  v_linea_id uuid;
  v_procesados integer := 0;
  v_duplicados integer := 0;
  v_no_encontrados jsonb := '[]'::jsonb;
begin
  if public.mi_rol() is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo;
  if not found then
    raise exception 'Conteo % no existe', p_conteo;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  if public.mi_rol() <> 'superadmin' and not public.tengo_acceso_sucursal(v_conteo.sucursal_id) then
    raise exception 'No autorizado para esa sucursal';
  end if;

  if v_conteo.estado <> 'abierto' then
    raise exception 'El conteo % ya está cerrado', p_conteo;
  end if;

  for v_item in select * from jsonb_array_elements(p_escaneos)
  loop
    v_codigo_raw := v_item ->> 'codigo_raw';
    begin
      v_client_uuid := (v_item ->> 'client_uuid')::uuid;
    exception when others then
      v_client_uuid := null;
    end;
    v_dispositivo := v_item ->> 'dispositivo';
    v_delta := coalesce((v_item ->> 'delta')::integer, 1);
    v_es_suelto := coalesce((v_item ->> 'es_suelto')::boolean, false);

    if v_codigo_raw is null or v_client_uuid is null then
      continue;
    end if;

    if exists (select 1 from public.escaneos where client_uuid = v_client_uuid) then
      v_duplicados := v_duplicados + 1;
      continue;
    end if;

    select (public.normalizar_codigo(v_codigo_raw)).* into v_norm;

    select p.id into v_producto_id
    from public.productos p
    join public.codigos_barra cb on cb.producto_id = p.id
    where cb.codigo_norm = v_norm.codigo_norm
    limit 1;

    if v_producto_id is null then
      v_no_encontrados := v_no_encontrados || jsonb_build_object(
        'codigo_raw', v_codigo_raw, 'client_uuid', v_client_uuid
      );
      continue;
    end if;

    insert into public.conteo_lineas (conteo_id, producto_id)
    values (p_conteo, v_producto_id)
    on conflict (conteo_id, producto_id) where producto_id is not null
    do update set conteo_id = excluded.conteo_id
    returning id into v_linea_id;

    insert into public.escaneos (
      conteo_id, linea_id, codigo_raw, codigo_norm, delta, lote,
      vencimiento, usuario_id, dispositivo, client_uuid, es_suelto
    )
    values (
      p_conteo, v_linea_id, v_codigo_raw, v_norm.codigo_norm, v_delta,
      v_norm.lote, v_norm.vencimiento, auth.uid(), v_dispositivo, v_client_uuid,
      v_es_suelto
    )
    on conflict (client_uuid) do nothing;

    v_procesados := v_procesados + 1;
  end loop;

  return json_build_object(
    'procesados', v_procesados,
    'duplicados', v_duplicados,
    'no_encontrados', v_no_encontrados
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════
-- 4. stock_actual / stock_actual_lote: sumar las sueltas a la base
-- ═══════════════════════════════════════════════════════════════
-- Las dos funciones son la misma cuenta (una por producto, la otra en
-- lote) y desde 20260908000000 rige que si cambia una tiene que cambiar
-- la otra — por eso viajan juntas acá.
--
-- Lo ÚNICO que cambia es el término de la foto física. Todo lo demás
-- queda intacto: el DISTINCT ON que resuelve "último conteo cerrado por
-- (sucursal, bodega)", el ámbito con null como ámbito propio, el término
-- `posteriores` de movimientos_stock y su filtro por cerrado_at.
--
--     antes:  (Σ cantidad × contenido) + Σ delta
--     ahora:  (Σ cantidad × contenido) + Σ unidades_sueltas + Σ delta
--
-- CREATE OR REPLACE y no DROP + CREATE (que es lo que hizo
-- 20260910000000): ahí el tipo de retorno pasaba de integer a numeric y
-- Postgres no deja cambiarlo en un replace. Acá la firma y el retorno son
-- exactamente los mismos.
--
-- Sin grants nuevos: SECURITY INVOKER, la RLS de conteos/conteo_lineas
-- filtra igual que antes, y unidades_sueltas es una columna más de una
-- fila que quien llama ya podía leer entera.

create or replace function stock_actual(
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
      cl.cantidad,
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
           )
    -- + el picado, SIN multiplicar: unidades_sueltas ya está denominado
    -- en unidades individuales (son los comprimidos sueltos que contó el
    -- operario, no envases). Multiplicarlo por contenido los inflaría por
    -- el tamaño de la caja. El factor es exclusivo del término de arriba,
    -- que sí viene en envases. La suma va DESPUÉS del producto: la
    -- precedencia de * sobre + ya lo garantiza, pero es la diferencia
    -- entre un stock correcto y uno multiplicado de más.
         + coalesce(sum(unidades_sueltas), 0)::numeric as q
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


-- La versión batch de lo mismo (20260908000000): una fila por producto
-- pedido, incluidos los que no tienen ninguna historia (stock 0) y los
-- que no existen.
--
-- Acá el factor no puede ser un subselect escalar (hay muchos productos),
-- así que sale de un CTE `factor` con left join a productos: la fila
-- siempre existe porque arranca de `pedidos`, y un producto inexistente o
-- sin contenido cae en el mismo fallback a 1.
--
-- Ojo con multiplicar en el lugar correcto: el factor va sobre la base EN
-- ENVASES, NUNCA sobre el total ni sobre las sueltas.
-- `(envases × contenido) + sueltas + movimientos`, no
-- `(envases + sueltas + movimientos) × contenido` — las sueltas y los
-- movimientos ya están en unidades y volver a multiplicarlos los
-- inflaría por el tamaño del envase.
create or replace function stock_actual_lote(
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
      cl.cantidad,
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
  base as (
    -- `q` todavía en envases: la conversión se aplica abajo, en el select
    -- final, donde ya está a mano el factor de cada producto. `sueltas`
    -- viaja aparte justamente porque NO se convierte — ya son unidades
    -- individuales (picado).
    select
      a.producto_id,
      coalesce(sum(a.cantidad), 0)::numeric as q,
      coalesce(sum(a.unidades_sueltas), 0)::numeric as sueltas
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
      + coalesce(b.sueltas, 0)
      + coalesce(mov.q, 0))::numeric
  from pedidos ped
  left join factor f on f.producto_id = ped.producto_id
  left join base b on b.producto_id = ped.producto_id
  left join posteriores mov on mov.producto_id = ped.producto_id;
$$;


-- ═══════════════════════════════════════════════════════════════
-- 5. cerrar_conteo / `lotes`: NO se tocan, y por qué
-- ═══════════════════════════════════════════════════════════════
-- Se revisó la versión vigente (20260813000005, que reemplazó a la de
-- 20260813000000). Lo que hace con el conteo al cerrarlo es una sola
-- cosa: insertar en `lotes` una fila por (producto, lote, vencimiento)
-- agregando `sum(e.delta)` de los escaneos que tienen
-- `e.vencimiento is not null`.
--
-- `lotes` existe para el control de VENCIMIENTOS (20260812000003): cada
-- fila es "tanta cantidad de este producto vence tal día". Un picado no
-- tiene vencimiento propio en este flujo — son unidades flojas en un
-- cajón, y el operario las cuenta sin datar nada. Los eventos que genera
-- apps/conteo para un picado van con lote y vencimiento en null (no pasan
-- por normalizar_codigo con un GS1 datado), así que el filtro
-- `e.vencimiento is not null` que ya está ahí los excluye SOLO: no hay
-- que agregar ninguna condición nueva ni hay riesgo de que se cuelen como
-- envases dentro de un lote.
--
-- Conclusión: unidades_sueltas es un concepto de conteo_lineas +
-- stock_actual, y `lotes` queda exactamente como está. Si algún día el
-- picado necesitara vencimiento propio, el lugar correcto sería una
-- columna de unidades sueltas en `lotes` y su propia decisión, no un
-- parche acá.
