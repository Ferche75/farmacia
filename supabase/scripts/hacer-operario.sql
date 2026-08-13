-- Sube/crea un usuario como operario (rol de conteo) en una sucursal
-- puntual. Un operario NECESITA estar en perfiles_sucursal para poder
-- hacer algo (tengo_acceso_sucursal lo exige) — completá empresa y
-- sucursal abajo.

do $$
declare
  v_perfil_id   uuid := 'de5a986a-92b6-4798-a3f4-4f55ad0a4f36'; -- id de auth.users
  v_nombre      text := 'Operario';                              -- TODO: nombre real
  v_empresa     text := 'Farmacia San Francisco de Asís';        -- TODO: ajustar si es otra
  v_sucursal    text := 'Casa matriz';                           -- TODO: ajustar si es otra
  v_empresa_id  uuid;
  v_sucursal_id uuid;
begin
  select id into v_empresa_id from empresas where nombre = v_empresa;
  if v_empresa_id is null then
    raise exception 'No existe la empresa "%"', v_empresa;
  end if;

  select id into v_sucursal_id from sucursales where empresa_id = v_empresa_id and nombre = v_sucursal;
  if v_sucursal_id is null then
    raise exception 'No existe la sucursal "%" en esa empresa', v_sucursal;
  end if;

  if exists (select 1 from perfiles where id = v_perfil_id) then
    update perfiles set rol = 'operario', empresa_id = v_empresa_id, activo = true where id = v_perfil_id;
  else
    insert into perfiles (id, nombre, empresa_id, rol, activo)
    values (v_perfil_id, v_nombre, v_empresa_id, 'operario', true);
  end if;

  insert into perfiles_sucursal (perfil_id, sucursal_id)
  values (v_perfil_id, v_sucursal_id)
  on conflict do nothing;
end $$;
