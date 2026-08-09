-- Fase 2: funciones RPC del importador de catálogo.
--
-- El commit real (confirmar_importacion_lote) va por RPC en vez de
-- escritura directa de tabla, a diferencia del ABM manual, porque acá SÍ
-- hay una regla de negocio no trivial que hay que garantizar server-side:
-- "si un código ya existe apuntando a otro producto, la fila se rechaza,
-- nunca se pisa silenciosamente" — más el conteo atómico de
-- creados/actualizados/rechazados sobre `importaciones`.
--
-- Regla inferida (no estaba explícita en el spec — documentada en
-- docs/decisiones.md): "apuntando a otro producto" se resuelve por
-- laboratorio. Si el código ya existe y el producto que lo tiene NO tiene
-- laboratorio asignado, o tiene el MISMO laboratorio que se está
-- importando, la fila actualiza ese producto. Si tiene un laboratorio
-- DISTINTO ya asignado, se rechaza. Los imports son siempre "el archivo
-- de un laboratorio", así que el laboratorio es el ancla natural para
-- decidir si es la "misma" línea de producto o un choque real.

create function iniciar_importacion(p_archivo text, p_mapeo jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para importar catálogo';
  end if;

  insert into public.importaciones (empresa_id, archivo, mapeo, estado, creado_por)
  values (public.mi_empresa_id(), p_archivo, p_mapeo, 'procesando', auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- Solo lectura: clasifica TODAS las filas (crear/actualizar/rechazar +
-- motivo) sin escribir nada, para la vista previa y el resumen de
-- confirmación. p_filas ya viene mapeada a los nombres de campo del
-- sistema (codigo_barra, nombre, concentracion, contenido, unidad,
-- forma, costo, precio) — el mapeo de columnas del archivo original a
-- estos nombres se resuelve en el cliente antes de llamar acá.
create function previsualizar_importacion(p_laboratorio text, p_filas jsonb)
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
      (public.normalizar_codigo(f.elem ->> 'codigo_barra')).codigo_norm as codigo_norm
    from jsonb_array_elements(p_filas) with ordinality as f (elem, ordinality)
  ),
  enumeradas as (
    select
      fl.*,
      case when fl.codigo_norm is not null
        then row_number() over (partition by fl.codigo_norm order by fl.fila_index)
        else null
      end as ocurrencia
    from filas fl
  ),
  clasificadas as (
    select
      e.fila_index,
      e.codigo_barra_raw,
      case
        when e.codigo_norm is null then 'rechazar'
        when e.ocurrencia > 1 then 'rechazar'
        when cb.producto_id is null then 'crear'
        when lab.nombre is null or lab.nombre = p_laboratorio then 'actualizar'
        else 'rechazar'
      end as accion,
      case
        when e.codigo_norm is null then 'codigo_invalido'
        when e.ocurrencia > 1 then 'codigo_duplicado_en_archivo'
        when cb.producto_id is not null and lab.nombre is not null and lab.nombre <> p_laboratorio
          then 'ya_pertenece_a_' || lab.nombre
        else null
      end as motivo
    from enumeradas e
    left join public.codigos_barra cb on cb.codigo_norm = e.codigo_norm
    left join public.productos p on p.id = cb.producto_id
    left join public.laboratorios lab on lab.id = p.laboratorio_id
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

-- Escribe de verdad. Se llama una vez por lote de hasta 500 filas (la UI
-- es responsable de trocear el archivo — ver docs/decisiones.md). Re-hace
-- la clasificación acá adentro en vez de confiar en lo que decidió
-- previsualizar_importacion, porque entre la vista previa y la
-- confirmación pudo haber pasado otra importación concurrente.
create function confirmar_importacion_lote(p_importacion_id uuid, p_laboratorio text, p_filas jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_empresa_id uuid := public.mi_empresa_id();
  v_laboratorio_id uuid;
  v_item jsonb;
  v_codigo_raw text;
  v_codigo_norm text;
  v_nombre text;
  v_concentracion text;
  v_contenido numeric;
  v_unidad text;
  v_forma text;
  v_costo numeric;
  v_precio numeric;
  v_producto_id uuid;
  v_lab_existente_id uuid;
  v_creados integer := 0;
  v_actualizados integer := 0;
  v_rechazados integer := 0;
  v_log jsonb := '[]'::jsonb;
  v_vistos text[] := '{}';
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

  insert into public.laboratorios (nombre) values (p_laboratorio)
  on conflict (nombre) do update set nombre = excluded.nombre
  returning id into v_laboratorio_id;

  for v_item in select * from jsonb_array_elements(p_filas)
  loop
    v_codigo_raw := v_item ->> 'codigo_barra';
    v_nombre := v_item ->> 'nombre';
    v_concentracion := v_item ->> 'concentracion';
    v_forma := v_item ->> 'forma';
    v_unidad := v_item ->> 'unidad';

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

    if v_codigo_norm is null then
      v_rechazados := v_rechazados + 1;
      v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'codigo_invalido');
      continue;
    end if;

    if v_codigo_norm = any (v_vistos) then
      v_rechazados := v_rechazados + 1;
      v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'codigo_duplicado_en_archivo');
      continue;
    end if;
    v_vistos := array_append(v_vistos, v_codigo_norm);

    select cb.producto_id, p.laboratorio_id
    into v_producto_id, v_lab_existente_id
    from public.codigos_barra cb
    join public.productos p on p.id = cb.producto_id
    where cb.codigo_norm = v_codigo_norm;

    if v_producto_id is null then
      insert into public.productos (
        nombre, laboratorio_id, concentracion, contenido, unidad, forma, origen
      )
      values (
        coalesce(v_nombre, 'Sin nombre'), v_laboratorio_id, v_concentracion,
        v_contenido, v_unidad, v_forma, 'importado'
      )
      returning id into v_producto_id;

      insert into public.codigos_barra (producto_id, codigo_norm, codigo_raw, es_principal)
      values (v_producto_id, v_codigo_norm, v_codigo_raw, true);

      insert into public.productos_empresa (empresa_id, producto_id, costo, precio)
      values (v_empresa_id, v_producto_id, v_costo, v_precio)
      on conflict (empresa_id, producto_id) do update
        set costo = excluded.costo, precio = excluded.precio;

      v_creados := v_creados + 1;

    elsif v_lab_existente_id is null or v_lab_existente_id = v_laboratorio_id then
      update public.productos set
        nombre = coalesce(v_nombre, nombre),
        laboratorio_id = coalesce(laboratorio_id, v_laboratorio_id),
        concentracion = coalesce(v_concentracion, concentracion),
        contenido = coalesce(v_contenido, contenido),
        unidad = coalesce(v_unidad, unidad),
        forma = coalesce(v_forma, forma)
      where id = v_producto_id;

      insert into public.productos_empresa (empresa_id, producto_id, costo, precio)
      values (v_empresa_id, v_producto_id, v_costo, v_precio)
      on conflict (empresa_id, producto_id) do update
        set costo = coalesce(excluded.costo, public.productos_empresa.costo),
            precio = coalesce(excluded.precio, public.productos_empresa.precio);

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

create function finalizar_importacion(p_importacion_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para importar catálogo';
  end if;

  update public.importaciones
  set estado = 'completado'
  where id = p_importacion_id and empresa_id = public.mi_empresa_id()
  returning * into v_row;

  if not found then
    raise exception 'Importación % no existe para esta empresa', p_importacion_id;
  end if;

  return json_build_object(
    'id', v_row.id,
    'estado', v_row.estado,
    'filas_ok', v_row.filas_ok,
    'filas_error', v_row.filas_error
  );
end;
$$;
