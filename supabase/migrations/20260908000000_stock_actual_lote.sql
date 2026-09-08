-- stock_actual, pero para muchos productos de una sola vez.
--
-- El agujero que tapa esta migración: GET /api/pdvlat/catalogo pagina de a
-- 1000 SKU y hasta ahora devolvía como "stock" la foto de `lotes` — o sea
-- lo que dijo el último conteo físico, SIN restarle las ventas que el POS
-- ya sincronizó por registrar_venta. Eso es exactamente lo que
-- stock_actual (20260901000000) vino a resolver, solo que de a un producto
-- por llamada: usarla desde el catálogo sería un N+1 de cientos de
-- round-trips secuenciales por página. Esta versión recibe el arreglo
-- entero y resuelve todo en una consulta.
--
-- La semántica es la MISMA que stock_actual, sin excepciones — el criterio
-- completo (por qué la base es conteo_lineas y no lotes, por qué el
-- "último conteo cerrado" se resuelve por producto, por qué el ámbito es
-- (sucursal, bodega) con null como su propio ámbito, y por qué un ámbito
-- sin conteo aporta base 0 y todos sus movimientos) está documentado en
-- 20260901000000 y no se repite acá. Si alguna vez cambia uno de los dos,
-- tienen que cambiar los dos.
--
-- ⚠ ENMIENDA: esta versión quedó reemplazada por
-- 20260910000000_stock_en_unidades_individuales.sql (junto con
-- stock_actual, en la misma migración, para que no se separen): devuelve
-- `stock numeric` y multiplica la base del conteo por productos.contenido
-- para pasarla de envases a unidades individuales. El criterio de
-- agregación de abajo no cambió.
--
-- Lo único que cambia respecto de aquella es que producto_id deja de ser
-- una constante y pasa a ser una columna más: entra al `distinct on` como
-- primera clave (una foto por producto y por ámbito, no una sola por
-- ámbito) y al join de los movimientos posteriores, para que un producto
-- no recorte sus movimientos contra la fecha de cierre de otro.
--
-- Devuelve UNA fila por producto pedido, incluidos los que no tienen
-- ningún conteo ni movimiento (stock 0) y los que no existen: así el
-- llamador puede mapear por producto_id sin tratar el "no vino" como un
-- caso aparte. Los uuid repetidos en el arreglo se colapsan a una fila.
--
-- SECURITY INVOKER por el mismo motivo que stock_actual: la RLS de
-- conteos/conteo_lineas/movimientos_stock filtra sola. Un usuario ve el
-- stock de las sucursales a las que tiene acceso; service_role (la
-- integración de pdvlat, que es quien la llama desde el catálogo) ignora
-- RLS y ve todo. Sin grants explícitos, igual que stock_actual: no
-- devuelve nada que la RLS del que llama no le deje ver igual.
create function stock_actual_lote(
  p_empresa_id uuid,
  p_producto_ids uuid[],
  p_sucursal_id uuid default null
)
returns table (producto_id uuid, stock integer)
language sql
stable
set search_path = ''
as $$
  with pedidos as (
    select distinct u.producto_id
    from unnest(coalesce(p_producto_ids, '{}'::uuid[])) as u(producto_id)
    where u.producto_id is not null
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
    select a.producto_id, coalesce(sum(a.cantidad), 0)::integer as q
    from ambito a
    group by a.producto_id
  ),
  posteriores as (
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
    (coalesce(b.q, 0) + coalesce(mov.q, 0))::integer
  from pedidos ped
  left join base b on b.producto_id = ped.producto_id
  left join posteriores mov on mov.producto_id = ped.producto_id;
$$;
