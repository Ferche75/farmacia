-- El paso 1 del importador pedía "Laboratorio" como campo obligatorio
-- que bloqueaba elegir el archivo — a pedido explícito del usuario, deja
-- de ser obligatorio (el archivo real ya suele traer el laboratorio por
-- fila, ver 20260812000001) y en su lugar se pide la SUCURSAL para la
-- que es ese archivo.
--
-- Importante: esto es SOLO una etiqueta de registro sobre la corrida de
-- importación (`importaciones.sucursal_id`), no cambia dónde vive el
-- precio. `productos_empresa` (costo/precio) sigue siendo por empresa
-- entera — decisión confirmada explícitamente con el usuario ahora
-- (2026-08-13): el precio no varía entre sucursales de una misma
-- empresa. Si eso cambia el día de mañana, esto no alcanza — hace falta
-- una migración mucho más grande (sucursal_id en productos_empresa +
-- RLS + buscar_producto + reportes), documentada pero no construida.

alter table importaciones
  add column sucursal_id uuid references sucursales (id) on delete set null;

-- CREATE OR REPLACE: mismo cuerpo que 20260806000004_funciones_importacion.sql,
-- suma p_sucursal_id (opcional, default null por compatibilidad hacia
-- atrás) y lo valida contra la propia empresa antes de guardarlo — mismo
-- criterio que el resto del esquema (nunca confiar en un id que manda el
-- cliente sin chequear que sea de la empresa que corresponde).
create or replace function iniciar_importacion(
  p_archivo text,
  p_mapeo jsonb,
  p_sucursal_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_empresa_id uuid := public.mi_empresa_id();
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para importar catálogo';
  end if;

  if p_sucursal_id is not null
     and not exists (select 1 from public.sucursales where id = p_sucursal_id and empresa_id = v_empresa_id)
  then
    raise exception 'La sucursal % no pertenece a esta empresa', p_sucursal_id;
  end if;

  insert into public.importaciones (empresa_id, sucursal_id, archivo, mapeo, estado, creado_por)
  values (v_empresa_id, p_sucursal_id, p_archivo, p_mapeo, 'procesando', auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
