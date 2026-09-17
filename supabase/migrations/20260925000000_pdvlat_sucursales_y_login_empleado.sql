-- pdvlat: una vinculación que sirve para TODAS las sucursales, y login de
-- empleado con la cuenta de Farmacia.
--
-- Contexto de los dos pedidos del equipo de pdvlat:
--
-- 1) "Queremos unas credenciales que sirvan para todas las sucursales de
--    la empresa, no una por sucursal". La premisa era media falsa: la
--    UNIQUE de `integraciones_pdv` es sobre `empresa_id` solo
--    (20260901000000), así que ya hay exactamente UN par
--    api_key/api_secret POR EMPRESA, no uno por sucursal. Y ni
--    registrar_venta ni /api/pdvlat/catalogo validan el `sucursal_id` del
--    request contra `integraciones_pdv.sucursal_id`: lo validan contra la
--    EMPRESA (`where id = p_sucursal_id and empresa_id = p_empresa_id`).
--    O sea que con la credencial que ya tienen pueden vender contra
--    cualquier sucursal de la empresa, hoy, sin cambiar nada.
--    `integraciones_pdv.sucursal_id`/`bodega_id` son el DESTINO POR
--    DEFECTO que eligió el admin al generar el código (20260907000000),
--    no un límite.
--
--    Lo único que faltaba de verdad era el descubrimiento: pdvlat no
--    tenía forma de saber qué otras sucursales existen sin que alguien
--    le dictara los uuid por WhatsApp — exactamente lo que el flujo de
--    código de invitación vino a eliminar. Por eso NO se agrega un
--    endpoint nuevo `/vincular-empresa` paralelo: se le agrega la lista
--    de sucursales a la respuesta del canje que ya existe. `sucursal_id`
--    y `bodega_id` siguen ahí, con el mismo significado de siempre (el
--    default), así que la versión de pdvlat que hoy está en producción
--    no se entera del cambio.
--
-- 2) "Queremos que el cajero entre con su cuenta de Farmacia". Eso no
--    necesita SQL: lo resuelve POST /api/pdvlat/auth-empleado, que valida
--    email/password contra GoTrue con la anon key y después lee
--    `perfiles`/`perfiles_sucursal` con service_role desde el mismo route
--    handler — igual que /catalogo y /ventas, que ya consultan directo
--    sin un SECURITY DEFINER intermedio. No hace falta un RPC nuevo, y
--    envolverlo en uno solo agregaría una superficie ejecutable más a la
--    base sin ganar ninguna garantía (la transaccionalidad, que es lo que
--    justifica registrar_venta, acá no aplica: son dos selects de
--    lectura).


-- ═══════════════════════════════════════════════════════════════
-- vincular_integracion_pdv: el canje ahora también lista las sucursales
-- ═══════════════════════════════════════════════════════════════
-- `create or replace` y misma firma (text, text) a propósito: así
-- conserva el revoke/grant a service_role que le puso 20260901000000
-- (Postgres mantiene los privilegios en un replace, no en un
-- drop+create). Es el mismo motivo por el que 20260907000000 —la versión
-- viva que este bloque reemplaza— usó replace en vez de recrearla.
--
-- Lo ÚNICO que cambia respecto de esa versión es la clave `sucursales`
-- del json de salida. Las validaciones, la rotación de credenciales al
-- canjear y los mensajes de error quedan idénticos.
--
-- Alcance de `sucursales`: solo las ACTIVAS de la empresa, ordenadas por
-- nombre (que es como las va a mostrar el POS en su selector). Una
-- sucursal inactiva no debería aparecer como opción de venta.
--
-- Sin bodega_id por item: una sucursal puede tener MUCHAS bodegas, así
-- que un campo 1:1 dentro de cada elemento del array mentiría sobre la
-- forma real del dato. La mayoría de las empresas además no usa bodegas.
-- La bodega sigue siendo el único campo de arriba (el default), y si
-- alguna vez hace falta elegirla por sucursal eso es una lista aparte,
-- no un campo escalar acá.
create or replace function vincular_integracion_pdv(p_codigo text, p_tenant_id text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := upper(regexp_replace(coalesce(p_codigo, ''), '[^0-9A-Fa-f]', '', 'g'));
  v_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  v_fila record;
  v_empresa record;
begin
  if v_codigo = '' then
    raise exception 'Falta el código de vinculación';
  end if;

  if v_tenant is null then
    raise exception 'Falta el identificador del tenant de pdvlat';
  end if;

  select * into v_fila
  from public.integraciones_pdv
  where codigo_invitacion = v_codigo
    and activo
    and codigo_expira_at > now()
  for update;

  if not found then
    raise exception 'Código de vinculación inválido o vencido';
  end if;

  -- Fila anterior a 20260907000000 (o generada con la firma vieja del
  -- RPC): sin sucursal no hay a dónde descontar, y entregar credenciales
  -- igual dejaría al POS vendiendo contra un 400 por venta. Se corta acá,
  -- con un mensaje que dice qué hacer, y el código queda sin consumir
  -- para que el admin pueda regenerarlo sin quedar en un estado raro.
  if v_fila.sucursal_id is null then
    raise exception 'Esta integración no tiene sucursal de destino. Pedile al administrador que genere un código nuevo eligiendo la sucursal.';
  end if;

  update public.integraciones_pdv
  set tenant_id_pdvlat = v_tenant,
      vinculado_at = now(),
      codigo_invitacion = null,
      codigo_expira_at = null,
      api_key = 'pdv_' || public.generar_secreto_pdv(),
      api_secret = public.generar_secreto_pdv()
  where id = v_fila.id
  returning * into v_fila;

  select * into v_empresa from public.empresas where id = v_fila.empresa_id;

  return json_build_object(
    'empresa_id', v_fila.empresa_id,
    'empresa_nombre', v_empresa.nombre,
    'tenant_id_pdvlat', v_fila.tenant_id_pdvlat,
    'api_key', v_fila.api_key,
    'api_secret', v_fila.api_secret,
    -- Sucursal/bodega POR DEFECTO, sin cambios: es la que eligió el admin
    -- al generar el código. pdvlat la usa cuando el cajero no elige otra.
    'sucursal_id', v_fila.sucursal_id,
    'bodega_id', v_fila.bodega_id,
    'vinculado_at', v_fila.vinculado_at,
    -- Todas las sucursales activas contra las que esta MISMA credencial
    -- puede operar. `coalesce` a '[]' y no null: una empresa sin
    -- sucursales activas es un array vacío, no "el campo no vino" — del
    -- lado del POS un null obligaría a distinguir dos casos que
    -- significan lo mismo.
    'sucursales', coalesce(
      (
        select json_agg(
                 json_build_object('sucursal_id', s.id, 'nombre', s.nombre)
                 order by s.nombre
               )
        from public.sucursales s
        where s.empresa_id = v_fila.empresa_id
          and s.activo
      ),
      '[]'::json
    )
  );
end;
$$;
