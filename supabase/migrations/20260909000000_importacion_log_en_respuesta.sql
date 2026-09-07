-- El detalle de las filas rechazadas viaja de vuelta al que importa.
--
-- El agujero que tapa esta migración: una farmacia importó su catálogo y
-- el wizard (apps/admin/app/(app)/importar/) le cerró con "149 creados, 0
-- actualizados, 1 rechazados" y nada más. Ni qué fila, ni por qué. La
-- persona que tiene que corregir la planilla se queda mirando 150 filas
-- sin saber cuál de todas quedó afuera, y tampoco hay pantalla donde ir a
-- buscarlo después.
--
-- Lo irónico es que el dato SIEMPRE existió: `confirmar_importacion_lote`
-- viene armando `v_log` desde 20260806000004 — un objeto por rechazo, con
-- el código de barra (o el nombre, cuando la fila se emparejaba por
-- nombre) y un `motivo` de los 6 posibles — y lo guarda intacto en
-- `importaciones.log` al final de cada lote. Lo único que faltaba era
-- devolverlo: el `json_build_object` final solo mandaba los 3 contadores,
-- así que el cliente recibía el "1 rechazados" sin el porqué que la base
-- ya había escrito una línea más arriba.
--
-- CREATE OR REPLACE con el cuerpo IDÉNTICO al de 20260813000009. El único
-- cambio es la clave 'log' en el return. A propósito NO se toca:
--   * ninguna de las 6 condiciones de rechazo — esto expone el motivo que
--     ya se calculaba, no cambia cuándo algo se rechaza;
--   * la persistencia a importaciones.log/filas_ok/filas_error, que ya
--     era correcta;
--   * la lógica de alta/actualización ni el auto-tag por sucursal.
--
-- El return es POR LOTE (el wizard trocea de a TAMANO_LOTE_IMPORTACION
-- filas y llama una vez por lote), así que quien llama tiene que
-- concatenar los `log` de todos los lotes igual que ya suma los
-- contadores — `importaciones.log` es el acumulado del archivo entero, el
-- return no.
--
-- Los 6 valores de `motivo` que puede traer el arreglo, y qué campo
-- identificatorio acompaña a cada uno (esto es el contrato que traduce la
-- UI a castellano, ver importador.tsx):
--   codigo_invalido                   → codigo_barra. Fila sin código de
--                                       barra utilizable y sin nombre: no
--                                       hay por dónde agarrarla.
--   producto_no_encontrado_por_nombre → nombre. Sin código de barra solo
--                                       se actualiza, nunca se crea.
--   nombre_ambiguo                    → nombre. El nombre coincide con más
--                                       de un producto del catálogo.
--   nombre_duplicado_en_archivo       → nombre. Dos filas del mismo archivo
--                                       apuntan al mismo producto.
--   codigo_duplicado_en_archivo       → codigo_barra. El mismo código
--                                       aparece dos veces en el archivo.
--   ya_pertenece_a_otro_laboratorio   → codigo_barra + producto_id. El
--                                       código ya está registrado bajo otro
--                                       laboratorio; pisarlo sería
--                                       reasignar el producto de otro.

create or replace function confirmar_importacion_lote(p_importacion_id uuid, p_laboratorio text, p_filas jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_empresa_id uuid := public.mi_empresa_id();
  v_sucursal_ids uuid[];
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

  select sucursal_ids into v_sucursal_ids
  from public.importaciones
  where id = p_importacion_id and empresa_id = v_empresa_id;

  if not found then
    raise exception 'Importación % no existe para esta empresa', p_importacion_id;
  end if;
  v_sucursal_ids := coalesce(v_sucursal_ids, '{}'::uuid[]);

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

      insert into public.productos_sucursales (empresa_id, producto_id, sucursal_id)
      select v_empresa_id, v_producto_id, sid from unnest(v_sucursal_ids) as sid
      on conflict do nothing;

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

      insert into public.productos_sucursales (empresa_id, producto_id, sucursal_id)
      select v_empresa_id, v_producto_id, sid from unnest(v_sucursal_ids) as sid
      on conflict do nothing;

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

      insert into public.productos_sucursales (empresa_id, producto_id, sucursal_id)
      select v_empresa_id, v_producto_id, sid from unnest(v_sucursal_ids) as sid
      on conflict do nothing;

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

  -- Lo único que cambia respecto de 20260813000009: 'log'. Siempre es un
  -- arreglo (arranca en '[]'), nunca null, así que el cliente puede
  -- concatenarlo sin defenderse.
  return json_build_object(
    'creados', v_creados,
    'actualizados', v_actualizados,
    'rechazados', v_rechazados,
    'log', v_log
  );
end;
$$;
