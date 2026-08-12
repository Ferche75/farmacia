-- Vencimiento a nivel de inventario, no solo de evento de escaneo.
-- Hasta acá `escaneos.vencimiento`/`lote` (Fase 1) solo quedaban como
-- registro de que ESE escaneo puntual trajo esa fecha — no había forma de
-- preguntar "qué está por vencer" fuera del contexto de un conteo
-- abierto. `lotes` guarda la cantidad vigente por (producto, número de
-- lote, fecha de vencimiento) en cada sucursal.
--
-- Se alimenta EXCLUSIVAMENTE al cerrar un conteo (cerrar_conteo, más
-- abajo) agregando los escaneos que trajeron vencimiento — igual criterio
-- que conteo_lineas.cantidad: nunca se edita a mano, siempre se recalcula
-- desde los escaneos. Filas escaneadas sin vencimiento no generan lote acá
-- (no hay nada que vigilar).

create table lotes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id) on delete cascade,
  sucursal_id uuid not null references sucursales (id) on delete cascade,
  producto_id uuid not null references productos (id) on delete cascade,
  lote text,
  vencimiento date not null,
  cantidad integer not null default 0,
  actualizado_en_conteo_id uuid references conteos (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- coalesce(lote, ''): dos escaneos con la misma fecha de vencimiento y sin
-- número de lote de texto son el mismo lote a los efectos de este
-- tracking (NULL <> NULL rompería el upsert si no se normaliza).
create unique index ix_lotes_clave on lotes (
  empresa_id, sucursal_id, producto_id, (coalesce(lote, '')), vencimiento
);
create index ix_lotes_vencimiento on lotes (empresa_id, vencimiento) where cantidad > 0;

alter table lotes enable row level security;

create policy lotes_select on lotes
  for select
  using (
    mi_rol() = 'superadmin'
    or (empresa_id = mi_empresa_id() and tengo_acceso_sucursal(sucursal_id))
  );

-- Sin policies de insert/update/delete para authenticated: se escribe
-- exclusivamente desde cerrar_conteo (SECURITY DEFINER), mismo criterio
-- que conteos/escaneos (ver 20260806000001_catalogo_conteo.sql).

-- CREATE OR REPLACE: reemplaza cerrar_conteo de Fase 6
-- (20260806000007_cierre_resumen.sql), misma firma y mismo contrato de
-- seguridad. Único cambio: al cerrar, upsertea `lotes` con el recuento de
-- ESTE conteo para los productos que trajeron vencimiento — solo toca los
-- lotes que efectivamente se volvieron a escanear acá; los que no
-- aparecieron quedan con lo que dejó su último conteo.
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
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para cerrar conteos';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo_id;
  if not found then
    raise exception 'Conteo % no existe', p_conteo_id;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
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
    empresa_id, sucursal_id, producto_id, lote, vencimiento, cantidad,
    actualizado_en_conteo_id, updated_at
  )
  select
    v_conteo.empresa_id, v_conteo.sucursal_id, cl.producto_id, e.lote, e.vencimiento,
    sum(e.delta), p_conteo_id, now()
  from public.escaneos e
  join public.conteo_lineas cl on cl.id = e.linea_id
  where e.conteo_id = p_conteo_id
    and e.vencimiento is not null
    and cl.producto_id is not null
  group by cl.producto_id, e.lote, e.vencimiento
  on conflict (empresa_id, sucursal_id, producto_id, (coalesce(lote, '')), vencimiento)
  do update set
    cantidad = excluded.cantidad,
    actualizado_en_conteo_id = excluded.actualizado_en_conteo_id,
    updated_at = now();

  -- A partir de acá el conteo queda de solo lectura de verdad: tanto
  -- registrar_escaneos_batch como registrar_escaneo_desconocido (Fases 1
  -- y 4) ya chequean `estado <> 'abierto'` y rechazan cualquier escritura.

  return json_build_object(
    'id', p_conteo_id,
    'desconocidos_pendientes', v_desconocidos_pendientes
  );
end;
$$;
