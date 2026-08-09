-- Bootstrap del primer usuario de prueba. Se corre a mano, una sola vez,
-- después de la migración de Fase 0 y de crear el usuario en
-- Authentication → Add user (con "Auto Confirm User" tildado).
-- El UUID de abajo tiene que ser el id de ESE usuario (Authentication →
-- Users → columna UID).
--
-- Editá nombre / empresa / sucursal / rol antes de correrlo si no
-- coinciden con lo que necesitás.

do $$
declare
  v_perfil_id uuid := '1ae7ab50-52c8-42cd-8e74-48aa7fef5b74'; -- id de auth.users
  v_nombre    text := 'Fernando';
  v_empresa   text := 'Empresa de prueba';
  v_sucursal  text := 'Casa matriz';
  v_rol       text := 'superadmin'; -- superadmin | gerente | admin | operario
  v_empresa_id uuid;
  v_sucursal_id uuid;
begin
  insert into empresas (nombre, pais)
  values (v_empresa, 'Bolivia')
  returning id into v_empresa_id;

  insert into sucursales (empresa_id, nombre)
  values (v_empresa_id, v_sucursal)
  returning id into v_sucursal_id;

  insert into perfiles (id, nombre, empresa_id, rol, activo)
  values (v_perfil_id, v_nombre, v_empresa_id, v_rol, true);

  insert into perfiles_sucursal (perfil_id, sucursal_id)
  values (v_perfil_id, v_sucursal_id);
end $$;
