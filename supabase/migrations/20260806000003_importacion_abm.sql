-- Fase 2: soporte de base para el importador de catálogo y el ABM manual
-- de productos.
--
-- Gap nuevo (no estaba en la sección 4 del spec): "el mapeo se guarda con
-- nombre para reutilizarlo" implica una entidad propia, separada de
-- `importaciones` (que es el LOG de una corrida, no una plantilla
-- reutilizable). Se agrega `mapeos_columnas`.

create table mapeos_columnas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  nombre text not null,
  mapeo jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (empresa_id, nombre)
);

create trigger mapeos_columnas_set_updated_at
  before update on mapeos_columnas
  for each row
  execute function set_updated_at();

alter table mapeos_columnas enable row level security;

create policy mapeos_columnas_select on mapeos_columnas
  for select using (
    mi_rol() = 'superadmin'
    or (empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente'))
  );

create policy mapeos_columnas_insert on mapeos_columnas
  for insert with check (
    empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente', 'superadmin')
  );

create policy mapeos_columnas_update on mapeos_columnas
  for update using (
    empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente', 'superadmin')
  );

create policy mapeos_columnas_delete on mapeos_columnas
  for delete using (
    empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente', 'superadmin')
  );

-- ═══════════════════════════════════════════════════════════════
-- ABM manual de productos: primeras policies de ESCRITURA sobre el
-- catálogo global. Hasta acá (Fase 0 y 1) todo lo global era solo
-- lectura — esta es la fase que agrega la UI que realmente lo necesita.
--
-- Nota de gobierno (documentada también en docs/decisiones.md): el
-- catálogo es global y compartido entre empresas (decisión #2 del spec),
-- así que CUALQUIER admin/gerente de CUALQUIER empresa puede crear/editar
-- productos globales — no hay todavía un rol "curador de catálogo"
-- separado. Para acotar el daño posible, el DELETE físico de productos y
-- laboratorios queda reservado a superadmin; admin/gerente solo puede
-- desactivar (activo = false), que ya cubre el UPDATE.
-- ═══════════════════════════════════════════════════════════════

create policy laboratorios_insert on laboratorios
  for insert with check (mi_rol() in ('admin', 'gerente', 'superadmin'));

create policy laboratorios_update on laboratorios
  for update using (mi_rol() in ('admin', 'gerente', 'superadmin'));

create policy laboratorios_delete on laboratorios
  for delete using (mi_rol() = 'superadmin');

create policy productos_insert on productos
  for insert with check (mi_rol() in ('admin', 'gerente', 'superadmin'));

create policy productos_update on productos
  for update using (mi_rol() in ('admin', 'gerente', 'superadmin'));

create policy productos_delete on productos
  for delete using (mi_rol() = 'superadmin');

create policy codigos_barra_insert on codigos_barra
  for insert with check (mi_rol() in ('admin', 'gerente', 'superadmin'));

create policy codigos_barra_update on codigos_barra
  for update using (mi_rol() in ('admin', 'gerente', 'superadmin'));

-- productos_empresa (costo/precio/stock_minimo): escritura solo dentro de
-- la propia empresa, nunca operario — mismo criterio que la SELECT de
-- Fase 1.
create policy productos_empresa_insert on productos_empresa
  for insert with check (
    empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente', 'superadmin')
  );

create policy productos_empresa_update on productos_empresa
  for update using (
    empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente', 'superadmin')
  );
