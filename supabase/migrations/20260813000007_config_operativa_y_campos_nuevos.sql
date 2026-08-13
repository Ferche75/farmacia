-- Dos pedidos del usuario que comparten el mismo mecanismo de fondo
-- (ajustes operativos por empresa, editables por admin/gerente desde
-- /configuracion) y por eso se resuelven con un solo RPC:
--   1) Semáforo de vencimiento editable (rojo/amarillo/verde, default
--      1/3/6 meses = 30/90/180 días) en vez de los 90/180 fijos que
--      usan hoy /vencimientos y /productos. A propósito NO se toca
--      resumen_conteo — sus contadores vencimientos_menos_90_dias/
--      _180_dias son una métrica de reporte gerencial ya cerrada, no
--      el semáforo visual que se pidió cambiar; tocarlos cambiaría el
--      significado de reportes ya generados.
--   2) Qué campos del importador son obligatorios para esta empresa en
--      particular (hoy es fijo en código, solo "nombre").
--
-- Se guarda en empresas.config (jsonb), mismo lugar que ya usa el
-- webhook de n8n — pero NO con el patrón de actualizarConfigN8n
-- (lectura + spread merge en JS), que solo funciona para superadmin
-- porque ese rol ya tiene UPDATE completo sobre `empresas`. admin/
-- gerente no tiene ese grant, así que el merge se hace acá adentro, en
-- SQL, con el operador `||` de jsonb — primera vez que se usa este
-- patrón en el proyecto, mismo criterio de seguridad que ya usa
-- actualizar_datos_contacto_empresa (SECURITY DEFINER, opera sobre
-- mi_empresa_id(), nunca un id que mande el cliente).

create function actualizar_config_operativa_empresa(
  p_campos_requeridos_importacion text[],
  p_vencimiento_rojo_dias integer,
  p_vencimiento_amarillo_dias integer,
  p_vencimiento_verde_dias integer
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_empresa_id uuid := public.mi_empresa_id();
begin
  if public.mi_rol() not in ('admin', 'gerente') then
    raise exception 'No autorizado para editar la configuración de la empresa';
  end if;

  if p_vencimiento_rojo_dias is null or p_vencimiento_amarillo_dias is null or p_vencimiento_verde_dias is null then
    raise exception 'Los 3 umbrales de vencimiento son obligatorios';
  end if;
  if p_vencimiento_rojo_dias <= 0
     or not (p_vencimiento_rojo_dias < p_vencimiento_amarillo_dias
             and p_vencimiento_amarillo_dias < p_vencimiento_verde_dias) then
    raise exception 'Los umbrales tienen que ser crecientes y positivos: rojo < amarillo < verde';
  end if;

  -- Mismo listado de "campo" que CAMPOS_SISTEMA en
  -- apps/admin/lib/campos-sistema.ts — si se agrega un campo mapeable
  -- nuevo ahí, hay que sumarlo acá también (no hay generación de
  -- código compartida entre SQL y TS en este proyecto).
  if p_campos_requeridos_importacion is not null and exists (
    select 1 from unnest(p_campos_requeridos_importacion) as c
    where c not in (
      'codigoBarra', 'unidadesPorCodigo', 'concentracion', 'contenido', 'unidad',
      'principioActivo', 'categoria', 'codigoProveedor', 'laboratorio', 'costo', 'precio',
      'fabricante', 'distribuidor', 'loteCatalogo', 'loteCatalogo2'
    )
  ) then
    raise exception 'Campo de importación desconocido en la lista de obligatorios';
  end if;

  update public.empresas
  set config = config || jsonb_build_object(
    'campos_requeridos_importacion', to_jsonb(coalesce(p_campos_requeridos_importacion, array[]::text[])),
    'vencimiento_semaforo', jsonb_build_object(
      'rojo_dias', p_vencimiento_rojo_dias,
      'amarillo_dias', p_vencimiento_amarillo_dias,
      'verde_dias', p_vencimiento_verde_dias
    )
  )
  where id = v_empresa_id;

  return json_build_object('empresa_id', v_empresa_id);
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- Campos nuevos del catálogo: fabricante, distribuidor, lote, lote2
-- ═══════════════════════════════════════════════════════════════
-- `fabricante` es del PRODUCTO (global), mismo criterio que
-- laboratorio_id. `distribuidor`/`lote_catalogo`/`lote_catalogo_2` son
-- de LA RELACIÓN empresa-producto (dos empresas pueden recibir el
-- mismo producto de distribuidores/lotes distintos), mismo criterio
-- que codigo_proveedor.
--
-- Los "lote" se nombran `lote_catalogo`/`lote_catalogo_2` a propósito
-- (no `lote`/`lote2` a secas): son un dato ESTÁTICO que carga el
-- importador/ABM, confirmado explícitamente con el usuario — NO el
-- mismo lote dinámico que ya trackean `escaneos.lote`/la tabla `lotes`
-- por conteo (eso sigue funcionando exactamente igual, sin tocarse).
-- Nombrarlos igual hubiera sido confuso para cualquiera leyendo el
-- esquema más adelante.

alter table productos
  add column fabricante text;

alter table productos_empresa
  add column distribuidor text,
  add column lote_catalogo text,
  add column lote_catalogo_2 text;

-- CREATE OR REPLACE: mismo cuerpo que 20260813000006_unidades_por_codigo_importacion.sql,
-- suma fabricante/distribuidor/lote_catalogo/lote_catalogo_2 a lo que
-- lee de p_filas y escribe, en los 3 caminos (sin código, crear con
-- código, actualizar con código).
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
  v_fabricante text;
  v_distribuidor text;
  v_lote_catalogo text;
  v_lote_catalogo_2 text;
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
    v_fabricante := v_item ->> 'fabricante';
    v_distribuidor := v_item ->> 'distribuidor';
    v_lote_catalogo := v_item ->> 'lote_catalogo';
    v_lote_catalogo_2 := v_item ->> 'lote_catalogo_2';
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
        categoria = coalesce(v_categoria, categoria),
        fabricante = coalesce(v_fabricante, fabricante)
      where id = v_producto_id;

      insert into public.productos_empresa (
        empresa_id, producto_id, costo, precio, codigo_proveedor,
        distribuidor, lote_catalogo, lote_catalogo_2
      )
      values (
        v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor,
        v_distribuidor, v_lote_catalogo, v_lote_catalogo_2
      )
      on conflict (empresa_id, producto_id) do update
        set costo = coalesce(excluded.costo, public.productos_empresa.costo),
            precio = coalesce(excluded.precio, public.productos_empresa.precio),
            codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor),
            distribuidor = coalesce(excluded.distribuidor, public.productos_empresa.distribuidor),
            lote_catalogo = coalesce(excluded.lote_catalogo, public.productos_empresa.lote_catalogo),
            lote_catalogo_2 = coalesce(excluded.lote_catalogo_2, public.productos_empresa.lote_catalogo_2);

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
        principio_activo, categoria, fabricante, origen
      )
      values (
        coalesce(v_nombre, 'Sin nombre'), v_laboratorio_id, v_concentracion,
        v_contenido, v_unidad, v_forma, v_principio_activo, v_categoria, v_fabricante, 'importado'
      )
      returning id into v_producto_id;

      insert into public.codigos_barra (producto_id, codigo_norm, codigo_raw, es_principal, unidades_por_codigo)
      values (v_producto_id, v_codigo_norm, v_codigo_raw, true, v_unidades_por_codigo);

      insert into public.productos_empresa (
        empresa_id, producto_id, costo, precio, codigo_proveedor,
        distribuidor, lote_catalogo, lote_catalogo_2
      )
      values (
        v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor,
        v_distribuidor, v_lote_catalogo, v_lote_catalogo_2
      )
      on conflict (empresa_id, producto_id) do update
        set costo = excluded.costo, precio = excluded.precio, codigo_proveedor = excluded.codigo_proveedor,
            distribuidor = excluded.distribuidor, lote_catalogo = excluded.lote_catalogo,
            lote_catalogo_2 = excluded.lote_catalogo_2;

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
        categoria = coalesce(v_categoria, categoria),
        fabricante = coalesce(v_fabricante, fabricante)
      where id = v_producto_id;

      insert into public.productos_empresa (
        empresa_id, producto_id, costo, precio, codigo_proveedor,
        distribuidor, lote_catalogo, lote_catalogo_2
      )
      values (
        v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor,
        v_distribuidor, v_lote_catalogo, v_lote_catalogo_2
      )
      on conflict (empresa_id, producto_id) do update
        set costo = coalesce(excluded.costo, public.productos_empresa.costo),
            precio = coalesce(excluded.precio, public.productos_empresa.precio),
            codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor),
            distribuidor = coalesce(excluded.distribuidor, public.productos_empresa.distribuidor),
            lote_catalogo = coalesce(excluded.lote_catalogo, public.productos_empresa.lote_catalogo),
            lote_catalogo_2 = coalesce(excluded.lote_catalogo_2, public.productos_empresa.lote_catalogo_2);

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
