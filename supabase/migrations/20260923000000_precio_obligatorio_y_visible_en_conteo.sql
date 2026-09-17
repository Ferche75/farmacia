-- PRECIO OBLIGATORIO SIEMPRE + PRECIO VISIBLE/CARGABLE DESDE apps/conteo
--
-- Dos decisiones del usuario, las dos acotadas a `precio` (el precio de
-- VENTA al público) y ninguna a `costo`:
--
--   1. `precio` pasa a ser obligatorio SIEMPRE que un producto entra al
--      sistema — por el importador de CSV o por el alta manual, en
--      apps/admin y en apps/conteo. Deja de ser un checkbox opcional de
--      "Campos obligatorios al importar" (20260813000007) y pasa al mismo
--      trato duro y no configurable que ya tenía `nombre`. Una empresa no
--      puede optar por no cargarlo.
--
--   2. Los operarios de apps/conteo SÍ pueden ver y escribir `precio`.
--      Textual del usuario: "ellos ahí saben los precios de todo". Esto
--      REVIERTE, sólo para `precio`, la exclusión que 20260922000000 dejó
--      escrita como "no negociable" y "estructural" en sus comentarios.
--      Esos comentarios quedaron desactualizados y se reescriben acá abajo
--      en los cuerpos nuevos de las dos funciones que tocaban el tema.
--
-- `costo` NO ENTRA EN NADA DE ESTO Y NO SE TOCA. Sigue afuera de
-- apps/conteo por completo (ni se selecciona, ni se acepta, ni baja al
-- dispositivo) y sigue siendo opcional en el importador. Es una decisión
-- de alcance del mantenedor, no algo que el usuario haya dicho: `costo` es
-- el precio de COMPRA al proveedor, una cifra distinta y más sensible
-- (margen, condiciones comerciales) que nadie pidió exponer. Ante la duda,
-- se abre lo que se pidió y nada más.
--
-- Lo que trae esta migración:
--   a) confirmar_importacion_lote: motivo de rechazo nuevo 'falta_precio'
--      en los 3 caminos de escritura.
--   b) crear_producto_y_contar: `precio` obligatorio y siempre escrito en
--      productos_empresa.
--   c) datos_completitud_catalogo_conteo: `precio` entra al subconjunto
--      completable y baja al dispositivo.
--   d) completar_datos_producto: idem, con el casteo numérico que ya usa
--      `contenido` y la misma regla de "solo llena huecos".
--
-- NO hace falta tocar actualizar_config_operativa_empresa: 'precio' ya es
-- un string válido de su whitelist desde 20260813000007. Lo que cambia es
-- la UI (config-operativa.tsx lo muestra como fijo, no como checkbox), no
-- el contrato del RPC — una empresa que hoy lo tenga tildado en su config
-- sigue siendo válida, y ahora además redundante.

-- ═══════════════════════════════════════════════════════════════
-- a) El importador rechaza la fila que dejaría el producto sin precio
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE con el cuerpo vivo (el de 20260922000000, que a su vez
-- viene del de 20260916000000 con los savepoints por fila). Lo único nuevo
-- son 3 chequeos de precio, uno por camino de escritura, con el mismo
-- estilo que los rechazos que ya existían: sumar a v_rechazados, anotar en
-- v_log y `continue`. Nada más cambia: ni los 6 motivos viejos, ni los
-- bloques begin/exception (el savepoint implícito por fila), ni los
-- contadores, ni la persistencia a importaciones.log.
--
-- QUÉ SIGNIFICA "LE FALTA EL PRECIO" EN CADA CAMINO:
--
--   * Alta nueva (con código, producto que no existe): no hay nada contra
--     qué caer, así que decide sólo lo que trae la fila. Sin precio en la
--     fila ⇒ rechazo, ANTES de insertar nada.
--   * Actualización (con o sin código): lo que importa es el estado FINAL
--     de productos_empresa para esta empresa. Si la fila trae precio,
--     entra. Si no lo trae pero el producto YA tiene precio cargado para
--     esta empresa, también está bien — la fila es una actualización de
--     otros campos y el producto no queda sin precio. Sólo se rechaza
--     cuando no hay precio por ningún lado: ni el nuevo ni el guardado.
--     Esto es importante para que una lista de precios parcial (o un
--     archivo que sólo corrige nombres) siga entrando como siempre.
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
-- b) "Producto sin código de barras" (apps/conteo) exige precio
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo vivo (20260921000000), misma firma. Dos
-- cambios:
--
--   1. `precio` se lee del jsonb y es OBLIGATORIO, con la misma dureza que
--      `nombre`: si falta o no castea a numeric, `raise exception`. A
--      diferencia de `contenido` —que si no castea queda en null y la vida
--      sigue— acá un null no es aceptable, así que no se lo esconde.
--   2. El upsert a productos_empresa deja de ser condicional. Antes sólo
--      corría si venía `codigo_proveedor`; ahora corre siempre, porque
--      siempre hay un precio que guardar. `codigo_proveedor` sigue siendo
--      opcional y viaja en el mismo upsert.
--
-- POR QUÉ UN OPERARIO PUEDE ESCRIBIR UN PRECIO ACÁ: decisión explícita del
-- usuario (ver la cabecera de este archivo). El operario que está contando
-- tiene la caja en la mano y sabe a cuánto se vende; pedirle todo el
-- producto menos el precio obligaba a que alguien lo completara después
-- desde el panel, que es justo lo que este RPC vino a evitar. `costo` no:
-- eso sigue sin existir en apps/conteo.
--
-- El `do update` del upsert usa excluded.precio pelado (no coalesce): este
-- RPC acaba de CREAR el producto unas líneas más arriba, así que no hay
-- fila previa realista contra la que caer — el on conflict está por
-- prolijidad e idempotencia, no porque se espere colisión.
create or replace function crear_producto_y_contar(
  p_conteo uuid,
  p_codigo_raw text,
  p_client_uuid uuid,
  p_nuevo_producto jsonb,
  p_delta integer default 1,
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
  v_laboratorio_nombre text;
  v_laboratorio_id uuid;
  v_producto_id uuid;
  v_linea_id uuid;
  v_codigo_proveedor text;
  v_precio numeric;
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

  if p_nuevo_producto is null or nullif(p_nuevo_producto ->> 'nombre', '') is null then
    raise exception 'Falta el nombre del producto';
  end if;

  -- precio obligatorio (20260923000000), al mismo nivel que el nombre. El
  -- begin/exception es sólo para que un valor impresentable ("s/d", "12,5
  -- pesos") no salga como un error de casteo de Postgres: se normaliza a
  -- null y el `raise` de abajo da el mensaje que el formulario sabe
  -- mostrar. El cliente ya valida lo mismo; esto es la red del servidor.
  begin
    v_precio := nullif(trim(p_nuevo_producto ->> 'precio'), '')::numeric;
  exception when others then
    v_precio := null;
  end;
  if v_precio is null then
    raise exception 'Falta el precio del producto';
  end if;

  v_codigo_norm := (public.normalizar_codigo(p_codigo_raw)).codigo_norm;
  if v_codigo_norm is null then
    raise exception 'Código inválido';
  end if;

  if exists (select 1 from public.codigos_barra where codigo_norm = v_codigo_norm) then
    raise exception
      'codigo_ya_en_catalogo: este código ya está en el catálogo, el dispositivo tenía datos desactualizados — refrescá el catálogo local';
  end if;

  -- laboratorio va como NOMBRE, no como id: quien llama a este RPC puede
  -- ser un operario, que no tiene permiso de escritura directa sobre
  -- `laboratorios` (RLS lo reserva a admin/gerente/superadmin) — se
  -- resuelve acá adentro, que al ser SECURITY DEFINER no choca con eso.
  v_laboratorio_nombre := nullif(trim(p_nuevo_producto ->> 'laboratorio'), '');
  if v_laboratorio_nombre is not null then
    insert into public.laboratorios (nombre) values (v_laboratorio_nombre)
    on conflict (nombre) do update set nombre = excluded.nombre
    returning id into v_laboratorio_id;
  end if;

  insert into public.productos (
    nombre, laboratorio_id, principio_activo, concentracion, forma, contenido, unidad,
    accion_terapeutica, origen
  )
  values (
    p_nuevo_producto ->> 'nombre',
    v_laboratorio_id,
    p_nuevo_producto ->> 'principio_activo',
    p_nuevo_producto ->> 'concentracion',
    p_nuevo_producto ->> 'forma',
    nullif(p_nuevo_producto ->> 'contenido', '')::numeric,
    p_nuevo_producto ->> 'unidad',
    p_nuevo_producto ->> 'accion_terapeutica',
    'manual'
  )
  returning id into v_producto_id;

  insert into public.codigos_barra (producto_id, codigo_norm, codigo_raw, es_principal)
  values (v_producto_id, v_codigo_norm, p_codigo_raw, true);

  -- Siempre, no sólo cuando hay codigo_proveedor: el precio es obligatorio
  -- y vive en esta tabla, así que la fila de productos_empresa tiene que
  -- existir sí o sí. codigo_proveedor sigue siendo opcional y por eso va
  -- con coalesce en el do update: un null nuevo no pisa uno ya cargado.
  v_codigo_proveedor := nullif(trim(p_nuevo_producto ->> 'codigo_proveedor'), '');
  insert into public.productos_empresa (empresa_id, producto_id, precio, codigo_proveedor)
  values (v_empresa_id, v_producto_id, v_precio, v_codigo_proveedor)
  on conflict (empresa_id, producto_id) do update
    set precio = excluded.precio,
        codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor);

  insert into public.conteo_lineas (conteo_id, producto_id)
  values (p_conteo, v_producto_id)
  on conflict (conteo_id, producto_id) where producto_id is not null
  do update set conteo_id = excluded.conteo_id
  returning id into v_linea_id;

  insert into public.escaneos (
    conteo_id, linea_id, codigo_raw, codigo_norm, delta, usuario_id, dispositivo, client_uuid
  )
  values (
    p_conteo, v_linea_id, p_codigo_raw, v_codigo_norm, p_delta, auth.uid(), p_dispositivo, p_client_uuid
  )
  on conflict (client_uuid) do nothing;

  return json_build_object('producto_id', v_producto_id, 'linea_id', v_linea_id);
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- EL SUBCONJUNTO "COMPLETABLE DESDE CONTEO" (versión vigente)
-- ═══════════════════════════════════════════════════════════════
-- Reemplaza al bloque equivalente de 20260922000000, que quedó viejo en un
-- punto: decía que `precio` no podía estar acá "ni negociable ni
-- configurable". Ahora sí está, por pedido explícito del usuario.
--
-- De los campos de CAMPOS_SISTEMA, estos 15 son los únicos que el popup de
-- apps/conteo puede pedir y que completar_datos_producto puede escribir:
--
--   productos (global):          principioActivo, categoria, laboratorio,
--                                fabricante, marca, accionTerapeutica,
--                                especialidad, concentracion, contenido,
--                                unidad
--   productos_empresa (empresa): codigoProveedor, distribuidor,
--                                loteCatalogo, loteCatalogo2, precio
--
-- `precio` es el único numeric de los cinco de productos_empresa: se
-- castea como `contenido` (try-cast o null), no se trata como texto.
--
-- Quedan afuera A PROPÓSITO:
--
--   * costo — el precio de COMPRA al proveedor. Sigue completamente afuera
--     de apps/conteo: no está en este whitelist, no está en el gemelo de
--     TS (apps/conteo/lib/campos-obligatorios.ts) y ninguna de las dos
--     funciones de abajo selecciona esa columna, así que no hay forma de
--     que un costo salga de la base hacia un dispositivo de conteo. La
--     diferencia con `precio` es de ALCANCE, no de mecanismo: el usuario
--     pidió abrir el precio de venta ("ellos ahí saben los precios de
--     todo") y nada más; el costo es una cifra comercial distinta y más
--     sensible (margen, condiciones con el proveedor) que nadie pidió
--     exponer, así que se deja como estaba. Si alguna vez se quisiera
--     abrir, es el mismo trabajo de 3 capas que se hizo acá para precio —
--     pero es una decisión de producto, no un olvido.
--   * codigoBarra y unidadesPorCodigo — no son "un dato que le falta al
--     producto": el producto se encontró JUSTAMENTE por su código de
--     barras, y unidades_por_codigo es un multiplicador por código que
--     vale 1 por default, no un campo vacío.
--
-- SINCRONIZACIÓN MANUAL: este listado aparece dos veces en este archivo
-- (una por función) y una tercera en TS, en CAMPOS_COMPLETABLES_CONTEO
-- (apps/conteo/lib/campos-obligatorios.ts). Los tres tienen que decir lo
-- mismo — si no, el cliente marca como incompleto algo que el servidor no
-- deja completar (popup infinito) o al revés.
--
-- OJO CON EL DOBLE ROL DE `precio` DESDE ACÁ: ser obligatorio al CREAR
-- (importador y altas) es incondicional y no pasa por la config de la
-- empresa. Ser COMPLETABLE desde el popup del conteo, en cambio, sigue la
-- misma regla que los otros 14: sólo se pide si la empresa tiene 'precio'
-- tildado en "Campos obligatorios al importar". Son dos cosas distintas y
-- así tiene que ser: el popup existe para tapar huecos VIEJOS (productos
-- que entraron antes de esta migración, o por caminos que no exigían
-- precio), y quién quiere taparlos durante un conteo es una decisión de
-- cada farmacia.

-- ═══════════════════════════════════════════════════════════════
-- c) Lo que apps/conteo se baja para decidir OFFLINE
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo de 20260922000000. Cambia sólo que `precio`
-- entra al whitelist, entra al subconjunto "vive en productos_empresa" y
-- se selecciona junto a los otros 4.
--
-- POR QUÉ ESTO SIGUE SIENDO UN RPC SECURITY DEFINER Y NO UN SELECT (los
-- dos motivos originales siguen intactos):
--
--   1. `productos_empresa` es INVISIBLE para un operario. La policy
--      productos_empresa_select (20260806000001) dice literalmente
--      `empresa_id = mi_empresa_id() and mi_rol() <> 'operario'`. Esa
--      policy NO se toca en esta migración, y por eso este RPC sigue
--      siendo necesario: un `.select()` desde apps/conteo no devuelve
--      error, devuelve CERO FILAS. Sigue siendo la barrera correcta,
--      porque la fila entera de productos_empresa incluye `costo`, que
--      sigue sin poder salir. Lo que cambió es qué columnas elige a mano
--      este RPC: ahora son 5 en vez de 4, con `precio` sumado a propósito.
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
create or replace function datos_completitud_catalogo_conteo(
  p_offset integer default 0,
  p_limit integer default 1000
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Ver "EL SUBCONJUNTO COMPLETABLE DESDE CONTEO" arriba. 'precio' está
  -- acá a propósito desde 20260923000000; 'costo' NUNCA.
  v_campos_completables text[] := array[
    'principioActivo', 'categoria', 'laboratorio', 'fabricante',
    'marca', 'accionTerapeutica', 'especialidad',
    'concentracion', 'contenido', 'unidad',
    'codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2', 'precio'
  ];
  -- Los 5 que viven en productos_empresa: si ninguno está en la lista de
  -- obligatorios de esta empresa, no hace falta bajar nada de esa tabla.
  v_campos_empresa text[] := array[
    'codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2', 'precio'
  ];
  v_empresa_id uuid := public.mi_empresa_id();
  v_config_campos jsonb;
  v_requeridos text[];
  v_necesita_empresa boolean;
  v_total integer := 0;
  v_filas json := '[]'::json;
begin
  -- Cualquier perfil con rol: esto lo llama el operario que está contando.
  -- Lo único que puede salir de acá es el subconjunto completable (que
  -- desde 20260923000000 incluye el precio de venta, a pedido del usuario)
  -- y nunca el config crudo ni el costo; todo filtrado por mi_empresa_id(),
  -- nunca por un id que mande el cliente.
  if public.mi_rol() is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;
  if v_empresa_id is null then
    raise exception 'El perfil no tiene empresa asignada';
  end if;

  -- La lista cruda de la empresa, filtrada al subconjunto completable: un
  -- 'costo' tildado en la configuración del importador es legítimo ahí,
  -- pero acá se cae en este filtro y nunca llega al dispositivo.
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

    -- Sólo 5 columnas + el id, elegidas a mano. costo/precio_blister/
    -- precio_unidad ni se nombran: no hay forma de que salgan por acá.
    select coalesce(json_agg(f order by f.producto_id), '[]'::json)
    into v_filas
    from (
      select pe.producto_id,
             pe.codigo_proveedor,
             pe.distribuidor,
             pe.lote_catalogo,
             pe.lote_catalogo_2,
             pe.precio
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
  'Lo que apps/conteo necesita para decidir OFFLINE si a un producto le faltan datos obligatorios: la lista de campos obligatorios de la empresa (ya filtrada al subconjunto completable) y los 5 campos de productos_empresa que ese subconjunto incluye —codigo_proveedor, distribuidor, lote_catalogo, lote_catalogo_2 y precio—, paginados. SECURITY DEFINER porque productos_empresa es invisible para un operario a propósito. `precio` sale por acá desde 20260923000000, por pedido explícito del usuario; `costo` no sale nunca.';

-- ═══════════════════════════════════════════════════════════════
-- d) La escritura del popup
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo de 20260922000000, con `precio` sumado. Las
-- tres reglas de esa migración siguen valiendo tal cual:
--
--   1. RE-VALIDACIÓN SERVER-SIDE de cada key contra (a) el subconjunto
--      completable y (b) la lista de obligatorios REAL de esta empresa,
--      leída de la base — nunca la que diga el cliente. Una key que no
--      pasa se ignora en silencio en vez de tumbar la llamada.
--   2. SOLO LLENA HUECOS: `coalesce(columna, nuevo)`, no
--      `coalesce(nuevo, columna)`. `precio` no es la excepción: un
--      operario NO puede cambiar un precio ya cargado, sólo poner el que
--      falta. Eso mantiene el popup como "completar", no como "editar".
--   3. Rol: cualquier perfil con rol, operarios incluidos. Sigue siendo la
--      excepción deliberada al "solo admin/gerente edita catálogo", y
--      sigue siendo angosta: 15 campos, sólo sobre huecos, sólo los que la
--      empresa declaró obligatorios. Lo que cambió es que ahora uno de los
--      15 es el precio de venta — decisión explícita del usuario, misma
--      que habilita el precio en el alta manual de crear_producto_y_contar.
--      `costo` sigue sin estar.
--
-- Llamada con p_campos = '{}' es una LECTURA pura: no escribe nada y
-- devuelve los valores actuales (ahora, precio incluido). apps/conteo la
-- usa así justo antes de abrir el popup, para calcular qué falta contra el
-- dato fresco del servidor en vez de contra el snapshot local.
--
-- Requiere conexión, igual que crear_producto_y_contar.
create or replace function completar_datos_producto(p_producto_id uuid, p_campos jsonb default '{}'::jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Gemelo exacto del de datos_completitud_catalogo_conteo y de
  -- CAMPOS_COMPLETABLES_CONTEO en TS. Con 'precio' desde 20260923000000,
  -- sin 'costo' nunca.
  v_campos_completables text[] := array[
    'principioActivo', 'categoria', 'laboratorio', 'fabricante',
    'marca', 'accionTerapeutica', 'especialidad',
    'concentracion', 'contenido', 'unidad',
    'codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2', 'precio'
  ];
  v_empresa_id uuid := public.mi_empresa_id();
  v_config_campos jsonb;
  v_requeridos text[];
  v_clave text;
  v_valor text;
  v_aceptados text[] := '{}';
  v_laboratorio_id uuid;
  v_contenido numeric;
  v_precio numeric;
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

    -- `precio` también es numeric (es el único de los 5 campos de
    -- productos_empresa que no es texto) y sigue exactamente el mismo
    -- patrón que `contenido`: try-cast o null, y un null lo vuelve un
    -- no-op. Nada de raise acá — a diferencia de crear_producto_y_contar,
    -- este RPC completa huecos de productos que YA existen: si el precio
    -- tipeado no castea, lo peor que pasa es que el popup vuelva a
    -- pedirlo, no que se pierdan los otros campos que sí venían bien.
    if 'precio' = any (v_aceptados) then
      begin
        v_precio := trim(p_campos ->> 'precio')::numeric;
      exception when others then
        v_precio := null;
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

    -- Los 5 de productos_empresa. El upsert es el mismo patrón que usa el
    -- importador; el `do update` también respeta "solo llena huecos".
    -- `costo` no se nombra en ningún lado, así que una fila creada acá
    -- nace sin costo — que es lo correcto, este RPC no sabe nada de
    -- precios de compra y no tiene con qué inventarlos.
    --
    -- `precio` entra en la condición por separado y no por el `&&`: si la
    -- key vino pero no casteó, v_precio es null y no hay nada que escribir
    -- — sin esto, un precio impresentable crearía una fila de
    -- productos_empresa entera en null sin ningún motivo.
    if (v_aceptados && array['codigoProveedor', 'distribuidor', 'loteCatalogo', 'loteCatalogo2']::text[])
       or v_precio is not null then
      insert into public.productos_empresa (
        empresa_id, producto_id, codigo_proveedor, distribuidor, lote_catalogo, lote_catalogo_2, precio
      )
      values (
        v_empresa_id,
        p_producto_id,
        case when 'codigoProveedor' = any (v_aceptados) then trim(p_campos ->> 'codigoProveedor') end,
        case when 'distribuidor' = any (v_aceptados) then trim(p_campos ->> 'distribuidor') end,
        case when 'loteCatalogo' = any (v_aceptados) then trim(p_campos ->> 'loteCatalogo') end,
        case when 'loteCatalogo2' = any (v_aceptados) then trim(p_campos ->> 'loteCatalogo2') end,
        v_precio
      )
      on conflict (empresa_id, producto_id) do update
        set codigo_proveedor = coalesce(public.productos_empresa.codigo_proveedor, excluded.codigo_proveedor),
            distribuidor = coalesce(public.productos_empresa.distribuidor, excluded.distribuidor),
            lote_catalogo = coalesce(public.productos_empresa.lote_catalogo, excluded.lote_catalogo),
            lote_catalogo_2 = coalesce(public.productos_empresa.lote_catalogo_2, excluded.lote_catalogo_2),
            precio = coalesce(public.productos_empresa.precio, excluded.precio);
    end if;
  end if;

  -- Devuelve los valores actuales de los 15 campos completables (global +
  -- el overlay de ESTA empresa) para que el cliente actualice su catálogo
  -- local sin re-descargar nada. `laboratorio` va como nombre, que es lo
  -- que guarda ProductoLocal. `precio` sí se nombra; `costo` no.
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
    'precio', pe.precio,
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
  'Completa los datos obligatorios que le faltan a un producto del catálogo, desde el popup de apps/conteo. Solo llena huecos (nunca pisa un dato existente), solo campos que la empresa declaró obligatorios, y nunca costo. Desde 20260923000000 el precio de VENTA sí entra (pedido explícito del usuario: el operario que cuenta conoce los precios); el costo de compra sigue afuera. Con p_campos = ''{}'' es una lectura pura de los valores actuales. Cualquier perfil con rol, operarios incluidos: es la excepción deliberada y angosta al "solo admin/gerente edita catálogo".';
