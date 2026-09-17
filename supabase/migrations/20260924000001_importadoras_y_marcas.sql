-- IMPORTADORA → MARCAS: un catálogo chico para que "¿de qué marca es
-- esto?" deje de ser adivinanza de texto libre en el ABM.
--
-- El caso real que trajo el usuario: una IMPORTADORA (SAE, INTI) trae un
-- conjunto ACOTADO y conocido de MARCAS. SAE trae LCH Genérico, LCH Marca
-- y Foramen. INTI trae Braun, Inti éticos, Inti OTC y Merck. Quien carga
-- un producto sabe de qué importadora vino, y con eso la lista de marcas
-- posibles pasa de "cualquier cosa" a cuatro opciones.
--
-- ═══════════════════════════════════════════════════════════════
-- QUÉ NO ES ESTO (los tres límites que definen el alcance)
-- ═══════════════════════════════════════════════════════════════
--
-- 1) NO REEMPLAZA `productos_empresa.distribuidor`. Esa columna de texto
--    libre (20260813000007) queda exactamente como está, escrita por el
--    importador de CSV, por el ABM y por el popup de completar datos de
--    apps/conteo. `importadora_id` se suma AL LADO: es el mismo tipo de
--    dato pero estructurado, y convivir es más barato que migrar un campo
--    que hoy está cableado en tres flujos vivos. Si algún día se quiere
--    unificar, será una tarea propia con su propio backfill.
--
-- 2) NO CONVIERTE `productos.marca` EN FOREIGN KEY. `productos.marca`
--    (20260918000001) sigue siendo texto libre GLOBAL y lo siguen
--    escribiendo el importador, el ABM y el popup de conteo, sin
--    validación contra ninguna tabla. `marcas_importadora` es un catálogo
--    de SUGERENCIAS: el ABM ofrece las marcas conocidas de la importadora
--    elegida y, si se escribe una nueva, la aprende. Una FK obligaría a
--    que toda marca importada por CSV existiera antes en el catálogo, y
--    rechazaría filas que hoy entran.
--
-- 3) NO TIENE PANTALLA DE GESTIÓN, igual que `laboratorios` (que tampoco
--    la tiene desde Fase 1). El catálogo se llena SOLO, con el mismo
--    upsert-por-nombre al guardar un producto que ya usa `laboratorios`.
--    Empieza vacío para cada empresa y crece con el uso.
--
-- ═══════════════════════════════════════════════════════════════
-- POR QUÉ `importadoras` ES POR EMPRESA Y `laboratorios` ES GLOBAL
-- ═══════════════════════════════════════════════════════════════
-- No es inconsistencia, es la misma regla aplicada bien: quién FABRICA un
-- medicamento es un hecho del medicamento, igual en toda Bolivia, y por
-- eso `laboratorios` es global y compartido. Con quién COMPRA una farmacia
-- es una relación comercial de esa farmacia: dos farmacias de la misma
-- ciudad le compran a importadoras distintas, y la lista de una no le
-- sirve para nada a la otra. Es el mismo criterio por el que
-- `distribuidor` vive en productos_empresa y no en productos.

create table importadoras (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  nombre text not null,
  unique (empresa_id, nombre)
);

-- Hijo de importadoras, con `on delete cascade`: las marcas no tienen
-- sentido sin la importadora que las trae, y son datos de sugerencia (lo
-- que un producto tenga guardado en productos.marca es texto y sobrevive
-- igual al borrado del catálogo).
create table marcas_importadora (
  id uuid primary key default gen_random_uuid(),
  importadora_id uuid not null references importadoras (id) on delete cascade,
  nombre text not null,
  unique (importadora_id, nombre)
);

comment on table importadoras is
  'Catalogo POR EMPRESA de importadoras con las que trabaja esa farmacia. Se llena solo, con upsert por nombre al guardar un producto en el ABM (mismo patron que laboratorios, que no tiene pantalla de gestion). No reemplaza a productos_empresa.distribuidor, que sigue siendo texto libre.';
comment on table marcas_importadora is
  'Marcas que trae cada importadora. Es un catalogo de SUGERENCIAS para el campo productos.marca, que sigue siendo texto libre global y no tiene FK contra esta tabla: el ABM ofrece estas marcas y aprende las nuevas, el importador de CSV escribe marca sin mirar aca.';

-- ═══════════════════════════════════════════════════════════════
-- productos_empresa.importadora_id
-- ═══════════════════════════════════════════════════════════════
-- Nullable y aditiva. Qué importadora le trae ESTE producto a ESTA
-- empresa: por eso cuelga de productos_empresa y no de productos.
-- `on delete set null` (y no cascade) porque borrar una importadora del
-- catálogo no puede llevarse puesta la fila de precio/costo del producto.
alter table productos_empresa
  add column importadora_id uuid references importadoras (id) on delete set null;

comment on column productos_empresa.importadora_id is
  'Importadora que le trae este producto a esta empresa. ADITIVA: convive con la columna de texto libre `distribuidor`, no la reemplaza ni la migra.';

create index ix_marcas_importadora on marcas_importadora (importadora_id);
create index ix_productos_empresa_importadora on productos_empresa (importadora_id)
  where importadora_id is not null;

-- ═══════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════
alter table importadoras enable row level security;
alter table marcas_importadora enable row level security;

-- SELECT: cualquiera de la empresa, más superadmin. Idéntico a
-- bodegas_select / desconocidos_select (20260812000002 / 20260806000001),
-- que es el idioma de este proyecto para una tabla de catálogo con
-- empresa_id propio. NO se copia el `and mi_rol() <> 'operario'` de
-- productos_empresa_select: esa exclusión existe porque esa tabla lleva
-- costo y precio (CONTEXTO.md regla 3), y acá no hay más que nombres de
-- proveedores.
create policy importadoras_select on importadoras
  for select using (empresa_id = mi_empresa_id() or mi_rol() = 'superadmin');

-- INSERT/UPDATE: calcado de productos_empresa_insert / _update
-- (20260806000003_importacion_abm.sql) — misma sensibilidad que editar el
-- precio de un producto, que es la otra cosa que hace la misma pantalla.
-- Hacen falta LAS DOS para que el upsert del ABM funcione: PostgREST manda
-- un INSERT ... ON CONFLICT DO UPDATE y necesita permiso para las dos
-- mitades.
create policy importadoras_insert on importadoras
  for insert with check (
    empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente', 'superadmin')
  );

create policy importadoras_update on importadoras
  for update using (
    empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente', 'superadmin')
  );

-- Sin policy de DELETE, igual que productos_empresa y que laboratorios
-- para no-superadmin: no hay UI que borre importadoras, y sin policy la
-- operación simplemente no existe para una sesión normal.

-- marcas_importadora no tiene empresa_id propio: su tenencia se resuelve a
-- UN JOIN de distancia, por su importadora. El `exists (select 1 from ...)`
-- es el idioma que este proyecto ya usa para exactamente ese caso —
-- conteo_lineas_select / escaneos_select van por `conteos`
-- (20260806000001), y las policies manuales de `lotes` validan la sucursal
-- contra la empresa con el mismo exists (20260918000001). Se repite la
-- condición entera en las tres policies en vez de factorizarla en una
-- función: así se lee igual que las otras y no agrega una pieza nueva de
-- lógica de tenancy que después haya que auditar aparte.
create policy marcas_importadora_select on marcas_importadora
  for select using (
    mi_rol() = 'superadmin'
    or exists (
      select 1 from public.importadoras i
      where i.id = marcas_importadora.importadora_id and i.empresa_id = mi_empresa_id()
    )
  );

create policy marcas_importadora_insert on marcas_importadora
  for insert with check (
    mi_rol() in ('admin', 'gerente', 'superadmin')
    and exists (
      select 1 from public.importadoras i
      where i.id = marcas_importadora.importadora_id and i.empresa_id = mi_empresa_id()
    )
  );

create policy marcas_importadora_update on marcas_importadora
  for update using (
    mi_rol() in ('admin', 'gerente', 'superadmin')
    and exists (
      select 1 from public.importadoras i
      where i.id = marcas_importadora.importadora_id and i.empresa_id = mi_empresa_id()
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- LO QUE ESTA MIGRACIÓN NO TOCA, A PROPÓSITO
-- ═══════════════════════════════════════════════════════════════
--   * `confirmar_importacion_lote`: el importador de CSV NO mapea
--     importadora. Se puede sumar después; hoy nadie lo pidió y el wizard
--     ya tiene 20 campos.
--   * `crear_producto_y_contar` y el popup de completar datos de
--     apps/conteo: un operario contando no elige importadora ni marca de
--     un catálogo. Ese flujo ni siquiera pide `marca` hoy, y no se le
--     agrega.
--   * `productos.marca`, `productos_empresa.distribuidor`,
--     /api/pdvlat/catalogo, registrar_venta, ajustar_stock: intactos.
