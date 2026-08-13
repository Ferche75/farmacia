-- El operario que hace el conteo en el piso ahora puede cerrarlo él
-- mismo desde apps/conteo — a pedido explícito del usuario, hasta acá
-- cerrar_conteo (Fase 6) era exclusivo de admin/gerente/superadmin.
--
-- CREATE OR REPLACE: mismo cuerpo que 20260813000000_bodega_en_conteo.sql
-- (que ya lo había reemplazado para propagar bodega_id a `lotes`), suma
-- 'operario' a los roles permitidos + un chequeo de sucursal que antes
-- no hacía falta (admin/gerente/superadmin ya tienen acceso a cualquier
-- sucursal de su empresa, per tengo_acceso_sucursal() — un operario NO,
-- solo a las que tiene asignadas en perfiles_sucursal). Mismo criterio
-- que ya usa registrar_escaneos_batch para esta misma distinción.
create or replace function cerrar_conteo(p_conteo_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conteo record;
  v_desconocidos_pendientes integer;
begin
  if public.mi_rol() not in ('operario', 'admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para cerrar conteos';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo_id;
  if not found then
    raise exception 'Conteo % no existe', p_conteo_id;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  if public.mi_rol() <> 'superadmin' and not public.tengo_acceso_sucursal(v_conteo.sucursal_id) then
    raise exception 'No autorizado para esa sucursal';
  end if;

  if v_conteo.estado = 'cerrado' then
    raise exception 'El conteo ya está cerrado';
  end if;

  select count(*) into v_desconocidos_pendientes
  from public.conteo_lineas
  where conteo_id = p_conteo_id and desconocido_id is not null;

  update public.conteos
  set estado = 'cerrado', cerrado_at = now(), cerrado_por = auth.uid()
  where id = p_conteo_id;

  insert into public.lotes (
    empresa_id, sucursal_id, bodega_id, producto_id, lote, vencimiento, cantidad,
    actualizado_en_conteo_id, updated_at
  )
  select
    v_conteo.empresa_id, v_conteo.sucursal_id, v_conteo.bodega_id, cl.producto_id, e.lote, e.vencimiento,
    sum(e.delta), p_conteo_id, now()
  from public.escaneos e
  join public.conteo_lineas cl on cl.id = e.linea_id
  where e.conteo_id = p_conteo_id
    and e.vencimiento is not null
    and cl.producto_id is not null
  group by cl.producto_id, e.lote, e.vencimiento
  on conflict (empresa_id, sucursal_id, (coalesce(bodega_id::text, '')), producto_id, (coalesce(lote, '')), vencimiento)
  do update set
    cantidad = excluded.cantidad,
    actualizado_en_conteo_id = excluded.actualizado_en_conteo_id,
    updated_at = now();

  return json_build_object(
    'id', p_conteo_id,
    'desconocidos_pendientes', v_desconocidos_pendientes
  );
end;
$$;
