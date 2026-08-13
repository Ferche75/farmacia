-- Autoservicio de datos de contacto para el perfil de tienda (admin/
-- gerente). Hasta acá `empresas_update` (20260806000009_superadmin_rls.sql)
-- estaba acotada a superadmin — cualquier corrección de teléfono/
-- dirección de una empresa real (ej. Farmacia San Francisco de Asís)
-- dependía de que el superadmin la hiciera a mano en su panel. `nav-
-- admin.tsx` tampoco tiene ningún link de configuración para esos roles
-- — hoy el perfil de tienda no tiene dónde ver/tocar ni el nombre de su
-- propia empresa.
--
-- A propósito NO se resuelve con una policy de RLS de UPDATE en
-- `empresas`: RLS filtra FILAS, no columnas. Una policy
-- `using (id = mi_empresa_id() and mi_rol() in ('admin','gerente'))`
-- dejaría a cualquier gerente (con su propio cliente ya autenticado,
-- devtools en mano) mandar un `.update({activo: false})` o
-- `.update({config: {...}})` sobre su propia fila y tirar abajo el
-- tenant o pisar `n8n_webhook_secret`. En cambio, un RPC SECURITY
-- DEFINER con un parámetro por campo editable: la única superficie de
-- escritura es la que el código de la función expone, nit/pais/config/
-- activo ni siquiera existen como argumento posible. Mismo criterio que
-- ya usa el proyecto para operaciones sensibles acotadas
-- (actualizar_usuario_superadmin, buscar_producto).
--
-- Opera siempre sobre mi_empresa_id() — nunca un empresa_id que mande el
-- cliente — así que ni hace falta pasarlo como parámetro: cierra sola la
-- posibilidad de tocar otra empresa.

create function actualizar_datos_contacto_empresa(
  p_nombre text,
  p_telefono text,
  p_email text,
  p_direccion text,
  p_ciudad text,
  p_contacto_emergencia_nombre text,
  p_contacto_emergencia_telefono text
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_empresa_id uuid := public.mi_empresa_id();
begin
  if public.mi_rol() not in ('admin', 'gerente') then
    raise exception 'No autorizado para editar los datos de la empresa';
  end if;

  if p_nombre is null or trim(p_nombre) = '' then
    raise exception 'El nombre no puede quedar vacío';
  end if;

  update public.empresas
  set nombre = trim(p_nombre),
      telefono = p_telefono,
      email = p_email,
      direccion = p_direccion,
      ciudad = p_ciudad,
      contacto_emergencia_nombre = p_contacto_emergencia_nombre,
      contacto_emergencia_telefono = p_contacto_emergencia_telefono
  where id = v_empresa_id;

  return json_build_object('empresa_id', v_empresa_id);
end;
$$;
