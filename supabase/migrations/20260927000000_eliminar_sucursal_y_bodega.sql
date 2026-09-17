-- Eliminar (borrado físico) de sucursales y bodegas desde el panel.
--
-- ESTO REVIERTE UNA DECISIÓN EXPLÍCITA. Hasta acá el criterio escrito en
-- tres lugares (20260806000009_superadmin_rls.sql, 20260812000002_bodegas.sql
-- y el comentario de apps/admin/.../configuracion/sucursales-bodegas.tsx)
-- era "soft-delete vía `activo`, borrado físico nunca". El motivo de fondo
-- sigue siendo cierto y sigue siendo el que manda: sucursales tiene FKs
-- colgando con ON DELETE CASCADE sobre tablas que SON historia real
-- (movimientos_stock, lotes), así que un `delete from sucursales` a secas
-- borra auditoría en silencio, sin que Postgres avise nada.
--
-- Lo que cambia es CÓMO se resuelve eso: en vez de "no existe el botón",
-- ahora existe el botón pero el borrado pasa por estos dos RPC, que
-- chequean historia ANTES de borrar y se niegan con un mensaje claro si
-- hay algo que perder. Sigue sin haber policy de DELETE en RLS para
-- ninguna de las dos tablas — el único camino es este, SECURITY DEFINER
-- con el chequeo de rol adentro (mismo patrón que ajustar_stock /
-- generar_codigo_invitacion_pdv).
--
-- Mapa de FKs, que es lo que justifica que las dos funciones NO sean
-- simétricas (verificado sobre todas las migraciones):
--
--   → sucursales(id)
--     perfiles_sucursal.sucursal_id   cascade   (asignación operario↔sucursal, inocuo)
--     productos_sucursales.sucursal_id cascade  (config "se vende acá", inocuo)
--     bodegas.sucursal_id             cascade   (ver abajo)
--     importaciones.sucursal_id       set null  (pierde una referencia vieja, inocuo)
--     conteos.sucursal_id             restrict  (Postgres ya lo frena solo)
--     integraciones_pdv.sucursal_id   restrict  (Postgres ya lo frena solo)
--     movimientos_stock.sucursal_id   CASCADE   ⚠ historia real, NADIE la protege
--     lotes.sucursal_id               CASCADE   ⚠ historia real, NADIE la protege
--
--   → bodegas(id)
--     conteos.bodega_id, lotes.bodega_id, movimientos_stock.bodega_id,
--     integraciones_pdv.bodega_id     todos restrict
--     (y nada cuelga de bodegas con cascade)
--
-- O sea: para BODEGAS las FKs de Postgres ya alcanzan como protección; el
-- RPC existe para no escupirle al admin un error crudo 23503. Para
-- SUCURSALES no alcanzan ni de cerca, y los chequeos explícitos de abajo
-- son la única barrera real que hay entre un click y perder movimientos
-- de stock.


-- ═══════════════════════════════════════════════════════════════
-- eliminar_sucursal
-- ═══════════════════════════════════════════════════════════════
-- Auth: admin/gerente/superadmin + la sucursal tiene que ser de la propia
-- empresa, mismo alcance que la policy sucursales_update_propia_empresa
-- (20260813000002). No recibe empresa_id por parámetro a propósito: se
-- deriva de la fila, así que no hay nada que falsificar desde el cliente.
--
-- El chequeo de bodegas (segundo bloque) no es paranoia: como
-- bodegas.sucursal_id es ON DELETE CASCADE, borrar la sucursal intenta
-- borrar sus bodegas, y ESE borrado choca contra los restrict de
-- conteos/lotes/movimientos_stock/integraciones_pdv por bodega_id,
-- abortando toda la transacción con un error crudo de FK. Chequeamos
-- antes para poder decir cuál es el problema en castellano.
create function eliminar_sucursal(p_sucursal_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_sucursal record;
begin
  if v_rol not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para eliminar sucursales';
  end if;

  select * into v_sucursal
  from public.sucursales
  where id = p_sucursal_id;

  -- Un no-superadmin no puede distinguir "no existe" de "es de otra
  -- empresa": mismo mensaje para los dos casos, para no convertir esto en
  -- un oráculo de ids ajenos.
  if not found or (v_rol <> 'superadmin' and v_sucursal.empresa_id <> public.mi_empresa_id()) then
    raise exception 'La sucursal no existe o no pertenece a esta empresa';
  end if;

  -- ── Historia propia de la sucursal ──────────────────────────
  -- conteos e integraciones_pdv ya son restrict (Postgres los frenaría),
  -- pero se chequean igual: el objetivo acá es el mensaje, no el bloqueo.
  if exists (select 1 from public.conteos where sucursal_id = p_sucursal_id) then
    raise exception 'Esta sucursal ya tiene conteos registrados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (select 1 from public.movimientos_stock where sucursal_id = p_sucursal_id) then
    raise exception 'Esta sucursal ya tiene movimientos de stock registrados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (select 1 from public.lotes where sucursal_id = p_sucursal_id) then
    raise exception 'Esta sucursal ya tiene lotes/vencimientos cargados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (select 1 from public.integraciones_pdv where sucursal_id = p_sucursal_id) then
    raise exception 'Esta sucursal está conectada a una integración con pdvlat y no se puede eliminar. Desactivala en cambio.';
  end if;

  -- ── Historia de las bodegas que cuelgan de esta sucursal ─────
  -- Cuatro chequeos separados en vez de uno combinado: el admin necesita
  -- saber QUÉ hay para decidir qué hacer, y "una de las bodegas tiene
  -- algo" no le sirve para nada.
  if exists (
    select 1 from public.bodegas b
    join public.conteos c on c.bodega_id = b.id
    where b.sucursal_id = p_sucursal_id
  ) then
    raise exception 'Una de las bodegas de esta sucursal ya tiene conteos registrados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (
    select 1 from public.bodegas b
    join public.lotes l on l.bodega_id = b.id
    where b.sucursal_id = p_sucursal_id
  ) then
    raise exception 'Una de las bodegas de esta sucursal ya tiene lotes/vencimientos cargados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (
    select 1 from public.bodegas b
    join public.movimientos_stock m on m.bodega_id = b.id
    where b.sucursal_id = p_sucursal_id
  ) then
    raise exception 'Una de las bodegas de esta sucursal ya tiene movimientos de stock registrados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (
    select 1 from public.bodegas b
    join public.integraciones_pdv i on i.bodega_id = b.id
    where b.sucursal_id = p_sucursal_id
  ) then
    raise exception 'Una de las bodegas de esta sucursal está conectada a una integración con pdvlat y no se puede eliminar. Desactivala en cambio.';
  end if;

  -- Llegado acá lo único que cae por cascade es configuración, no
  -- historia: perfiles_sucursal (asignaciones), bodegas (ya confirmadas
  -- vacías arriba), productos_sucursales (disponibilidad) y el
  -- importaciones.sucursal_id que queda en null.
  delete from public.sucursales where id = p_sucursal_id;

  return json_build_object('sucursal_id', p_sucursal_id, 'eliminada', true);
end;
$$;

comment on function eliminar_sucursal(uuid) is
  'Borrado FÍSICO de una sucursal, solo si no tiene historia (conteos, '
  'movimientos de stock, lotes, integración pdvlat) ni la tienen sus '
  'bodegas. Si la tiene, falla con un mensaje que dice cuál y sugiere '
  'desactivar. admin/gerente/superadmin, acotado a la propia empresa.';


-- ═══════════════════════════════════════════════════════════════
-- eliminar_bodega
-- ═══════════════════════════════════════════════════════════════
-- Misma forma, más simple: acá las cuatro FKs son restrict, así que
-- Postgres solo ya impediría perder datos. Los chequeos explícitos están
-- para reemplazar el "violates foreign key constraint ... (SQLSTATE
-- 23503)" por una frase que se entienda, no para agregar seguridad.
create function eliminar_bodega(p_bodega_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_bodega record;
begin
  if v_rol not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para eliminar bodegas';
  end if;

  select * into v_bodega
  from public.bodegas
  where id = p_bodega_id;

  if not found or (v_rol <> 'superadmin' and v_bodega.empresa_id <> public.mi_empresa_id()) then
    raise exception 'La bodega no existe o no pertenece a esta empresa';
  end if;

  if exists (select 1 from public.conteos where bodega_id = p_bodega_id) then
    raise exception 'Esta bodega ya tiene conteos registrados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (select 1 from public.movimientos_stock where bodega_id = p_bodega_id) then
    raise exception 'Esta bodega ya tiene movimientos de stock registrados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (select 1 from public.lotes where bodega_id = p_bodega_id) then
    raise exception 'Esta bodega ya tiene lotes/vencimientos cargados y no se puede eliminar. Desactivala en cambio.';
  end if;

  if exists (select 1 from public.integraciones_pdv where bodega_id = p_bodega_id) then
    raise exception 'Esta bodega está conectada a una integración con pdvlat y no se puede eliminar. Desactivala en cambio.';
  end if;

  delete from public.bodegas where id = p_bodega_id;

  return json_build_object('bodega_id', p_bodega_id, 'eliminada', true);
end;
$$;

comment on function eliminar_bodega(uuid) is
  'Borrado FÍSICO de una bodega, solo si no tiene conteos, movimientos de '
  'stock, lotes ni integración pdvlat. admin/gerente/superadmin, acotado a '
  'la propia empresa.';


-- Sin revoke/grant, igual que ajustar_stock y generar_codigo_invitacion_pdv:
-- estos RPC los llama el panel CON sesión de usuario, y el control de
-- acceso es el mi_rol() + la validación de empresa de adentro, no un grant
-- de Postgres. Los que sí están restringidos a service_role
-- (registrar_venta, vincular_integracion_pdv) lo están porque los llama un
-- servidor externo sin sesión; no es el caso acá.
