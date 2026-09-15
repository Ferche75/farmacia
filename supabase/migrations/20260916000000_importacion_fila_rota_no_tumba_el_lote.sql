-- Una fila rota ya no se lleva puesto el lote entero.
--
-- El agujero que tapa esta migración: el wizard trocea el archivo de a
-- TAMANO_LOTE_IMPORTACION (500) filas y llama una vez por lote. Cada
-- llamada a `confirmar_importacion_lote` es UNA transacción de Postgres.
-- Adentro, el `for v_item in ...` recorre las 500 filas y ya sabe
-- rechazar con elegancia 6 casos ESPERADOS (código ilegible, nombre que
-- no existe, nombre ambiguo, duplicado en el archivo, laboratorio ajeno):
-- suma a v_rechazados, escribe el motivo en v_log y `continue` a la fila
-- siguiente. Eso funciona bien y acá no se toca nada de eso.
--
-- Lo que NO estaba cubierto es el caso INESPERADO. Los campos numéricos
-- se castean a la defensiva (`(v_item ->> 'costo')::numeric` y compañía
-- ya vienen envueltos en su propio begin/exception que convierte un
-- string basura en null), pero ese escudo protege solamente el CASTEO.
-- No protege el INSERT/UPDATE posterior: `productos_empresa.costo` y
-- `.precio` son numeric(14, 4), y un valor que castea perfecto a numeric
-- sin restricción —un número gigante salido de una fórmula rota de
-- Excel, una coma decimal mal puesta que multiplica por mil, una celda
-- con notación científica— revienta recién al escribirse, con un
-- "numeric field overflow" que nadie estaba atajando.
--
-- Y como esa excepción sube desde adentro del loop hasta fuera de la
-- función, aborta la transacción COMPLETA: las hasta 499 filas sanas que
-- ese mismo lote ya había procesado se van al tacho con ella, y el
-- cliente recibe un único error de Postgres opaco, sin la menor pista de
-- qué fila lo causó. Para una farmacia en Bolivia cargando su planilla
-- de verdad, una sola celda mal formada en cualquier parte del lote
-- significaba hoy todo-o-nada para ese lote.
--
-- La solución: envolver el TRABAJO DE ESCRITURA de cada fila —o sea todo
-- lo que pasa DESPUÉS de que la fila ya pasó los 6 chequeos y está por
-- tocar tablas— en su propio `begin ... exception when others then ...
-- end`. En PL/pgSQL un bloque anidado con handler de excepción es un
-- SAVEPOINT implícito: lo que se atrapa adentro revierte únicamente lo
-- hecho DENTRO de ese bloque, no la transacción que lo rodea. El loop
-- sigue con la fila siguiente y el lote termina normal.
--
-- Eso también responde la pregunta obvia sobre estados a medias: cada
-- secuencia de escritura de una fila son varios statements (update
-- productos + upsert productos_empresa + insert productos_sucursales, o
-- insert productos + codigos_barra + los otros dos). Como el savepoint
-- abarca el bloque ENTERO, si el paso 2 falla también se revierte el
-- paso 1 de esa misma fila: la fila queda sin escribir, entera, nunca
-- por la mitad. No hace falta compensar nada a mano.
--
-- El motivo nuevo que aparece en el log es 'error_inesperado' — el
-- séptimo, y el único que además trae un campo `detalle` con el texto
-- crudo de Postgres (sqlstate + sqlerrm). No es un mensaje para el
-- usuario final: es la pista técnica que permite ir a la celda exacta
-- cuando el texto en castellano no alcanza. La UI lo muestra como
-- renglón secundario (ver apps/admin/lib/motivos-rechazo-importacion.ts).
--
-- IMPORTANTE, y la razón por la que el `when others` está donde está:
-- esto NUNCA debe convertirse en un `when others` alrededor de TODO el
-- loop. Si se envolviera el loop entero, el primer error abortaría el
-- resto de las filas igual que ahora, y peor: taparía los 6 rechazos
-- específicos —que son precisos, explican qué corregir y se calculan
-- ANTES de escribir— detrás de un "error_inesperado" genérico. El
-- alcance es deliberadamente mínimo: solo el paso de escritura, solo de
-- una fila, y solo después de que todos los chequeos con nombre propio
-- ya dijeron que sí.
--
-- CREATE OR REPLACE con el cuerpo de 20260909000000 intacto salvo por
-- esos dos bloques anidados (el de la ruta sin código de barra y el de
-- la ruta con código, que cubre sus dos ramas de escritura). A propósito
-- NO se toca: las 6 condiciones de rechazo, la persistencia a
-- importaciones.log/filas_ok/filas_error, ni el return por lote.

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
