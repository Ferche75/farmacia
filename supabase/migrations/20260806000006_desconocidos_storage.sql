-- Fase 4: bucket de Storage para las fotos de desconocidos, RLS por
-- empresa_id/conteo_id, y las 2 funciones RPC que hacen falta:
-- registrar_escaneo_desconocido (crear/reusar un desconocido + su línea
-- de conteo) y resolver_desconocido (aceptar/corregir una sugerencia —
-- esta última implementa lo mismo que pide la sección "Fase 5" del spec
-- para vincular/crear producto y migrar líneas, porque el botón
-- "Aceptar" de Fase 4 lo necesita ya. Fase 5 reusa este mismo RPC, solo
-- le falta la UI de bandeja con búsqueda y navegación por teclado).

-- ═══════════════════════════════════════════════════════════════
-- STORAGE
-- ═══════════════════════════════════════════════════════════════
-- Gap cerrado de docs/decisiones.md (Fase 0): faltaban las policies de
-- Storage para que una empresa no pueda leer fotos de otra. Bucket
-- privado (public=false) — el acceso es siempre vía policy + sesión, no
-- por URL pública.

insert into storage.buckets (id, name, public)
values ('desconocidos', 'desconocidos', false)
on conflict (id) do nothing;

-- La ruta de cada archivo es "empresa_id/conteo_id/archivo.jpg" (tal
-- cual pide el spec) — split_part(name,'/',1) es el empresa_id.
create policy desconocidos_storage_select on storage.objects
  for select using (
    bucket_id = 'desconocidos'
    and (mi_rol() = 'superadmin' or split_part(name, '/', 1) = mi_empresa_id()::text)
  );

create policy desconocidos_storage_insert on storage.objects
  for insert with check (
    bucket_id = 'desconocidos'
    and split_part(name, '/', 1) = mi_empresa_id()::text
  );

-- ═══════════════════════════════════════════════════════════════
-- registrar_escaneo_desconocido
-- ═══════════════════════════════════════════════════════════════
-- Idempotente por client_uuid, mismo criterio que registrar_escaneos_batch.
-- Si el codigo_norm ya existe en desconocidos para esta empresa, lo
-- reusa (no pide otra foto — CONTEXTO.md: "si se vuelve a escanear, NO
-- pedir la foto"). Si ya existe en codigos_barra (alguien lo resolvió o
-- importó mientras este dispositivo estaba offline con catálogo viejo),
-- rechaza con un mensaje claro en vez de crear un desconocido duplicado.

create function registrar_escaneo_desconocido(
  p_conteo uuid,
  p_codigo_raw text,
  p_client_uuid uuid,
  p_foto_path text default null,
  p_dispositivo text default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conteo record;
  v_empresa_id uuid := public.mi_empresa_id();
  v_codigo_norm text;
  v_desconocido_id uuid;
  v_es_nuevo boolean := false;
  v_linea_id uuid;
begin
  if public.mi_rol() is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo;
  if not found then
    raise exception 'Conteo % no existe', p_conteo;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> v_empresa_id then
    raise exception 'No autorizado para este conteo';
  end if;

  if public.mi_rol() <> 'superadmin' and not public.tengo_acceso_sucursal(v_conteo.sucursal_id) then
    raise exception 'No autorizado para esa sucursal';
  end if;

  if v_conteo.estado <> 'abierto' then
    raise exception 'El conteo % ya está cerrado', p_conteo;
  end if;

  if exists (select 1 from public.escaneos where client_uuid = p_client_uuid) then
    return json_build_object('duplicado', true);
  end if;

  v_codigo_norm := (public.normalizar_codigo(p_codigo_raw)).codigo_norm;
  if v_codigo_norm is null then
    raise exception 'Código inválido';
  end if;

  if exists (select 1 from public.codigos_barra where codigo_norm = v_codigo_norm) then
    raise exception
      'codigo_ya_en_catalogo: este código ya está en el catálogo, el dispositivo tenía datos desactualizados — refrescá el catálogo local';
  end if;

  select id into v_desconocido_id
  from public.desconocidos
  where empresa_id = v_empresa_id and codigo_norm = v_codigo_norm;

  if v_desconocido_id is null then
    if p_foto_path is null then
      raise exception 'Un desconocido nuevo necesita una foto';
    end if;

    insert into public.desconocidos (
      empresa_id, codigo_norm, codigo_raw, foto_path, estado, detectado_por
    )
    values (
      v_empresa_id, v_codigo_norm, p_codigo_raw, p_foto_path, 'pendiente_ia', auth.uid()
    )
    returning id into v_desconocido_id;

    v_es_nuevo := true;
  end if;

  insert into public.conteo_lineas (conteo_id, desconocido_id)
  values (p_conteo, v_desconocido_id)
  on conflict (conteo_id, desconocido_id) where desconocido_id is not null
  do update set conteo_id = excluded.conteo_id
  returning id into v_linea_id;

  insert into public.escaneos (
    conteo_id, linea_id, codigo_raw, codigo_norm, delta, usuario_id, dispositivo, client_uuid
  )
  values (
    p_conteo, v_linea_id, p_codigo_raw, v_codigo_norm, 1, auth.uid(), p_dispositivo, p_client_uuid
  )
  on conflict (client_uuid) do nothing;

  return json_build_object(
    'desconocido_id', v_desconocido_id,
    'es_nuevo', v_es_nuevo,
    'linea_id', v_linea_id
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- resolver_desconocido
-- ═══════════════════════════════════════════════════════════════
-- p_producto_id: vincular a un producto YA existente (esto es lo que
-- Fase 5 va a exponer con buscador). p_nuevo_producto: crear uno nuevo a
-- partir de esos campos (esto es lo que usan "Aceptar"/"Corregir" de
-- Fase 4 con la sugerencia de la IA, editada o no). Exactamente uno de
-- los dos.
--
-- Migra TODAS las conteo_lineas que apuntaban al desconocido, en
-- cualquier conteo, conservando la cantidad acumulada — tal cual pide
-- la sección "Fase 5" del spec. Si en algún conteo puntual ya había una
-- línea separada para ese mismo producto (caso raro), se fusionan
-- re-apuntando los escaneos y recalculando la cantidad, en vez de dejar
-- dos líneas para el mismo producto en el mismo conteo.

create function resolver_desconocido(
  p_desconocido_id uuid,
  p_producto_id uuid default null,
  p_nuevo_producto jsonb default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_empresa_id uuid := public.mi_empresa_id();
  v_desconocido record;
  v_producto_id uuid;
  v_linea record;
  v_linea_existente_id uuid;
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para resolver desconocidos';
  end if;

  select * into v_desconocido from public.desconocidos where id = p_desconocido_id;
  if not found then
    raise exception 'Desconocido % no existe', p_desconocido_id;
  end if;

  if public.mi_rol() <> 'superadmin' and v_desconocido.empresa_id <> v_empresa_id then
    raise exception 'No autorizado para este desconocido';
  end if;

  if p_producto_id is not null then
    v_producto_id := p_producto_id;
  else
    if p_nuevo_producto is null then
      raise exception 'Hace falta p_producto_id o p_nuevo_producto';
    end if;

    insert into public.productos (
      nombre, laboratorio_id, principio_activo, concentracion, forma,
      contenido, unidad, origen
    )
    values (
      p_nuevo_producto ->> 'nombre',
      nullif(p_nuevo_producto ->> 'laboratorio_id', '')::uuid,
      p_nuevo_producto ->> 'principio_activo',
      p_nuevo_producto ->> 'concentracion',
      p_nuevo_producto ->> 'forma',
      nullif(p_nuevo_producto ->> 'contenido', '')::numeric,
      p_nuevo_producto ->> 'unidad',
      coalesce(p_nuevo_producto ->> 'origen', 'ia')
    )
    returning id into v_producto_id;
  end if;

  -- Si el código ya está tomado por otro producto (carrera rara, o ya
  -- se había importado mientras tanto) se deja tal cual está — el
  -- producto nuevo/vinculado igual queda correcto en conteo_lineas.
  insert into public.codigos_barra (producto_id, codigo_norm, codigo_raw, es_principal)
  values (v_producto_id, v_desconocido.codigo_norm, v_desconocido.codigo_raw, true)
  on conflict (codigo_norm) do nothing;

  for v_linea in
    select * from public.conteo_lineas where desconocido_id = p_desconocido_id
  loop
    select id into v_linea_existente_id
    from public.conteo_lineas
    where conteo_id = v_linea.conteo_id and producto_id = v_producto_id;

    if v_linea_existente_id is not null then
      update public.escaneos set linea_id = v_linea_existente_id where linea_id = v_linea.id;

      update public.conteo_lineas set cantidad = (
        select coalesce(sum(delta), 0) from public.escaneos where linea_id = v_linea_existente_id
      ) where id = v_linea_existente_id;

      delete from public.conteo_lineas where id = v_linea.id;
    else
      update public.conteo_lineas
      set producto_id = v_producto_id, desconocido_id = null
      where id = v_linea.id;
    end if;
  end loop;

  update public.desconocidos
  set estado = 'resuelto',
      producto_resuelto_id = v_producto_id,
      revisado_por = auth.uid(),
      revisado_at = now()
  where id = p_desconocido_id;

  return json_build_object('producto_id', v_producto_id);
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- REALTIME
-- ═══════════════════════════════════════════════════════════════
-- Necesario para que la tarjeta de sugerencia aparezca sola cuando n8n
-- termina de procesar la foto (sin esto, Supabase no manda los cambios
-- de esta tabla por Realtime aunque el cliente esté suscripto). RLS de
-- Fase 1 (desconocidos_select) ya filtra qué filas le llegan a quién.

alter publication supabase_realtime add table desconocidos;
