-- Gap detectado al analizar listas de precios reales de proveedores para
-- probar el importador (ver docs/decisiones.md): varios archivos traían
-- columnas que el sistema no tenía dónde guardar. Dos campos nuevos:
--
-- 1) productos.categoria: la "línea" comercial que algunos proveedores
--    usan para clasificar sus propios productos (ej. la lista de un
--    proveedor trae "IFA GENERICO" / "PROMOCION" / "BONAPHARM"). Texto
--    libre, sin vocabulario controlado — cada proveedor usa el suyo y no
--    hay un catálogo cerrado de categorías que definir todavía.
-- 2) productos_empresa.codigo_proveedor: el código con el que la empresa
--    identifica el producto ante su proveedor (o en su sistema anterior).
--    Va en productos_empresa y no en productos por el mismo motivo que
--    costo/precio: es un dato de la relación empresa-producto, no del
--    catálogo global — dos empresas pueden usar códigos distintos (o
--    tener cuentas con proveedores distintos) para el mismo producto.

alter table productos add column categoria text;
alter table productos_empresa add column codigo_proveedor text;

-- Reemplaza confirmar_importacion_lote (Fase 2, 20260806000004) para que
-- el importador masivo también persista principio_activo (columna ya
-- existente en productos, pero el RPC nunca la leía de p_filas — el ABM
-- manual sí la tenía) además de los dos campos nuevos de arriba.
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
    v_principio_activo := v_item ->> 'principio_activo';
    v_categoria := v_item ->> 'categoria';
    v_codigo_proveedor := v_item ->> 'codigo_proveedor';

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
