-- Gaps detectados probando el importador contra archivos reales de
-- proveedores (ver docs/decisiones.md, "Campos nuevos..." y el análisis
-- posterior). Dos cambios de comportamiento, ambos retrocompatibles con
-- archivos "normales" (un laboratorio, todas las filas con código de
-- barra) que siguen funcionando exactamente igual que antes:
--
-- 1) LABORATORIO POR FILA (antes: uno solo por archivo/lote). Se agrega
--    un campo opcional 'laboratorio' en cada fila de p_filas. Si la fila
--    lo trae, manda sobre p_laboratorio; si no, se usa p_laboratorio como
--    hasta ahora. Esto habilita importar un archivo que mezcla varios
--    laboratorios (ej. un export del sistema anterior de la farmacia)
--    mapeando su columna de laboratorio/grupo, sin tener que trocearlo a
--    mano en N archivos primero. La decisión original de Fase 2 ("un
--    archivo = un laboratorio", ver 20260806000004) sigue siendo el
--    default — esto la relaja, no la reemplaza.
--
-- 2) FILAS SIN CÓDIGO DE BARRA: matchean por NOMBRE EXACTO (case
--    insensitive) contra un producto ya existente, para poder actualizar
--    costo/precio/principio activo desde listas de precio que no traen
--    código (ej. listas armadas a mano por el laboratorio). Este camino
--    NUNCA crea productos nuevos — sin código no hay forma de registrar
--    codigos_barra, y el catálogo global depende de tener al menos un
--    código para poder matchearse después desde el conteo (CONTEXTO.md
--    regla 4). Si el nombre no matchea ninguno o matchea más de uno, la
--    fila se rechaza — nunca se adivina.

create or replace function previsualizar_importacion(p_laboratorio text, p_filas jsonb)
returns json
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_resultado jsonb;
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para importar catálogo';
  end if;

  with filas as (
    select
      (f.ordinality - 1)::int as fila_index,
      f.elem ->> 'codigo_barra' as codigo_barra_raw,
      nullif(trim(f.elem ->> 'nombre'), '') as nombre,
      coalesce(nullif(f.elem ->> 'laboratorio', ''), p_laboratorio) as laboratorio_fila,
      (public.normalizar_codigo(f.elem ->> 'codigo_barra')).codigo_norm as codigo_norm
    from jsonb_array_elements(p_filas) with ordinality as f (elem, ordinality)
  ),
  enumeradas as (
    select
      fl.*,
      case when fl.codigo_norm is not null
        then row_number() over (partition by fl.codigo_norm order by fl.fila_index)
        else null
      end as ocurrencia_codigo,
      case when fl.codigo_norm is null and fl.nombre is not null
        then row_number() over (partition by lower(fl.nombre) order by fl.fila_index)
        else null
      end as ocurrencia_nombre
    from filas fl
  ),
  match_nombre as (
    select e.fila_index, count(p.id) as coincidencias
    from enumeradas e
    left join public.productos p
      on e.codigo_norm is null and e.nombre is not null and lower(p.nombre) = lower(e.nombre)
    group by e.fila_index
  ),
  clasificadas as (
    select
      e.fila_index,
      e.codigo_barra_raw,
      e.nombre,
      case
        when e.codigo_norm is not null and e.ocurrencia_codigo > 1 then 'rechazar'
        when e.codigo_norm is not null and cb.producto_id is null then 'crear'
        when e.codigo_norm is not null and (lab.nombre is null or lab.nombre = e.laboratorio_fila) then 'actualizar'
        when e.codigo_norm is not null then 'rechazar'
        when e.nombre is null then 'rechazar'
        when e.laboratorio_fila is null then 'rechazar'
        when e.ocurrencia_nombre > 1 then 'rechazar'
        when mn.coincidencias = 1 then 'actualizar'
        else 'rechazar'
      end as accion,
      case
        when e.codigo_norm is not null and e.ocurrencia_codigo > 1 then 'codigo_duplicado_en_archivo'
        when e.codigo_norm is not null and cb.producto_id is not null
          and lab.nombre is not null and lab.nombre <> e.laboratorio_fila
          then 'ya_pertenece_a_' || lab.nombre
        when e.codigo_norm is null and e.nombre is null then 'codigo_invalido'
        when e.codigo_norm is null and e.laboratorio_fila is null then 'laboratorio_no_definido'
        when e.codigo_norm is null and e.ocurrencia_nombre > 1 then 'nombre_duplicado_en_archivo'
        when e.codigo_norm is null and mn.coincidencias = 0 then 'producto_no_encontrado_por_nombre'
        when e.codigo_norm is null and mn.coincidencias > 1 then 'nombre_ambiguo'
        else null
      end as motivo
    from enumeradas e
    left join public.codigos_barra cb on cb.codigo_norm = e.codigo_norm
    left join public.productos p on p.id = cb.producto_id
    left join public.laboratorios lab on lab.id = p.laboratorio_id
    left join match_nombre mn on mn.fila_index = e.fila_index
  )
  select jsonb_build_object(
    'total', count(*),
    'crear', count(*) filter (where accion = 'crear'),
    'actualizar', count(*) filter (where accion = 'actualizar'),
    'rechazar', count(*) filter (where accion = 'rechazar'),
    'filas', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'fila_index', fila_index,
          'codigo_barra', codigo_barra_raw,
          'nombre', nombre,
          'accion', accion,
          'motivo', motivo
        )
        order by fila_index
      ),
      '[]'::jsonb
    )
  )
  into v_resultado
  from clasificadas;

  return v_resultado::json;
end;
$$;

create or replace function confirmar_importacion_lote(p_importacion_id uuid, p_laboratorio text, p_filas jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_empresa_id uuid := public.mi_empresa_id();
  v_laboratorio_id uuid;
  v_laboratorio_nombre text;
  v_item jsonb;
  v_codigo_raw text;
  v_codigo_norm text;
  v_nombre text;
  v_concentracion text;
  v_contenido numeric;
  v_unidad text;
  v_forma text;
  v_principio_activo text;
  v_categoria text;
  v_codigo_proveedor text;
  v_costo numeric;
  v_precio numeric;
  v_producto_id uuid;
  v_lab_existente_id uuid;
  v_coincidencias integer;
  v_creados integer := 0;
  v_actualizados integer := 0;
  v_rechazados integer := 0;
  v_log jsonb := '[]'::jsonb;
  v_vistos text[] := '{}';
  v_vistos_productos uuid[] := '{}';
begin
  if v_rol not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para importar catálogo';
  end if;

  if not exists (
    select 1 from public.importaciones
    where id = p_importacion_id and empresa_id = v_empresa_id
  ) then
    raise exception 'Importación % no existe para esta empresa', p_importacion_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_filas)
  loop
    v_codigo_raw := v_item ->> 'codigo_barra';
    v_nombre := nullif(trim(v_item ->> 'nombre'), '');
    v_concentracion := v_item ->> 'concentracion';
    v_forma := v_item ->> 'forma';
    v_unidad := v_item ->> 'unidad';
    v_principio_activo := v_item ->> 'principio_activo';
    v_categoria := v_item ->> 'categoria';
    v_codigo_proveedor := v_item ->> 'codigo_proveedor';
    v_laboratorio_nombre := coalesce(nullif(v_item ->> 'laboratorio', ''), p_laboratorio);

    begin
      v_contenido := (v_item ->> 'contenido')::numeric;
    exception when others then
      v_contenido := null;
    end;
    begin
      v_costo := (v_item ->> 'costo')::numeric;
    exception when others then
      v_costo := null;
    end;
    begin
      v_precio := (v_item ->> 'precio')::numeric;
    exception when others then
      v_precio := null;
    end;

    v_codigo_norm := (public.normalizar_codigo(v_codigo_raw)).codigo_norm;

    -- Sin código de barra: actualizar por nombre exacto, nunca crear.
    if v_codigo_norm is null then
      if v_nombre is null then
        v_rechazados := v_rechazados + 1;
        v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'codigo_invalido');
        continue;
      end if;

      if v_laboratorio_nombre is null then
        v_rechazados := v_rechazados + 1;
        v_log := v_log || jsonb_build_object('nombre', v_nombre, 'motivo', 'laboratorio_no_definido');
        continue;
      end if;

      select count(*), max(id) into v_coincidencias, v_producto_id
      from public.productos
      where lower(nombre) = lower(v_nombre);

      if v_coincidencias = 0 then
        v_rechazados := v_rechazados + 1;
        v_log := v_log || jsonb_build_object('nombre', v_nombre, 'motivo', 'producto_no_encontrado_por_nombre');
        continue;
      end if;

      if v_coincidencias > 1 then
        v_rechazados := v_rechazados + 1;
        v_log := v_log || jsonb_build_object('nombre', v_nombre, 'motivo', 'nombre_ambiguo');
        continue;
      end if;

      if v_producto_id = any (v_vistos_productos) then
        v_rechazados := v_rechazados + 1;
        v_log := v_log || jsonb_build_object('nombre', v_nombre, 'motivo', 'nombre_duplicado_en_archivo');
        continue;
      end if;
      v_vistos_productos := array_append(v_vistos_productos, v_producto_id);

      update public.productos set
        concentracion = coalesce(v_concentracion, concentracion),
        contenido = coalesce(v_contenido, contenido),
        unidad = coalesce(v_unidad, unidad),
        forma = coalesce(v_forma, forma),
        principio_activo = coalesce(v_principio_activo, principio_activo),
        categoria = coalesce(v_categoria, categoria)
      where id = v_producto_id;

      insert into public.productos_empresa (empresa_id, producto_id, costo, precio, codigo_proveedor)
      values (v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor)
      on conflict (empresa_id, producto_id) do update
        set costo = coalesce(excluded.costo, public.productos_empresa.costo),
            precio = coalesce(excluded.precio, public.productos_empresa.precio),
            codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor);

      v_actualizados := v_actualizados + 1;
      continue;
    end if;

    -- Con código de barra: camino de Fase 2, con el laboratorio resuelto
    -- por fila en vez de uno solo fijo para todo el lote.
    if v_codigo_norm = any (v_vistos) then
      v_rechazados := v_rechazados + 1;
      v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'codigo_duplicado_en_archivo');
      continue;
    end if;
    v_vistos := array_append(v_vistos, v_codigo_norm);

    if v_laboratorio_nombre is null then
      v_rechazados := v_rechazados + 1;
      v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'laboratorio_no_definido');
      continue;
    end if;

    insert into public.laboratorios (nombre) values (v_laboratorio_nombre)
    on conflict (nombre) do update set nombre = excluded.nombre
    returning id into v_laboratorio_id;

    select cb.producto_id, p.laboratorio_id
    into v_producto_id, v_lab_existente_id
    from public.codigos_barra cb
    join public.productos p on p.id = cb.producto_id
    where cb.codigo_norm = v_codigo_norm;

    if v_producto_id is null then
      insert into public.productos (
        nombre, laboratorio_id, concentracion, contenido, unidad, forma,
        principio_activo, categoria, origen
      )
      values (
        coalesce(v_nombre, 'Sin nombre'), v_laboratorio_id, v_concentracion,
        v_contenido, v_unidad, v_forma, v_principio_activo, v_categoria, 'importado'
      )
      returning id into v_producto_id;

      insert into public.codigos_barra (producto_id, codigo_norm, codigo_raw, es_principal)
      values (v_producto_id, v_codigo_norm, v_codigo_raw, true);

      insert into public.productos_empresa (empresa_id, producto_id, costo, precio, codigo_proveedor)
      values (v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor)
      on conflict (empresa_id, producto_id) do update
        set costo = excluded.costo, precio = excluded.precio, codigo_proveedor = excluded.codigo_proveedor;

      v_creados := v_creados + 1;

    elsif v_lab_existente_id is null or v_lab_existente_id = v_laboratorio_id then
      update public.productos set
        nombre = coalesce(v_nombre, nombre),
        laboratorio_id = coalesce(laboratorio_id, v_laboratorio_id),
        concentracion = coalesce(v_concentracion, concentracion),
        contenido = coalesce(v_contenido, contenido),
        unidad = coalesce(v_unidad, unidad),
        forma = coalesce(v_forma, forma),
        principio_activo = coalesce(v_principio_activo, principio_activo),
        categoria = coalesce(v_categoria, categoria)
      where id = v_producto_id;

      insert into public.productos_empresa (empresa_id, producto_id, costo, precio, codigo_proveedor)
      values (v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor)
      on conflict (empresa_id, producto_id) do update
        set costo = coalesce(excluded.costo, public.productos_empresa.costo),
            precio = coalesce(excluded.precio, public.productos_empresa.precio),
            codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor);

      v_actualizados := v_actualizados + 1;

    else
      v_rechazados := v_rechazados + 1;
      v_log := v_log || jsonb_build_object(
        'codigo_barra', v_codigo_raw,
        'motivo', 'ya_pertenece_a_otro_laboratorio',
        'producto_id', v_producto_id
      );
    end if;
  end loop;

  update public.importaciones
  set filas_ok = filas_ok + v_creados + v_actualizados,
      filas_error = filas_error + v_rechazados,
      log = coalesce(log, '[]'::jsonb) || v_log
  where id = p_importacion_id;

  return json_build_object(
    'creados', v_creados,
    'actualizados', v_actualizados,
    'rechazados', v_rechazados
  );
end;
$$;
