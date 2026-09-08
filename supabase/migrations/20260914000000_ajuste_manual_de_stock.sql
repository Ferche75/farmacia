-- Corrección manual de stock desde el panel (movimientos_stock.tipo =
-- 'ajuste').
--
-- El agujero que tapa esta migración: el stock permanente existe desde
-- 20260901000000, pero el ÚNICO camino de escritura era registrar_venta
-- (pdvlat). `tipo` siempre aceptó 'ingreso' y 'ajuste' en su check
-- (20260806000001) y nunca los escribió nadie. Resultado práctico: si se
-- rompió una caja, hubo un faltante, o el conteo físico se cargó mal, la
-- única forma de arreglar UN producto era rehacer un conteo entero — que
-- es exactamente la herramienta equivocada para el problema.
--
-- Lo que se agrega es a propósito lo más chico posible:
--   1. `motivo` en movimientos_stock — la corrección sin explicación es
--      justo el movimiento que alguien va a querer preguntar dentro de
--      tres meses.
--   2. `ajustar_stock(...)`: "el stock de este producto en esta sucursal
--      ahora es N, porque X". Recibe la cantidad FINAL, no un delta: es
--      lo que la persona tiene en la mano después de contar el estante.
--      El delta lo calcula la función contra stock_actual.
--
-- No toca registrar_venta, stock_actual ni stock_actual_lote.


-- ═══════════════════════════════════════════════════════════════
-- 1. movimientos_stock.motivo
-- ═══════════════════════════════════════════════════════════════
-- Nullable: las filas de 'venta' que escribe registrar_venta no tienen
-- motivo y nunca lo van a tener (el motivo de una venta es que se vendió).
-- La obligatoriedad se aplica donde importa y donde se puede explicar el
-- error: adentro de ajustar_stock.
--
-- NO se reusa `referencia` para esto aunque también sea text: referencia
-- es una llave de idempotencia (el número de orden de pdvlat, con su
-- índice ix_mov_stock_referencia y el `exists` que evita descontar dos
-- veces la misma orden). Meterle prosa libre rompería esa semántica.
alter table movimientos_stock
  add column motivo text;

comment on column movimientos_stock.motivo is
  'Por qué se hizo este movimiento, en palabras de quien lo hizo. Solo lo '
  'llenan los movimientos manuales (tipo ajuste/ingreso), donde es '
  'obligatorio — ver ajustar_stock. Las ventas de pdvlat lo dejan null: su '
  'trazabilidad es `referencia` (el número de orden del POS).';


-- ═══════════════════════════════════════════════════════════════
-- 2. ajustar_stock
-- ═══════════════════════════════════════════════════════════════
-- Ámbito: SUCURSAL, sin bodega. No es una simplificación temporaria — es
-- lo único verificable: stock_actual no tiene parámetro de bodega (agrega
-- todas las bodegas de la sucursal internamente), así que un ajuste por
-- bodega no podría releerse para confirmar que quedó como se pidió. Y la
-- mayoría de las empresas no usa bodegas (mismo criterio que
-- conteos.bodega_id y registrar_venta.p_bodega_id). La fila se inserta con
-- bodega_id null, que en la convención de stock_actual es su propio ámbito
-- "la sucursal entera".
--
-- UNIDADES: p_cantidad_nueva y el delta resultante van en UNIDADES
-- INDIVIDUALES, no en envases — la convención que fijó
-- 20260910000000_stock_en_unidades_individuales.sql para toda la columna
-- `delta`. 10 cajas de 30 comprimidos son 300, no 10. La UI del panel
-- muestra el stock leído con stock_actual (ya convertido a unidades) al
-- lado del input, así que la persona corrige contra el mismo número que
-- está viendo y no tiene que hacer la cuenta.
--
-- SECURITY DEFINER como el resto de los RPC que escriben, con el chequeo
-- de rol adentro. Sin revoke/grant, igual que
-- generar_codigo_invitacion_pdv (20260907000000): este también se llama
-- DESDE EL PANEL con sesión de usuario, y su control de acceso es el
-- mi_rol() + la validación de empresa de abajo, no un grant. Los que sí
-- están restringidos a service_role (registrar_venta,
-- vincular_integracion_pdv) lo están porque los llama un servidor externo
-- sin sesión; no es el caso acá.
--
-- Rol admin/gerente/superadmin, mismo nivel que costo/precio (CONTEXTO.md
-- regla 3) y mismo gate que ya tiene la pantalla de productos
-- (requirePerfilAdmin). Un operario no corrige stock.
create function ajustar_stock(
  p_empresa_id uuid,
  p_sucursal_id uuid,
  p_producto_id uuid,
  p_cantidad_nueva integer,
  p_motivo text
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_motivo text := nullif(trim(coalesce(p_motivo, '')), '');
  v_sucursal record;
  v_stock_anterior numeric;
  v_delta integer;
begin
  if v_rol not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para corregir stock';
  end if;

  -- Misma defensa que generar_codigo_invitacion_pdv: la función es
  -- SECURITY DEFINER y recibe empresa_id como parámetro, así que sin este
  -- chequeo cualquier admin logueado podría tocar el stock de OTRA empresa
  -- pasándole su uuid.
  if v_rol <> 'superadmin' and p_empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para esa empresa';
  end if;

  -- Sin motivo no hay ajuste: una corrección de stock anónima es
  -- indistinguible de un error, y la pregunta "¿por qué este producto pasó
  -- de 40 a 12?" se hace siempre después, cuando ya nadie se acuerda.
  if v_motivo is null then
    raise exception 'Escribí por qué se corrige el stock (ej: "se rompió una caja", "faltante", "el conteo se cargó mal")';
  end if;

  if p_cantidad_nueva is null or p_cantidad_nueva < 0 then
    raise exception 'La cantidad nueva tiene que ser un número mayor o igual a cero, no %', p_cantidad_nueva;
  end if;

  -- Misma validación que registrar_venta, palabra por palabra.
  select * into v_sucursal
  from public.sucursales
  where id = p_sucursal_id and empresa_id = p_empresa_id;

  if not found then
    raise exception 'La sucursal % no pertenece a esta empresa', p_sucursal_id;
  end if;

  if not v_sucursal.activo then
    raise exception 'La sucursal % está inactiva', p_sucursal_id;
  end if;

  -- `productos` es el catálogo GLOBAL (sin empresa_id propio): alcanza con
  -- que exista, igual que en registrar_venta. La pertenencia a la empresa
  -- la lleva productos_empresa, que acá no hace falta — un producto se
  -- puede haber contado en la sucursal sin tener nunca una fila de
  -- costo/precio cargada.
  if not exists (select 1 from public.productos where id = p_producto_id) then
    raise exception 'El producto % no existe en el catálogo', p_producto_id;
  end if;

  v_stock_anterior := public.stock_actual(p_empresa_id, p_producto_id, p_sucursal_id);

  -- El delta es la diferencia contra lo que el sistema cree hoy, no la
  -- cantidad nueva: así el ajuste convive con la foto del último conteo
  -- cerrado y con las ventas posteriores sin pisarlas.
  --
  -- round(): stock_actual devuelve numeric y puede tener decimales (un
  -- productos.contenido fraccionario, p. ej. 2.5), pero delta es integer.
  -- Se redondea explícitamente en vez de dejar que lo haga el cast
  -- implícito del insert, y por eso el stock_nuevo que se devuelve se
  -- calcula como anterior + delta REAL y no como p_cantidad_nueva: en ese
  -- caso de borde el resultado puede quedar a menos de una unidad de lo
  -- pedido, y es preferible decirlo a mentir.
  v_delta := round(p_cantidad_nueva - v_stock_anterior)::integer;

  insert into public.movimientos_stock (
    empresa_id, sucursal_id, bodega_id, producto_id, tipo, delta,
    referencia, motivo, usuario_id
  )
  values (
    p_empresa_id, p_sucursal_id, null, p_producto_id, 'ajuste', v_delta,
    null, v_motivo, auth.uid()
  );

  return json_build_object(
    'stock_anterior', v_stock_anterior,
    'stock_nuevo', v_stock_anterior + v_delta,
    'delta', v_delta
  );
end;
$$;

-- A diferencia de las ventas de pdvlat (usuario_id null a propósito, ver
-- 20260901000000), acá SÍ hay una persona logueada del otro lado y queda
-- registrada: quién, cuándo (created_at) y por qué (motivo).
comment on function ajustar_stock(uuid, uuid, uuid, integer, text) is
  'Corrección manual de stock desde el panel: fija la cantidad FINAL de un '
  'producto en una sucursal y registra la diferencia como un movimiento '
  'tipo ajuste, con motivo obligatorio y usuario_id = auth.uid(). '
  'p_cantidad_nueva en UNIDADES INDIVIDUALES, igual que movimientos_stock.delta '
  '(20260910000000_stock_en_unidades_individuales.sql). Ámbito sucursal, '
  'sin bodega. Solo admin/gerente/superadmin.';
