-- Blister/unidad: `codigos_barra.unidades_por_codigo` existe desde Fase 1
-- (20260806000001_catalogo_conteo.sql) pero nunca se cableó a nada —
-- confirmado por auditoría, cero referencias en toda la app. A pedido
-- del usuario: un código de caja/blíster ahora puede valer más de 1
-- unidad al escanearlo en el conteo (eso se resuelve 100% del lado del
-- cliente, ver apps/conteo/lib/motor-escaneo.ts — acá solo se agrega la
-- forma de CARGAR ese valor por el importador masivo, además del ABM
-- manual que ya lo tiene).
--
-- CREATE OR REPLACE: mismo cuerpo que 20260813000004_importacion_laboratorio_opcional.sql,
-- un solo cambio — el INSERT a codigos_barra (camino "crear producto
-- nuevo por código de barras") suma unidades_por_codigo, leído de la
-- fila si lo trae, default 1 si no. No aplica al camino de actualizar
-- (un código ya existente no cambia su unidades_por_codigo por un
-- reimport — se edita a mano en el ABM si hace falta corregirlo).
--
-- `forma` se mantiene tal cual estaba (columna/parámetro sin uso desde
-- que se sacó de la UI hoy, 20260813 "Catálogo: sacar el campo Forma")
-- a propósito — esa decisión fue explícitamente no tocar la base.
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
  v_unidades_por_codigo integer;
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
    v_unidad := v_item ->> 'unidad';
    v_forma := v_item ->> 'forma';
    v_principio_activo := v_item ->> 'principio_activo';
    v_categoria := v_item ->> 'categoria';
    v_codigo_proveedor := v_item ->> 'codigo_proveedor';
    v_laboratorio_nombre := nullif(coalesce(nullif(v_item ->> 'laboratorio', ''), p_laboratorio), '');

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
    begin
      v_unidades_por_codigo := greatest(1, (v_item ->> 'unidades_por_codigo')::integer);
    exception when others then
      v_unidades_por_codigo := 1;
    end;
    if v_unidades_por_codigo is null then
      v_unidades_por_codigo := 1;
    end if;

    v_codigo_norm := (public.normalizar_codigo(v_codigo_raw)).codigo_norm;

    -- Sin código de barra: actualizar por nombre exacto, nunca crear.
    if v_codigo_norm is null then
      if v_nombre is null then
        v_rechazados := v_rechazados + 1;
        v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'codigo_invalido');
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

    -- Con código de barra.
    if v_codigo_norm = any (v_vistos) then
      v_rechazados := v_rechazados + 1;
      v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'codigo_duplicado_en_archivo');
      continue;
    end if;
    v_vistos := array_append(v_vistos, v_codigo_norm);

    if v_laboratorio_nombre is not null then
      insert into public.laboratorios (nombre) values (v_laboratorio_nombre)
      on conflict (nombre) do update set nombre = excluded.nombre
      returning id into v_laboratorio_id;
    else
      v_laboratorio_id := null;
    end if;

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

      insert into public.codigos_barra (producto_id, codigo_norm, codigo_raw, es_principal, unidades_por_codigo)
      values (v_producto_id, v_codigo_norm, v_codigo_raw, true, v_unidades_por_codigo);

      insert into public.productos_empresa (empresa_id, producto_id, costo, precio, codigo_proveedor)
      values (v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor)
      on conflict (empresa_id, producto_id) do update
        set costo = excluded.costo, precio = excluded.precio, codigo_proveedor = excluded.codigo_proveedor;

      v_creados := v_creados + 1;

    elsif v_laboratorio_id is null or v_lab_existente_id is null or v_lab_existente_id = v_laboratorio_id then
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
