-- Alta de la primera empresa real: Farmacia San Francisco de Asís.
-- Mismo patrón que bootstrap-usuario-inicial.sql, pero con datos reales
-- y un rol de tienda (no superadmin).
--
-- Antes de correr:
--   1) Crear el usuario en Authentication → Add user (con "Auto Confirm
--      User" tildado) si todavía no existe, o confirmar que el UID de
--      abajo es el de ESE usuario (Authentication → Users → columna UID).
--   2) Completar nit / teléfono / email / dirección / ciudad y el
--      nombre de la persona (están en null/placeholder abajo).
--   3) Revisar el rol: 'gerente' es el rol de tienda más alto (no es
--      superadmin) — da acceso a todas las sucursales de la empresa.
--      Si esta persona debe quedar limitada a una sola sucursal, usar
--      'operario' en vez de 'gerente' (el insert en perfiles_sucursal
--      de abajo ya deja armada esa asignación).

do $$
declare
  v_perfil_id   uuid := 'c0c3c056-d928-44fb-a224-ce58075dc5ef'; -- id de auth.users
  v_nombre      text := 'Nombre Apellido'; -- TODO: nombre de la persona
  v_empresa     text := 'Farmacia San Francisco de Asís';
  v_nit         text := null; -- TODO
  v_telefono    text := null; -- TODO
  v_email       text := null; -- TODO
  v_direccion   text := null; -- TODO
  v_ciudad      text := null; -- TODO
  v_sucursal    text := 'Casa matriz';
  v_rol         text := 'gerente'; -- superadmin | gerente | admin | operario
  v_empresa_id  uuid;
  v_sucursal_id uuid;
begin
  insert into empresas (nombre, nit, pais, telefono, email, direccion, ciudad)
  values (v_empresa, v_nit, 'Bolivia', v_telefono, v_email, v_direccion, v_ciudad)
  returning id into v_empresa_id;

  insert into sucursales (empresa_id, nombre)
  values (v_empresa_id, v_sucursal)
  returning id into v_sucursal_id;

  insert into perfiles (id, nombre, empresa_id, rol, activo)
  values (v_perfil_id, v_nombre, v_empresa_id, v_rol, true);

  insert into perfiles_sucursal (perfil_id, sucursal_id)
  values (v_perfil_id, v_sucursal_id);
end $$;
