-- Cuando el operario escanea, DURANTE UN CONTEO FÍSICO (apps/conteo), un
-- producto que YA está en el catálogo pero al que le faltan datos que esa
-- farmacia considera obligatorios, la app lo frena y le pide esos datos
-- antes de contarlo. Una sola vez por producto en todo el sistema: apenas
-- se completan, se escriben en `productos` / `productos_empresa`, que son
-- globales / por empresa — no hace falta ninguna tabla de "ya se preguntó",
-- el dato completo ES la marca de que ya se preguntó.
--
-- "Qué datos son obligatorios" NO es una lista nueva: es la MISMA
-- `empresas.config.campos_requeridos_importacion` que ya se edita hoy en
-- Configuración → "Campos obligatorios al importar" (20260813000007) y que
-- hasta ahora solo miraba el importador de CSV.
--
-- Esta migración trae 4 cosas:
--   a) marca / accionTerapeutica / especialidad entran al whitelist de
--      actualizar_config_operativa_empresa.
--   b) confirmar_importacion_lote aprende a escribir esas 3 columnas.
--   c) datos_completitud_catalogo_conteo: lo que apps/conteo necesita
--      bajarse para poder decidir OFFLINE si a un producto le falta algo.
--   d) completar_datos_producto: la escritura que hace el popup.

-- ═══════════════════════════════════════════════════════════════
-- a) marca / accionTerapeutica / especialidad como campos del sistema
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE con el cuerpo de 20260813000007 intacto salvo por los
-- 3 strings nuevos del whitelist. Sin esto, tildar "Marca" en la pantalla
-- de configuración explotaría con "Campo de importación desconocido".
create or replace function actualizar_config_operativa_empresa(
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
      'fabricante', 'distribuidor', 'loteCatalogo', 'loteCatalogo2',
      'marca', 'accionTerapeutica', 'especialidad'
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
-- b) El importador escribe marca / accion_terapeutica / especialidad
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE con el cuerpo de
-- 20260916000000_importacion_fila_rota_no_tumba_el_lote.sql — la versión
-- viva, la de los savepoints por fila. Lo único que cambia es que los 3
-- caminos de escritura (sin código de barra / alta con código /
-- actualización con código) leen 3 keys más del jsonb y las escriben en
-- `productos`, con el mismo coalesce(v_x, x) de siempre: nunca pisan un
-- dato ya cargado con un blanco.
--
-- A propósito NO se toca nada más: ni los 6 rechazos con nombre propio,
-- ni los bloques begin/exception (el savepoint implícito por fila, que es
-- lo que evita que una celda rota se lleve puesto el lote entero), ni la
-- persistencia a importaciones.log.
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
  v_marca text;
  v_accion_terapeutica text;
  v_especialidad text;
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
    v_marca := v_item ->> 'marca';
    v_accion_terapeutica := v_item ->> 'accion_terapeutica';
    v_especialidad := v_item ->> 'especialidad';
    v_laboratorio_nombre := nullif(coalesce(nullif(v_item ->> 'laboratorio', ''), p_laboratorio), '');

    -- Estos begin/exception chicos atajan el CASTEO (un "s/d" en la
    -- columna costo no es un numeric) y lo vuelven null. Lo que NO
    -- atajan es el INSERT posterior: un número que castea bien pero no
    -- entra en numeric(14, 4) pasa por acá sin chistar y explota más
    -- abajo. De ahí los bloques anidados de las escrituras.
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

      -- Desde acá la fila ya pasó los 4 chequeos de esta rama y va a
      -- escribir. Savepoint implícito: si alguno de los 3 statements
      -- revienta (típicamente el upsert a productos_empresa, por costo o
      -- precio fuera de numeric(14, 4)), se revierte SOLO esta fila —
      -- los 3 statements juntos, así que no queda a medio escribir— y el
      -- loop sigue con la siguiente. El lote entero ya no se cae.
      begin
        update public.productos set
          concentracion = coalesce(v_concentracion, concentracion),
          contenido = coalesce(v_contenido, contenido),
          unidad = coalesce(v_unidad, unidad),
          forma = coalesce(v_forma, forma),
          principio_activo = coalesce(v_principio_activo, principio_activo),
          categoria = coalesce(v_categoria, categoria),
          fabricante = coalesce(v_fabricante, fabricante),
          marca = coalesce(v_marca, marca),
          accion_terapeutica = coalesce(v_accion_terapeutica, accion_terapeutica),
          especialidad = coalesce(v_especialidad, especialidad)
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
      exception when others then
        -- Esta rama emparejó la fila por NOMBRE (no traía código), así
        -- que el identificador que le sirve a quien mira su planilla es
        -- el nombre — el mismo campo que usan los rechazos de acá
        -- arriba. `detalle` lleva el error crudo de Postgres: es lo
        -- único que distingue un overflow de numeric de cualquier otra
        -- sorpresa. Ojo: nada de `raise` — re-lanzar acá volvería a
        -- tumbar el lote, que es exactamente lo que vinimos a arreglar.
        v_rechazados := v_rechazados + 1;
        v_log := v_log || jsonb_build_object(
          'nombre', v_nombre,
          'motivo', 'error_inesperado',
          'detalle', sqlstate || ': ' || sqlerrm
        );
      end;
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

    -- Mismo savepoint que en la rama sin código, pero envolviendo el
    -- if/elsif/else entero. Las dos primeras ramas escriben (alta nueva
    -- y actualización) y por eso necesitan la red; la tercera
    -- ('ya_pertenece_a_otro_laboratorio') es un rechazo esperado que no
    -- toca ninguna tabla, así que pasa por acá sin que el handler la
    -- vea nunca. Envolver las tres juntas evita duplicar el mismo
    -- bloque dos veces y deja intacta la lógica de las ramas.
    begin
      if v_producto_id is null then
        insert into public.productos (
          nombre, laboratorio_id, concentracion, contenido, unidad, forma,
          principio_activo, categoria, fabricante, marca, accion_terapeutica,
          especialidad, origen
        )
        values (
          coalesce(v_nombre, 'Sin nombre'), v_laboratorio_id, v_concentracion,
          v_contenido, v_unidad, v_forma, v_principio_activo, v_categoria, v_fabricante,
          v_marca, v_accion_terapeutica, v_especialidad, 'importado'
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
          fabricante = coalesce(v_fabricante, fabricante),
          marca = coalesce(v_marca, marca),
          accion_terapeutica = coalesce(v_accion_terapeutica, accion_terapeutica),
          especialidad = coalesce(v_especialidad, especialidad)
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
    exception when others then
      -- Acá la fila sí traía código de barra, así que el identificador
      -- que se guarda es el código —igual que los otros rechazos de esta
      -- rama—, no el nombre. Si la que falló fue el alta nueva, el
      -- savepoint revierte también el producto y su código de barra
      -- recién insertados: no queda un producto huérfano sin precio.
      v_rechazados := v_rechazados + 1;
      v_log := v_log || jsonb_build_object(
        'codigo_barra', v_codigo_raw,
        'motivo', 'error_inesperado',
        'detalle', sqlstate || ': ' || sqlerrm
      );
    end;
  end loop;

  update public.importaciones
  set filas_ok = filas_ok + v_creados + v_actualizados,
      filas_error = filas_error + v_rechazados,
      log = coalesce(log, '[]'::jsonb) || v_log
  where id = p_importacion_id;

  return json_build_object(
    'creados', v_creados,
    'actualizados', v_actualizados,
    'rechazados', v_rechazados,
    'log', v_log
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- EL SUBCONJUNTO "COMPLETABLE DESDE CONTEO"
-- ═══════════════════════════════════════════════════════════════
-- De los campos de CAMPOS_SISTEMA, estos 14 son los únicos que el popup
-- de apps/conteo puede pedir y este archivo puede escribir:
--
--   productos (global):          principioActivo, categoria, laboratorio,
--                                fabricante, marca, accionTerapeutica,
--                                especialidad, concentracion, contenido,
--                                unidad
--   productos_empresa (empresa): codigoProveedor, distribuidor,
--                                loteCatalogo, loteCatalogo2
--
-- Quedan afuera A PROPÓSITO, y esto no es negociable ni configurable:
--
--   * costo y precio — CONTEXTO.md regla 1/3. El operario no ve ni
--     escribe precios, punto. Aunque una empresa los tenga tildados en
--     "campos obligatorios al importar" (que es legítimo: ahí SÍ
--     aplican), acá se ignoran. La defensa es estructural y está
--     repetida a tres niveles: no están en este whitelist, no están en
--     el whitelist gemelo de TS (apps/conteo/lib/campos-obligatorios.ts)
--     y ninguna de las dos funciones de abajo SELECCIONA esas columnas,
--     así que no hay forma de que un valor de costo o precio salga de la
--     base hacia un dispositivo de conteo por este camino.
--   * codigoBarra y unidadesPorCodigo — no son "un dato que le falta al
--     producto": el producto se encontró JUSTAMENTE por su código de
--     barras, y unidades_por_codigo es un multiplicador por código que
--     vale 1 por default, no un campo vacío.
--
-- SINCRONIZACIÓN MANUAL: este listado aparece dos veces en este archivo
-- (una por función) y una tercera en TS, en CAMPOS_COMPLETABLES_CONTEO
-- (apps/conteo/lib/campos-obligatorios.ts). Los tres tienen que decir lo
-- mismo — si no, el cliente marca como incompleto algo que el servidor no
-- deja completar (popup infinito) o al revés. Mismo tipo de obligación
-- que ya documenta campos-sistema.ts para el whitelist de
-- actualizar_config_operativa_empresa.

-- ═══════════════════════════════════════════════════════════════
-- c) Lo que apps/conteo se baja para decidir OFFLINE
-- ═══════════════════════════════════════════════════════════════
-- El chequeo "¿a este producto le falta algo?" corre en el camino
-- caliente del escaneo, que es 100% local (IndexedDB, presupuesto de
-- <100ms, sin red). Para que eso sea posible, el dispositivo necesita dos
-- cosas al empezar el conteo: la lista de campos obligatorios de su
-- empresa, y los campos de productos_empresa (que no vienen en el join de
-- codigos_barra → productos).
--
-- POR QUÉ ESTO TIENE QUE SER UN RPC SECURITY DEFINER Y NO UN SELECT:
--
--   1. `productos_empresa` es INVISIBLE para un operario. La policy
--      productos_empresa_select (20260806000001) dice literalmente
--      `empresa_id = mi_empresa_id() and mi_rol() <> 'operario'`, y el
--      comentario de al lado explica por qué: es la barrera de costo/
--      precio, puesta en la base y no en el frontend. Un `.select()`
--      desde apps/conteo no devuelve error, devuelve CERO FILAS — o sea
--      que codigo_proveedor/distribuidor/lote_catalogo se verían siempre
--      vacíos y el popup se dispararía para siempre en todos los
--      productos. Bajar la policy para dejar leer sería abrir costo y
--      precio al dispositivo del operario: exactamente lo prohibido.
--      Un RPC SECURITY DEFINER que devuelve 4 columnas elegidas a mano
--      resuelve el acceso sin tocar la barrera.
--   2. `empresas.config` sí lo puede leer un operario (empresas_select),
--      pero ese jsonb también guarda n8n_webhook_secret (20260806000006).
--      Traerse la columna entera al IndexedDB de un teléfono para sacarle
--      una lista de strings sería filtrar un secreto de integración de
--      arrastre. Acá se devuelve SOLO la lista, ya filtrada.
--
-- Pagina igual que la descarga de codigos_barra (p_offset/p_limit, mismo
-- TAMANO_PAGINA de 1000 del cliente). Si la empresa no tiene NINGÚN campo
-- obligatorio de productos_empresa, devuelve filas vacías y total 0: no
-- tiene sentido bajar miles de filas que nadie va a mirar.
create function datos_completitud_catalogo_conteo(
  p_offset integer default 0,
  p_limit integer default 1000
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Ver "EL SUBCONJUNTO COMPLETABLE DESDE CONTEO" arriba. NUNCA agregar
  -- 'costo' ni 'precio' acá.
  v_campos_completables text[] := array[
    'principioActivo', 'categoria', 'laboratorio', 'fabricante',
    'marca', 'accionTerapeutica', 'especialidad',
    'concentracion', 'contenido', 'unidad',
    'codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2'
  ];
  -- Los 4 que viven en productos_empresa: si ninguno está en la lista de
  -- obligatorios de esta empresa, no hace falta bajar nada de esa tabla.
  v_campos_empresa text[] := array[
    'codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2'
  ];
  v_empresa_id uuid := public.mi_empresa_id();
  v_config_campos jsonb;
  v_requeridos text[];
  v_necesita_empresa boolean;
  v_total integer := 0;
  v_filas json := '[]'::json;
begin
  -- Cualquier perfil con rol: esto lo llama el operario que está contando.
  -- No hay nada sensible que devolver (ni precios ni el config crudo), y
  -- todo sale filtrado por mi_empresa_id(), nunca por un id del cliente.
  if public.mi_rol() is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;
  if v_empresa_id is null then
    raise exception 'El perfil no tiene empresa asignada';
  end if;

  -- La lista cruda de la empresa, filtrada al subconjunto completable: un
  -- 'costo' o un 'precio' tildados en la configuración del importador son
  -- legítimos ahí, pero acá se caen en este filtro y nunca llegan al
  -- dispositivo.
  select coalesce(e.config -> 'campos_requeridos_importacion', '[]'::jsonb)
  into v_config_campos
  from public.empresas e
  where e.id = v_empresa_id;

  if v_config_campos is null or jsonb_typeof(v_config_campos) <> 'array' then
    v_config_campos := '[]'::jsonb;
  end if;

  select coalesce(array_agg(c), array[]::text[])
  into v_requeridos
  from jsonb_array_elements_text(v_config_campos) as c
  where c = any (v_campos_completables);

  v_necesita_empresa := v_requeridos && v_campos_empresa;

  if v_necesita_empresa then
    select count(*) into v_total
    from public.productos_empresa pe
    where pe.empresa_id = v_empresa_id;

    -- Solo 4 columnas + el id, elegidas a mano. costo/precio/
    -- precio_blister/precio_unidad ni se nombran: no hay forma de que
    -- salgan por acá.
    select coalesce(json_agg(f order by f.producto_id), '[]'::json)
    into v_filas
    from (
      select pe.producto_id,
             pe.codigo_proveedor,
             pe.distribuidor,
             pe.lote_catalogo,
             pe.lote_catalogo_2
      from public.productos_empresa pe
      where pe.empresa_id = v_empresa_id
      order by pe.producto_id
      offset greatest(coalesce(p_offset, 0), 0)
      limit least(greatest(coalesce(p_limit, 1000), 1), 1000)
    ) f;
  end if;

  return json_build_object(
    'campos_requeridos', to_json(v_requeridos),
    'total_productos_empresa', v_total,
    'filas', v_filas
  );
end;
$$;

comment on function datos_completitud_catalogo_conteo(integer, integer) is
  'Lo que apps/conteo necesita para decidir OFFLINE si a un producto le faltan datos obligatorios: la lista de campos obligatorios de la empresa (ya filtrada al subconjunto completable) y los 4 campos NO-PRECIO de productos_empresa, paginados. SECURITY DEFINER porque productos_empresa es invisible para un operario a propósito (barrera de costo/precio). Nunca devuelve costo ni precio.';

-- ═══════════════════════════════════════════════════════════════
-- d) La escritura del popup
-- ═══════════════════════════════════════════════════════════════
-- Llamada con p_campos = '{}' es una LECTURA pura: no escribe nada y
-- devuelve los valores actuales. apps/conteo la usa así justo antes de
-- abrir el popup, para calcular qué falta contra el dato fresco del
-- servidor en vez de contra el snapshot local (que puede tener horas).
--
-- Con campos adentro, escribe. Tres reglas:
--
--   1. RE-VALIDACIÓN SERVER-SIDE de cada key contra (a) el subconjunto
--      completable de arriba y (b) la lista de obligatorios REAL de esta
--      empresa, leída de la base — nunca la que diga el cliente. Una key
--      que no pasa se ignora en silencio en vez de tumbar la llamada: que
--      una versión vieja de la app mande una key de más no tiene por qué
--      hacer perder los datos que el operario sí cargó bien.
--   2. SOLO LLENA HUECOS: `coalesce(columna, nuevo)`, no
--      `coalesce(nuevo, columna)`. Esto no es un editor de productos —
--      es "completar lo que falta". Un operario no puede pisar un dato
--      que ya estaba cargado, ni por error ni a propósito.
--   3. Rol: cualquier perfil con rol, operarios incluidos. Es la
--      excepción deliberada al "solo admin/gerente edita catálogo", y es
--      angosta: 14 campos de texto, solo sobre huecos, solo los que la
--      empresa declaró obligatorios, y ninguno es un precio. Mismo
--      criterio que crear_producto_y_contar, que ya deja a un operario
--      dar de alta un producto entero durante un conteo.
--
-- Requiere conexión, igual que crear_producto_y_contar: es una llamada
-- directa, no se encola para sincronizar después. El cliente frena el
-- escaneo si no hay red.
create function completar_datos_producto(p_producto_id uuid, p_campos jsonb default '{}'::jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Gemelo exacto del de datos_completitud_catalogo_conteo y de
  -- CAMPOS_COMPLETABLES_CONTEO en TS. Sin 'costo' ni 'precio', nunca.
  v_campos_completables text[] := array[
    'principioActivo', 'categoria', 'laboratorio', 'fabricante',
    'marca', 'accionTerapeutica', 'especialidad',
    'concentracion', 'contenido', 'unidad',
    'codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2'
  ];
  v_empresa_id uuid := public.mi_empresa_id();
  v_config_campos jsonb;
  v_requeridos text[];
  v_clave text;
  v_valor text;
  v_aceptados text[] := '{}';
  v_laboratorio_id uuid;
  v_contenido numeric;
  v_resultado json;
begin
  if public.mi_rol() is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;
  if v_empresa_id is null then
    raise exception 'El perfil no tiene empresa asignada';
  end if;

  if not exists (select 1 from public.productos where id = p_producto_id) then
    raise exception 'Producto % no existe', p_producto_id;
  end if;

  -- La lista de obligatorios REAL de la empresa, leída de la base (jamás
  -- la que mande el cliente), ya filtrada al subconjunto completable: si
  -- la empresa tiene 'costo' tildado, se cae acá y no existe para el
  -- resto de esta función.
  select coalesce(e.config -> 'campos_requeridos_importacion', '[]'::jsonb)
  into v_config_campos
  from public.empresas e
  where e.id = v_empresa_id;

  if v_config_campos is null or jsonb_typeof(v_config_campos) <> 'array' then
    v_config_campos := '[]'::jsonb;
  end if;

  select coalesce(array_agg(c), array[]::text[])
  into v_requeridos
  from jsonb_array_elements_text(v_config_campos) as c
  where c = any (v_campos_completables);

  -- Qué keys se aceptan: las que están en el subconjunto completable Y en
  -- la lista de obligatorios de la empresa Y traen un valor no vacío. El
  -- resto cae acá, en silencio.
  if p_campos is not null and jsonb_typeof(p_campos) = 'object' then
    for v_clave, v_valor in select key, value from jsonb_each_text(p_campos)
    loop
      if v_clave = any (v_campos_completables)
         and v_clave = any (v_requeridos)
         and nullif(trim(coalesce(v_valor, '')), '') is not null then
        v_aceptados := array_append(v_aceptados, v_clave);
      end if;
    end loop;
  end if;

  if array_length(v_aceptados, 1) > 0 then
    -- `laboratorio` llega como NOMBRE y no como id, igual que en
    -- crear_producto_y_contar: quien llama puede ser un operario, que no
    -- tiene INSERT sobre `laboratorios` (RLS lo reserva a admin/gerente/
    -- superadmin). Se resuelve acá adentro, que siendo SECURITY DEFINER
    -- no choca con esa policy.
    if 'laboratorio' = any (v_aceptados) then
      insert into public.laboratorios (nombre)
      values (trim(p_campos ->> 'laboratorio'))
      on conflict (nombre) do update set nombre = excluded.nombre
      returning id into v_laboratorio_id;
    end if;

    -- `contenido` es numeric: si lo que tipearon no castea, se descarta
    -- esta key sola (v_contenido queda null y el coalesce de abajo la
    -- vuelve un no-op), no se cae la llamada entera.
    if 'contenido' = any (v_aceptados) then
      begin
        v_contenido := trim(p_campos ->> 'contenido')::numeric;
      exception when others then
        v_contenido := null;
      end;
    end if;

    -- coalesce(columna, nuevo): si la columna YA tiene algo, gana lo que
    -- ya estaba. Ver regla 2 arriba.
    update public.productos set
      principio_activo = case when 'principioActivo' = any (v_aceptados)
        then coalesce(principio_activo, trim(p_campos ->> 'principioActivo')) else principio_activo end,
      categoria = case when 'categoria' = any (v_aceptados)
        then coalesce(categoria, trim(p_campos ->> 'categoria')) else categoria end,
      laboratorio_id = case when v_laboratorio_id is not null
        then coalesce(laboratorio_id, v_laboratorio_id) else laboratorio_id end,
      fabricante = case when 'fabricante' = any (v_aceptados)
        then coalesce(fabricante, trim(p_campos ->> 'fabricante')) else fabricante end,
      marca = case when 'marca' = any (v_aceptados)
        then coalesce(marca, trim(p_campos ->> 'marca')) else marca end,
      accion_terapeutica = case when 'accionTerapeutica' = any (v_aceptados)
        then coalesce(accion_terapeutica, trim(p_campos ->> 'accionTerapeutica')) else accion_terapeutica end,
      especialidad = case when 'especialidad' = any (v_aceptados)
        then coalesce(especialidad, trim(p_campos ->> 'especialidad')) else especialidad end,
      concentracion = case when 'concentracion' = any (v_aceptados)
        then coalesce(concentracion, trim(p_campos ->> 'concentracion')) else concentracion end,
      contenido = case when v_contenido is not null
        then coalesce(contenido, v_contenido) else contenido end,
      unidad = case when 'unidad' = any (v_aceptados)
        then coalesce(unidad, trim(p_campos ->> 'unidad')) else unidad end
    where id = p_producto_id;

    -- Los 4 de productos_empresa. El upsert es el mismo patrón que usa el
    -- importador; el `do update` también respeta "solo llena huecos".
    -- Ojo: costo/precio ni se nombran en el insert, así que una fila
    -- creada acá nace sin precio — que es lo correcto, este RPC no sabe
    -- nada de precios y no tiene con qué inventarlos.
    if v_aceptados && array['codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2']::text[] then
      insert into public.productos_empresa (
        empresa_id, producto_id, codigo_proveedor, distribuidor, lote_catalogo, lote_catalogo_2
      )
      values (
        v_empresa_id,
        p_producto_id,
        case when 'codigoProveedor' = any (v_aceptados) then trim(p_campos ->> 'codigoProveedor') end,
        case when 'distribuidor' = any (v_aceptados) then trim(p_campos ->> 'distribuidor') end,
        case when 'loteCatalogo' = any (v_aceptados) then trim(p_campos ->> 'loteCatalogo') end,
        case when 'loteCatalogo2' = any (v_aceptados) then trim(p_campos ->> 'loteCatalogo2') end
      )
      on conflict (empresa_id, producto_id) do update
        set codigo_proveedor = coalesce(public.productos_empresa.codigo_proveedor, excluded.codigo_proveedor),
            distribuidor = coalesce(public.productos_empresa.distribuidor, excluded.distribuidor),
            lote_catalogo = coalesce(public.productos_empresa.lote_catalogo, excluded.lote_catalogo),
            lote_catalogo_2 = coalesce(public.productos_empresa.lote_catalogo_2, excluded.lote_catalogo_2);
    end if;
  end if;

  -- Devuelve los valores actuales de los 14 campos completables (global +
  -- el overlay de ESTA empresa) para que el cliente actualice su catálogo
  -- local sin re-descargar nada. `laboratorio` va como nombre, que es lo
  -- que guarda ProductoLocal. Otra vez: ni costo ni precio se nombran.
  select json_build_object(
    'producto_id', p.id,
    'principioActivo', p.principio_activo,
    'categoria', p.categoria,
    'laboratorio', l.nombre,
    'fabricante', p.fabricante,
    'marca', p.marca,
    'accionTerapeutica', p.accion_terapeutica,
    'especialidad', p.especialidad,
    'concentracion', p.concentracion,
    'contenido', p.contenido,
    'unidad', p.unidad,
    'codigoProveedor', pe.codigo_proveedor,
    'distribuidor', pe.distribuidor,
    'loteCatalogo', pe.lote_catalogo,
    'loteCatalogo2', pe.lote_catalogo_2,
    'campos_requeridos', to_json(v_requeridos)
  )
  into v_resultado
  from public.productos p
  left join public.laboratorios l on l.id = p.laboratorio_id
  left join public.productos_empresa pe
    on pe.producto_id = p.id and pe.empresa_id = v_empresa_id
  where p.id = p_producto_id;

  return v_resultado;
end;
$$;

comment on function completar_datos_producto(uuid, jsonb) is
  'Completa los datos obligatorios que le faltan a un producto del catálogo, desde el popup de apps/conteo. Solo llena huecos (nunca pisa un dato existente), solo campos que la empresa declaró obligatorios, y nunca costo ni precio. Con p_campos = ''{}'' es una lectura pura de los valores actuales. Cualquier perfil con rol, operarios incluidos: es la excepción deliberada y angosta al "solo admin/gerente edita catálogo".';
