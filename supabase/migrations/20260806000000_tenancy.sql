-- Fase 0: modelo de tenancy base (empresas, sucursales, perfiles,
-- perfiles_sucursal) + RLS. El resto del esquema (catálogo, conteo,
-- desconocidos, importaciones) se agrega en la migración de Fase 1.

-- ═══════════════════════════════════════════════════════════════
-- TABLAS
-- ═══════════════════════════════════════════════════════════════

create table empresas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nit text,
  pais text,
  config jsonb not null default '{}'::jsonb,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table sucursales (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  nombre text not null,
  direccion text,
  activo boolean not null default true
);

create index ix_sucursales_empresa on sucursales (empresa_id) where activo;

-- id = auth.users.id a propósito: un perfil es la extensión de un usuario
-- de Supabase Auth dentro del dominio de la app, 1:1.
create table perfiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null,
  empresa_id uuid not null references empresas (id) on delete restrict,
  rol text not null check (rol in ('superadmin', 'gerente', 'admin', 'operario')),
  activo boolean not null default true
);

create index ix_perfiles_empresa on perfiles (empresa_id) where activo;

create table perfiles_sucursal (
  perfil_id uuid not null references perfiles (id) on delete cascade,
  sucursal_id uuid not null references sucursales (id) on delete cascade,
  primary key (perfil_id, sucursal_id)
);

-- ═══════════════════════════════════════════════════════════════
-- HELPERS PARA RLS
-- ═══════════════════════════════════════════════════════════════
-- SECURITY DEFINER + search_path fijo: evitan tanto el hijacking de
-- search_path como la recursión infinita de una policy en `perfiles`
-- que necesita leer `perfiles` (el dueño de la función no está sujeto
-- a RLS al ejecutarla).

create function mi_empresa_id()
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select empresa_id from public.perfiles where id = auth.uid();
$$;

create function mi_rol()
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select rol from public.perfiles where id = auth.uid();
$$;

-- ═══════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════
-- Alcance de Fase 0: solo políticas de LECTURA. El alta de empresas,
-- sucursales y usuarios todavía no tiene UI (eso es el panel de
-- superadmin de Fase 7) — hasta entonces se provisionan con la
-- service_role key, que de todos modos ignora RLS. No agregar policies
-- de escritura para authenticated hasta que Fase 7 defina quién puede
-- crear qué.

alter table empresas enable row level security;
alter table sucursales enable row level security;
alter table perfiles enable row level security;
alter table perfiles_sucursal enable row level security;

create policy empresas_select on empresas
  for select
  using (id = mi_empresa_id() or mi_rol() = 'superadmin');

create policy sucursales_select on sucursales
  for select
  using (empresa_id = mi_empresa_id() or mi_rol() = 'superadmin');

create policy perfiles_select on perfiles
  for select
  using (
    id = auth.uid()
    or empresa_id = mi_empresa_id()
    or mi_rol() = 'superadmin'
  );

create policy perfiles_sucursal_select on perfiles_sucursal
  for select
  using (
    perfil_id = auth.uid()
    or perfil_id in (select id from perfiles where empresa_id = mi_empresa_id())
    or mi_rol() = 'superadmin'
  );
