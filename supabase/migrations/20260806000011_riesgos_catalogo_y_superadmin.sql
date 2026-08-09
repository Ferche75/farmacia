-- Cierra 2 riesgos documentados en docs/decisiones.md que quedaron
-- aceptados-pero-no-arreglados en fases anteriores.

-- ═══════════════════════════════════════════════════════════════
-- 1) TRAZABILIDAD DEL CATÁLOGO GLOBAL (riesgo de Fase 2)
-- ═══════════════════════════════════════════════════════════════
-- El catálogo es global y compartido entre empresas a propósito (decisión
-- #2 del spec) — eso significa que CUALQUIER admin/gerente de CUALQUIER
-- empresa puede editar un producto que usan todas las demás. No se le
-- saca ese permiso (bloquearía colaboración legítima entre farmacias
-- corrigiendo el mismo catálogo), pero ahora queda quién hizo cada alta y
-- cada edición — la mitigación mínima que "acota el daño posible" sin
-- inventar un flujo de aprobación completo que nadie pidió todavía. Si
-- el catálogo compartido se vuelve un problema real, este campo es lo
-- que permite ver quién rompió qué antes de decidir si hace falta más.

alter table productos
  add column creado_por uuid references perfiles (id) on delete set null,
  add column actualizado_por uuid references perfiles (id) on delete set null;

create function productos_set_autor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.creado_por = auth.uid();
  end if;
  new.actualizado_por = auth.uid();
  return new;
end;
$$;

create trigger productos_set_autor
  before insert or update on productos
  for each row
  execute function productos_set_autor();

-- ═══════════════════════════════════════════════════════════════
-- 2) ALTA/BAJA DE SUCURSALES DE UN OPERARIO, ATÓMICA (límite de Fase 7)
-- ═══════════════════════════════════════════════════════════════
-- Antes: el panel de superadmin hacía UPDATE perfiles + DELETE
-- perfiles_sucursal + INSERT perfiles_sucursal como 3 llamadas sueltas
-- desde el cliente — si el proceso se caía entre el DELETE y el INSERT,
-- un operario podía quedar sin ninguna sucursal asignada. Envolver las 3
-- en una sola función significa una sola transacción: o se aplican todos
-- los cambios, o ninguno. De paso resuelve el otro límite documentado:
-- si el rol deja de ser 'operario', las asignaciones de sucursal viejas
-- se limpian solas en vez de quedar colgadas (mudas mientras tanto por
-- tengo_acceso_sucursal(), pero listas para confundir si más adelante
-- alguien vuelve a bajar a esa persona a operario).

create function actualizar_usuario_superadmin(
  p_perfil_id uuid,
  p_nombre text default null,
  p_rol text default null,
  p_activo boolean default null,
  p_sucursal_ids uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.mi_rol() <> 'superadmin' then
    raise exception 'Solo superadmin puede modificar usuarios';
  end if;

  update public.perfiles set
    nombre = coalesce(p_nombre, nombre),
    rol = coalesce(p_rol, rol),
    activo = coalesce(p_activo, activo)
  where id = p_perfil_id;

  if p_rol is not null and p_rol <> 'operario' then
    delete from public.perfiles_sucursal where perfil_id = p_perfil_id;
  elsif p_sucursal_ids is not null then
    delete from public.perfiles_sucursal where perfil_id = p_perfil_id;
    insert into public.perfiles_sucursal (perfil_id, sucursal_id)
    select p_perfil_id, s from unnest(p_sucursal_ids) as s;
  end if;
end;
$$;
