-- Fase 1: esquema completo (sección 4 del spec) — catálogo maestro global,
-- datos por empresa, conteo, desconocidos, importaciones, y la tabla
-- movimientos_stock reservada (sin RLS de escritura ni RPC, a propósito).
--
-- Orden de creación: por dependencia de FK, no por el orden temático del
-- spec original.

create extension if not exists pg_trgm;

-- ═══════════════════════════════════════════════════════════════
-- CATÁLOGO MAESTRO (global, compartido entre empresas)
-- ═══════════════════════════════════════════════════════════════

create table laboratorios (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique
);

create table productos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  laboratorio_id uuid references laboratorios (id) on delete set null,
  principio_activo text,
  concentracion text,
  forma text,
  contenido numeric,
  unidad text,
  requiere_receta boolean not null default false,
  controlado boolean not null default false,
  -- Origen inferido del spec (Fase 5 menciona 'ia' y 'manual'; 'importado'
  -- se agrega para los que entran por Fase 2) — no estaba en la sección 4.
  origen text not null default 'manual' check (origen in ('manual', 'ia', 'importado')),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table codigos_barra (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos (id) on delete cascade,
  codigo_norm text not null,
  codigo_raw text not null,
  tipo text check (tipo in ('EAN13', 'UPCA', 'GTIN14', 'DATAMATRIX', 'GS1-128')),
  es_principal boolean not null default false,
  unidades_por_codigo integer not null default 1
);

-- ═══════════════════════════════════════════════════════════════
-- DATOS POR EMPRESA
-- ═══════════════════════════════════════════════════════════════

create table productos_empresa (
  empresa_id uuid not null references empresas (id) on delete cascade,
  producto_id uuid not null references productos (id) on delete cascade,
  costo numeric(14, 4),
  precio numeric(14, 4),
  stock_minimo integer,
  activo boolean not null default true,
  primary key (empresa_id, producto_id)
);

-- ═══════════════════════════════════════════════════════════════
-- DESCONOCIDOS
-- ═══════════════════════════════════════════════════════════════
-- Se crea antes que conteos/conteo_lineas porque conteo_lineas la
-- referencia.

create table desconocidos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  codigo_norm text not null,
  codigo_raw text not null,
  foto_path text,
  estado text not null default 'pendiente_ia'
    check (estado in ('pendiente_ia', 'sugerido', 'no_reconocido', 'resuelto')),
  ia_respuesta jsonb,
  ia_confianza numeric,
  ia_intentos integer not null default 0,
  producto_resuelto_id uuid references productos (id),
  revisado_por uuid references perfiles (id),
  revisado_at timestamptz,
  detectado_por uuid not null references perfiles (id),
  created_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════
-- CONTEO
-- ═══════════════════════════════════════════════════════════════

create table conteos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  sucursal_id uuid not null references sucursales (id) on delete restrict,
  nombre text not null,
  -- Tipo inferido, no especificado en la sección 4 del spec. Es solo un
  -- CHECK — fácil de ajustar cuando se defina el flujo real en Fase 3.
  tipo text not null default 'total' check (tipo in ('total', 'parcial')),
  estado text not null default 'abierto' check (estado in ('abierto', 'cerrado')),
  iniciado_por uuid not null references perfiles (id),
  iniciado_at timestamptz not null default now(),
  cerrado_at timestamptz,
  cerrado_por uuid references perfiles (id)
);

create table conteo_lineas (
  id uuid primary key default gen_random_uuid(),
  conteo_id uuid not null references conteos (id) on delete cascade,
  producto_id uuid references productos (id) on delete restrict,
  desconocido_id uuid references desconocidos (id) on delete restrict,
  cantidad integer not null default 0,
  notas text,
  -- Gap detectado en Fase 0 (ver docs/decisiones.md): los índices únicos
  -- parciales de abajo ya asumían este XOR, pero faltaba el constraint que
  -- lo garantiza.
  constraint conteo_lineas_producto_xor_desconocido
    check ((producto_id is not null) <> (desconocido_id is not null))
);

create table escaneos (
  id uuid primary key default gen_random_uuid(),
  conteo_id uuid not null references conteos (id) on delete cascade,
  linea_id uuid not null references conteo_lineas (id) on delete cascade,
  codigo_raw text not null,
  codigo_norm text not null,
  delta integer not null default 1,
  lote text,
  vencimiento date,
  usuario_id uuid not null references perfiles (id),
  dispositivo text,
  -- Gap detectado en Fase 0: CONTEXTO.md exige sincronización idempotente
  -- por client_uuid, pero la tabla original no tenía la columna.
  client_uuid uuid not null,
  created_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════
-- IMPORTACIÓN
-- ═══════════════════════════════════════════════════════════════

create table importaciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  archivo text not null,
  mapeo jsonb,
  filas_ok integer not null default 0,
  filas_error integer not null default 0,
  log jsonb,
  -- Estado inferido, no especificado en la sección 4 del spec.
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'procesando', 'completado', 'error')),
  creado_por uuid not null references perfiles (id),
  created_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════
-- RESERVADO — NO CONSTRUIR TODAVÍA
-- ═══════════════════════════════════════════════════════════════
-- Tabla y RLS creadas por si se decide construir stock permanente más
-- adelante. A propósito sin ninguna policy de lectura/escritura para
-- authenticated (ver sección RLS) ni RPC — queda inaccesible salvo por la
-- service_role key hasta que una fase futura la active a propósito.

create table movimientos_stock (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  sucursal_id uuid not null references sucursales (id) on delete cascade,
  producto_id uuid not null references productos (id) on delete restrict,
  tipo text not null check (tipo in ('ingreso', 'venta', 'ajuste')),
  delta integer not null,
  referencia text,
  usuario_id uuid not null references perfiles (id),
  created_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════
-- ÍNDICES (sección 4 del spec, + client_uuid que es gap propio)
-- ═══════════════════════════════════════════════════════════════

create unique index ix_cb_norm on codigos_barra (codigo_norm);
create index ix_cb_producto on codigos_barra (producto_id);
create index ix_prod_nombre on productos using gin (nombre gin_trgm_ops);
create index ix_prod_lab on productos (laboratorio_id) where activo;
create index ix_pe_empresa on productos_empresa (empresa_id) where activo;
create unique index ix_linea_prod on conteo_lineas (conteo_id, producto_id)
  where producto_id is not null;
create unique index ix_linea_desc on conteo_lineas (conteo_id, desconocido_id)
  where desconocido_id is not null;
create index ix_escaneos on escaneos (conteo_id, created_at desc);
create unique index ix_escaneos_client_uuid on escaneos (client_uuid);
create index ix_desc_pend on desconocidos (empresa_id, estado) where estado <> 'resuelto';
create index ix_conteos_suc on conteos (sucursal_id, estado, iniciado_at desc);

-- ═══════════════════════════════════════════════════════════════
-- TRIGGERS
-- ═══════════════════════════════════════════════════════════════

create function set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger productos_set_updated_at
  before update on productos
  for each row
  execute function set_updated_at();

-- CONTEXTO.md regla 5: la cantidad de una línea es la suma de sus eventos,
-- nunca un valor editado a mano. Este trigger es lo que lo garantiza — el
-- spec original lo daba por hecho pero no especificaba el mecanismo
-- (gap detectado en Fase 0).
create function recalcular_cantidad_linea()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.conteo_lineas
  set cantidad = (
    select coalesce(sum(delta), 0)
    from public.escaneos
    where linea_id = new.linea_id
  )
  where id = new.linea_id;
  return new;
end;
$$;

create trigger escaneos_recalcular_cantidad
  after insert on escaneos
  for each row
  execute function recalcular_cantidad_linea();

-- ═══════════════════════════════════════════════════════════════
-- HELPERS PARA RLS (además de mi_empresa_id() y mi_rol() de Fase 0)
-- ═══════════════════════════════════════════════════════════════

-- admin/gerente/superadmin acceden a cualquier sucursal de su empresa;
-- operario solo a las que tiene asignadas en perfiles_sucursal.
create function tengo_acceso_sucursal(p_sucursal uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select case
    when public.mi_rol() in ('admin', 'gerente', 'superadmin') then
      exists (
        select 1 from public.sucursales
        where id = p_sucursal and empresa_id = public.mi_empresa_id()
      )
    else
      exists (
        select 1 from public.perfiles_sucursal
        where perfil_id = auth.uid() and sucursal_id = p_sucursal
      )
  end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════
-- Mismo alcance que Fase 0: solo políticas de LECTURA. Los INSERT/UPDATE
-- de conteo, escaneos y desconocidos pasan exclusivamente por las
-- funciones RPC (SECURITY DEFINER, no sujetas a estas policies) hasta que
-- exista la UI real que los necesite (Fases 2 a 5) y se sepa con
-- precisión quién puede escribir qué.

alter table laboratorios enable row level security;
alter table productos enable row level security;
alter table codigos_barra enable row level security;
alter table productos_empresa enable row level security;
alter table desconocidos enable row level security;
alter table conteos enable row level security;
alter table conteo_lineas enable row level security;
alter table escaneos enable row level security;
alter table importaciones enable row level security;
alter table movimientos_stock enable row level security;

-- Catálogo global: cualquier usuario autenticado (con perfil o sin él) lo
-- puede leer. No lleva costo/precio, así que no hay nada que proteger acá
-- (eso vive en productos_empresa).
create policy laboratorios_select on laboratorios
  for select using (auth.uid() is not null);

create policy productos_select on productos
  for select using (auth.uid() is not null);

create policy codigos_barra_select on codigos_barra
  for select using (auth.uid() is not null);

-- Costo/precio: CONTEXTO.md regla 3 — protegido en la base, no en el
-- frontend. El operario directamente no tiene fila visible acá.
create policy productos_empresa_select on productos_empresa
  for select using (
    mi_rol() = 'superadmin'
    or (empresa_id = mi_empresa_id() and mi_rol() <> 'operario')
  );

create policy desconocidos_select on desconocidos
  for select using (mi_rol() = 'superadmin' or empresa_id = mi_empresa_id());

create policy conteos_select on conteos
  for select using (
    mi_rol() = 'superadmin'
    or (empresa_id = mi_empresa_id() and tengo_acceso_sucursal(sucursal_id))
  );

create policy conteo_lineas_select on conteo_lineas
  for select using (
    exists (
      select 1 from conteos c
      where c.id = conteo_lineas.conteo_id
        and (
          mi_rol() = 'superadmin'
          or (c.empresa_id = mi_empresa_id() and tengo_acceso_sucursal(c.sucursal_id))
        )
    )
  );

create policy escaneos_select on escaneos
  for select using (
    exists (
      select 1 from conteos c
      where c.id = escaneos.conteo_id
        and (
          mi_rol() = 'superadmin'
          or (c.empresa_id = mi_empresa_id() and tengo_acceso_sucursal(c.sucursal_id))
        )
    )
  );

-- Importaciones: no es para operario.
create policy importaciones_select on importaciones
  for select using (
    mi_rol() = 'superadmin'
    or (empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente'))
  );

-- movimientos_stock: a propósito CERO policies además del enable de
-- arriba — ni siquiera select. Inaccesible para authenticated hasta que
-- una fase futura decida activarlo.
