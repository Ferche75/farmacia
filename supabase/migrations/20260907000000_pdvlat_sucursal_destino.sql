-- Sucursal (y bodega) de destino de la integración con pdvlat.
--
-- El agujero que tapa esta migración: `integraciones_pdv`
-- (20260901000000) empareja una empresa de Farmacia con un tenant de
-- pdvlat, pero NUNCA dice a qué sucursal van las ventas de ese tenant.
-- registrar_venta sí exige p_sucursal_id, así que hasta hoy el uuid de la
-- sucursal tenía que viajar hardcodeado del lado de pdvlat: alguien lo
-- copiaba a mano de la base de Farmacia y lo pegaba en la configuración
-- del POS. Eso es exactamente el tipo de secreto-dictado-por-WhatsApp que
-- el flujo de código de invitación vino a eliminar, y además no hay nada
-- que valide que ese uuid sea de la empresa correcta hasta que la venta
-- ya falló.
--
-- La sucursal se elige ACÁ, en el panel, en el mismo momento en que el
-- admin genera el código de invitación — que es cuando la persona que
-- sabe la respuesta ("la caja nueva es la de la sucursal Centro") está
-- mirando la pantalla. pdvlat la recibe al canjear el código, junto con
-- las credenciales, y la reenvía en cada venta.
--
-- ÁMBITO v1, a propósito: 1 tenant de pdvlat = 1 sucursal de Farmacia.
-- Hoy en producción hay exactamente un tenant con una tienda, así que un
-- mapeo tienda(pdvlat) → sucursal(Farmacia) sería complejidad sin cliente
-- que la pida. Cuando aparezca un tenant con dos tiendas, la migración
-- natural que sigue es una tabla de mapeo por store_id; la columna que se
-- agrega acá pasaría a ser el default de ese mapeo. No se construye
-- todavía.


-- ═══════════════════════════════════════════════════════════════
-- 1. Columnas de destino
-- ═══════════════════════════════════════════════════════════════
-- sucursal_id queda NULLABLE aunque conceptualmente sea obligatoria: la
-- fila de la integración ya existe en producción y no hay ningún valor
-- razonable con el que rellenarla (elegir "la primera sucursal" sería
-- adivinar a dónde descontar stock). La obligatoriedad se aplica donde sí
-- se puede fallar de forma explicable: generar_codigo_invitacion_pdv la
-- exige, y vincular_integracion_pdv se niega a canjear un código de una
-- fila que no la tenga. Una fila vieja sin sucursal simplemente necesita
-- que el admin genere un código nuevo.
--
-- bodega_id nullable de verdad: la mayoría de las empresas no usa bodegas
-- y eso tiene que seguir funcionando igual (misma convención que
-- conteos.bodega_id en 20260813000000 y que registrar_venta, cuyo
-- p_bodega_id ya es `default null`). null = "toda la sucursal", no "dato
-- faltante".
--
-- on delete restrict, no cascade: borrar una sucursal que tiene un POS
-- vendiendo contra ella tiene que doler y no llevarse la integración
-- puesta en silencio. Mismo criterio que conteos/lotes.bodega_id.
alter table integraciones_pdv
  add column sucursal_id uuid references sucursales (id) on delete restrict,
  add column bodega_id uuid references bodegas (id) on delete restrict;


-- ═══════════════════════════════════════════════════════════════
-- 2. generar_codigo_invitacion_pdv: ahora elige el destino
-- ═══════════════════════════════════════════════════════════════
-- Se DROPEA y se recrea en vez de `create or replace`: p_sucursal_id es
-- obligatorio, y en Postgres un parámetro sin default no puede ir después
-- de uno con default, así que tiene que quedar primero — o sea que la
-- firma cambia de (uuid) a (uuid, uuid, uuid) y `create or replace`
-- crearía una SEGUNDA función sobrecargada en vez de reemplazar la
-- vieja. Dos sobrecargas donde una acepta un llamado sin sucursal es
-- justo el bug que esta migración viene a cerrar.
--
-- No lleva revoke/grant: igual que la versión anterior, es el único RPC
-- de la integración que se llama DESDE EL PANEL con sesión de usuario
-- (packages/db/src/rpc.ts → generarCodigoInvitacionPdv), y su control de
-- acceso es el chequeo de mi_rol() de adentro, no un grant. Los que sí
-- devuelven credenciales o tocan stock (vincular_integracion_pdv,
-- registrar_venta) siguen restringidos a service_role.
drop function generar_codigo_invitacion_pdv(uuid);

-- Crea la integración de la empresa si todavía no existe y le pone un
-- código de invitación nuevo (el anterior, si lo había, deja de servir),
-- apuntando a la sucursal/bodega que se eligió en el panel.
--
-- p_empresa_id null = mi propia empresa. Un no-superadmin solo puede
-- operar sobre la suya — mismo criterio que
-- actualizar_datos_contacto_empresa (20260813000001), que directamente ni
-- acepta el parámetro; acá se acepta porque el superadmin sí necesita
-- poder dar de alta la integración de un cliente.
--
-- NO rota api_key/api_secret: si la empresa ya tenía pdvlat andando y
-- alguien genera un código nuevo por error, la integración vigente sigue
-- funcionando. La rotación pasa al canjear el código (vincular).
--
-- Cambiar de sucursal SÍ actualiza la fila en el acto (el `do update` de
-- abajo), aunque el POS vinculado siga mandando la sucursal vieja hasta
-- que canjee el código nuevo: la fila es la intención declarada del
-- admin, y vincular_integracion_pdv es el momento en que esa intención
-- llega al POS. Guardarla recién al canjear obligaría a un estado
-- "pendiente" que nadie puede ver ni corregir.
create function generar_codigo_invitacion_pdv(
  p_sucursal_id uuid,
  p_bodega_id uuid default null,
  p_empresa_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_empresa_id uuid := coalesce(p_empresa_id, public.mi_empresa_id());
  v_sucursal record;
  v_bodega record;
  v_fila record;
begin
  if v_rol not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para configurar la integración con el punto de venta';
  end if;

  if v_rol <> 'superadmin' and v_empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para esa empresa';
  end if;

  if not exists (select 1 from public.empresas where id = v_empresa_id) then
    raise exception 'La empresa % no existe', v_empresa_id;
  end if;

  if p_sucursal_id is null then
    raise exception 'Elegí a qué sucursal descuenta stock el punto de venta';
  end if;

  -- Mismas validaciones que registrar_venta, y a propósito duplicadas en
  -- vez de "confiar en que después falle": el error tiene que salir acá,
  -- en la pantalla del admin que está eligiendo, y no tres días después
  -- en un POST de una venta real.
  select * into v_sucursal
  from public.sucursales
  where id = p_sucursal_id and empresa_id = v_empresa_id;

  if not found then
    raise exception 'La sucursal % no pertenece a esta empresa', p_sucursal_id;
  end if;

  if not v_sucursal.activo then
    raise exception 'La sucursal % está inactiva', p_sucursal_id;
  end if;

  if p_bodega_id is not null then
    select * into v_bodega
    from public.bodegas
    where id = p_bodega_id;

    if not found then
      raise exception 'La bodega % no existe', p_bodega_id;
    end if;

    if v_bodega.empresa_id <> v_empresa_id or v_bodega.sucursal_id <> p_sucursal_id then
      raise exception 'La bodega % no pertenece a esta sucursal/empresa', p_bodega_id;
    end if;

    if not v_bodega.activo then
      raise exception 'La bodega % está inactiva', p_bodega_id;
    end if;
  end if;

  insert into public.integraciones_pdv (
    empresa_id, api_key, api_secret, codigo_invitacion, codigo_expira_at,
    sucursal_id, bodega_id
  )
  values (
    v_empresa_id,
    'pdv_' || public.generar_secreto_pdv(),
    public.generar_secreto_pdv(),
    public.generar_codigo_invitacion_texto(),
    now() + interval '72 hours',
    p_sucursal_id,
    p_bodega_id
  )
  on conflict (empresa_id) do update set
    codigo_invitacion = public.generar_codigo_invitacion_texto(),
    codigo_expira_at = now() + interval '72 hours',
    activo = true,
    sucursal_id = p_sucursal_id,
    bodega_id = p_bodega_id
  returning * into v_fila;

  return json_build_object(
    'empresa_id', v_fila.empresa_id,
    'codigo_invitacion', v_fila.codigo_invitacion,
    'codigo_expira_at', v_fila.codigo_expira_at,
    'vinculado', v_fila.vinculado_at is not null,
    'tenant_id_pdvlat', v_fila.tenant_id_pdvlat,
    'sucursal_id', v_fila.sucursal_id,
    'bodega_id', v_fila.bodega_id
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════
-- 3. vincular_integracion_pdv: entrega el destino junto con las llaves
-- ═══════════════════════════════════════════════════════════════
-- `create or replace` acá sí: la firma no cambia, y así conserva el
-- revoke/grant a service_role que le puso 20260901000000 (Postgres
-- mantiene los privilegios en un replace, no en un drop+create).
--
-- Lo único que cambia es que el canje ahora también devuelve a dónde
-- descontar. pdvlat guarda sucursal_id/bodega_id igual que guarda
-- api_key/api_secret y los reenvía en cada POST /api/pdvlat/ventas — el
-- uuid nunca se dicta ni se copia a mano.
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

  -- Fila anterior a esta migración (o generada con la firma vieja del
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
    'sucursal_id', v_fila.sucursal_id,
    'bodega_id', v_fila.bodega_id,
    'vinculado_at', v_fila.vinculado_at
  );
end;
$$;
