-- Bug real, en producción, encontrado por el dueño en los logs de
-- Supabase: "function max(uuid) does not exist" (42883) al confirmar una
-- importación de catálogo sin código de barra. No es ningún mecanismo de
-- defensa ni un bloqueo intencional — es un error de SQL que viene
-- arrastrándose desde 20260812000001_importacion_multilab_y_sin_codigo.sql
-- (y se repitió en cada CREATE OR REPLACE posterior de esta función,
-- hasta 20260924000000, la última): la rama "sin código de barra" hace
--   select count(*), max(id) into v_coincidencias, v_producto_id
--   from public.productos where lower(nombre) = lower(v_nombre);
-- y `id` es uuid — este Postgres no tiene un agregado max()/min() nativo
-- para ese tipo. Encima ese SELECT queda FUERA del begin/exception que sí
-- envuelve el resto de la rama (líneas de abajo, "Este begin/exception
-- chico..."), así que el error no se atajaba como rechazo de una fila:
-- tumbaba la función RPC entera, y con ella la importación completa —
-- consistente con "se cayó" en vez de "una fila se rechazó".
--
-- Se disparaba solo en el camino SIN código de barra (match por nombre
-- exacto), que es justamente el que usan los archivos de lista de precios
-- que no traen EAN — el que se estaba probando cuando pasó esto.
--
-- Arreglo mínimo: castear a text para el agregado (text sí tiene
-- max/min nativo) y volver a uuid. Sin cambio de comportamiento: cuando
-- v_coincidencias = 1 el valor de max() es trivialmente ese único id sin
-- importar el tipo de orden que use por debajo; cuando es 0 o > 1, el
-- valor de v_producto_id ni se usa (la fila se rechaza antes). CREATE OR
-- REPLACE, mismo contrato — se reproduce el cuerpo completo de
-- 20260924000000_envase_de_compra.sql (la última versión) con esa única
-- línea tocada, mismo patrón que ya usó cada migración anterior que pasó
-- por esta función.
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
  v_envase_compra text;
  v_lote_catalogo text;
  v_lote_catalogo_2 text;
  v_marca text;
  v_accion_terapeutica text;
  v_especialidad text;
  v_costo numeric;
  v_precio numeric;
  -- El precio que YA tiene esta empresa para el producto que la fila está
  -- por actualizar. Se relee por fila; ver el chequeo de 'falta_precio'.
  v_precio_existente numeric;
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
    v_envase_compra := v_item ->> 'envase_compra';
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
    --
    -- Ojo con `precio`: que no castee lo deja en null igual que antes,
    -- pero ahora ese null ya no es inofensivo — lo agarra el chequeo de
    -- 'falta_precio' de más abajo y la fila se rechaza con un motivo
    -- entendible, en vez de entrar y dejar un producto sin precio.
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

      -- FIX (este archivo): max(id) crudo tira "function max(uuid) does
      -- not exist" en este Postgres. max(id::text)::uuid usa el agregado
      -- de text (sí soportado) y vuelve a castear — mismo resultado
      -- quando v_coincidencias = 1, que es el único caso en el que
      -- v_producto_id se termina usando.
      select count(*), max(id::text)::uuid into v_coincidencias, v_producto_id
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

      -- 'falta_precio' (20260923000000). Rama de ACTUALIZACIÓN: mira el
      -- estado final. Sin precio en la fila hay que ir a ver si ya hay uno
      -- guardado para esta empresa; si tampoco, la fila queda afuera. El
      -- reset explícito a null es a propósito: v_precio_existente es una
      -- variable del loop entero y un SELECT INTO sin filas no puede
      -- dejarla con el valor de la fila anterior.
      if v_precio is null then
        v_precio_existente := null;
        select pe.precio into v_precio_existente
        from public.productos_empresa pe
        where pe.empresa_id = v_empresa_id and pe.producto_id = v_producto_id;

        if v_precio_existente is null then
          v_rechazados := v_rechazados + 1;
          v_log := v_log || jsonb_build_object('nombre', v_nombre, 'motivo', 'falta_precio');
          continue;
        end if;
      end if;

      -- Desde acá la fila ya pasó los 5 chequeos de esta rama y va a
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
          distribuidor, envase_compra, lote_catalogo, lote_catalogo_2
        )
        values (
          v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor,
          v_distribuidor, v_envase_compra, v_lote_catalogo, v_lote_catalogo_2
        )
        on conflict (empresa_id, producto_id) do update
          set costo = coalesce(excluded.costo, public.productos_empresa.costo),
              precio = coalesce(excluded.precio, public.productos_empresa.precio),
              codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor),
              distribuidor = coalesce(excluded.distribuidor, public.productos_empresa.distribuidor),
              envase_compra = coalesce(excluded.envase_compra, public.productos_empresa.envase_compra),
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
    -- bloque dos veces y deja intacta la lógica de las ramas. Los dos
    -- rechazos de 'falta_precio' que ahora viven adentro tampoco escriben
    -- nada, así que el handler tampoco los ve: salen por `continue`.
    begin
      if v_producto_id is null then
        -- 'falta_precio' (20260923000000). Rama de ALTA: no hay fila de
        -- productos_empresa contra la que caer, así que decide sólo lo que
        -- trae el archivo. Se rechaza ANTES de tocar ninguna tabla, para
        -- no depender del rollback del savepoint.
        if v_precio is null then
          v_rechazados := v_rechazados + 1;
          v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'falta_precio');
          continue;
        end if;

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
          distribuidor, envase_compra, lote_catalogo, lote_catalogo_2
        )
        values (
          v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor,
          v_distribuidor, v_envase_compra, v_lote_catalogo, v_lote_catalogo_2
        )
        on conflict (empresa_id, producto_id) do update
          set costo = excluded.costo, precio = excluded.precio, codigo_proveedor = excluded.codigo_proveedor,
              distribuidor = excluded.distribuidor, envase_compra = excluded.envase_compra,
              lote_catalogo = excluded.lote_catalogo,
              lote_catalogo_2 = excluded.lote_catalogo_2;

        insert into public.productos_sucursales (empresa_id, producto_id, sucursal_id)
        select v_empresa_id, v_producto_id, sid from unnest(v_sucursal_ids) as sid
        on conflict do nothing;

        v_creados := v_creados + 1;

      elsif v_laboratorio_id is null or v_lab_existente_id is null or v_lab_existente_id = v_laboratorio_id then
        -- 'falta_precio' (20260923000000). Rama de ACTUALIZACIÓN con
        -- código: mismo criterio que la rama sin código — decide el estado
        -- final, no sólo lo que trae la fila.
        if v_precio is null then
          v_precio_existente := null;
          select pe.precio into v_precio_existente
          from public.productos_empresa pe
          where pe.empresa_id = v_empresa_id and pe.producto_id = v_producto_id;

          if v_precio_existente is null then
            v_rechazados := v_rechazados + 1;
            v_log := v_log || jsonb_build_object('codigo_barra', v_codigo_raw, 'motivo', 'falta_precio');
            continue;
          end if;
        end if;

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
          distribuidor, envase_compra, lote_catalogo, lote_catalogo_2
        )
        values (
          v_empresa_id, v_producto_id, v_costo, v_precio, v_codigo_proveedor,
          v_distribuidor, v_envase_compra, v_lote_catalogo, v_lote_catalogo_2
        )
        on conflict (empresa_id, producto_id) do update
          set costo = coalesce(excluded.costo, public.productos_empresa.costo),
              precio = coalesce(excluded.precio, public.productos_empresa.precio),
              codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor),
              distribuidor = coalesce(excluded.distribuidor, public.productos_empresa.distribuidor),
              envase_compra = coalesce(excluded.envase_compra, public.productos_empresa.envase_compra),
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
