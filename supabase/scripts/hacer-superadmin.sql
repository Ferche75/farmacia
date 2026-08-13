-- Sube un usuario a rol superadmin. Cubre los dos casos:
--   1) el UID ya tiene fila en `perfiles` (se le cambia el rol nomás).
--   2) el UID es un usuario de Authentication recién creado, sin perfil
--      todavía (se le crea uno). Un superadmin igual necesita
--      empresa_id (NOT NULL en el esquema) aunque no opere dentro de
--      una empresa en particular — se le asigna la primera que exista;
--      si no hay ninguna, la crea.
--
-- Editá v_nombre si vas por el camino 2 y querés otro nombre.

do $$
declare
  v_perfil_id  uuid := 'f8fdd767-36e8-4f00-9dc3-78d2c11bca45';
  v_nombre     text := 'Superadmin';
  v_empresa_id uuid;
begin
  if exists (select 1 from perfiles where id = v_perfil_id) then
    update perfiles
    set rol = 'superadmin', activo = true
    where id = v_perfil_id;

    raise notice 'Perfil % actualizado a superadmin.', v_perfil_id;
  else
    select id into v_empresa_id from empresas order by created_at limit 1;

    if v_empresa_id is null then
      insert into empresas (nombre, pais)
      values ('Plataforma', 'Bolivia')
      returning id into v_empresa_id;
    end if;

    insert into perfiles (id, nombre, empresa_id, rol, activo)
    values (v_perfil_id, v_nombre, v_empresa_id, 'superadmin', true);

    raise notice 'Perfil % creado como superadmin.', v_perfil_id;
  end if;
end $$;
