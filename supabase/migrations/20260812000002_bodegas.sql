-- Bodega: sub-ubicación de stock dentro de una sucursal (ej. "depósito"
-- vs "mostrador" de la misma sucursal). Cada empresa puede tener varias
-- sucursales (Fase 0), y ahora cada sucursal puede tener varias bodegas.
--
-- Mismo patrón que sucursales: soft-delete con `activo`, alta/baja solo
-- por superadmin (panel de Fase 7), lectura para cualquier usuario de la
-- empresa. empresa_id queda denormalizado (se puede derivar de
-- sucursal_id) a propósito, mismo criterio que conteos/movimientos_stock
-- — simplifica la policy de SELECT sin un join extra.

create table bodegas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  sucursal_id uuid not null references sucursales (id) on delete cascade,
  nombre text not null,
  activo boolean not null default true
);

create index ix_bodegas_sucursal on bodegas (sucursal_id) where activo;

alter table bodegas enable row level security;

create policy bodegas_select on bodegas
  for select
  using (empresa_id = mi_empresa_id() or mi_rol() = 'superadmin');

create policy bodegas_insert on bodegas
  for insert
  with check (mi_rol() = 'superadmin');

create policy bodegas_update on bodegas
  for update
  using (mi_rol() = 'superadmin')
  with check (mi_rol() = 'superadmin');

-- Sin policy de DELETE, mismo criterio que empresas/sucursales/perfiles
-- (20260806000009_superadmin_rls.sql): soft-delete vía `activo`, nunca
-- borrado físico desde la UI.
