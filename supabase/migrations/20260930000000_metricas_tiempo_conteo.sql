-- MÉTRICAS DE TIEMPO DEL CONTEO
--
-- Lo que el dueño no podía contestar mirando el detalle de un conteo:
-- "¿a qué hora arrancaron y a qué hora terminaron?", "¿cuánto tarda un
-- operario en cargar un producto que no está en el catálogo?" y "¿el
-- ritmo se sostiene o se cansan a la mitad?". Las tres tienen respuesta
-- en datos que YA están en la base — conteos.iniciado_at/cerrado_at y
-- escaneos.created_at existen desde 20260806000001 — pero ninguna salía
-- por los RPC que alimentan el resumen gerencial.
--
-- Por eso esta migración es casi toda `create or replace` de funciones
-- vivas: no hay tablas nuevas ni datos nuevos que capturar, salvo UNO —
-- cuánto tarda el formulario de alta manual, que solo lo sabe el cliente
-- (el servidor ve el alta ya terminada, no cuándo se abrió el wizard).
--
-- Los conteos y las altas anteriores a esta migración no pierden nada:
-- inicio/fin/duración y la curva de ritmo se calculan sobre datos
-- históricos que siempre estuvieron ahí. El único campo que arranca
-- vacío hacia atrás es duracion_segundos.

-- ═══════════════════════════════════════════════════════════════
-- a) altas_manuales_conteo.duracion_segundos
-- ═══════════════════════════════════════════════════════════════
-- Nullable, igual que foto_path y por el mismo motivo: es un dato
-- best-effort del cliente. Si el cronómetro no arrancó (el operario entró
-- al formulario por un camino raro), si la pestaña se recargó en el medio
-- o si simplemente la key no llega, el alta se hace igual. Bloquear un
-- alta por una métrica de supervisión sería exactamente al revés de para
-- qué existe el formulario.
--
-- Se mide en el CLIENTE, no acá: el servidor solo ve la llamada al RPC ya
-- con todo completo, no tiene forma de saber cuándo apareció el paso 1 en
-- el celular.

alter table altas_manuales_conteo add column duracion_segundos integer;

comment on column altas_manuales_conteo.duracion_segundos is
  'Cuánto tardó el operario en LLENAR el wizard de alta manual: desde que se abrió el paso 1 del formulario (con la foto ya sacada) hasta que apretó guardar. Medido en el cliente y best-effort — null es normal, no un error. NO incluye el tiempo de sacar la foto con la cámara del teléfono: eso pasa antes de que el formulario exista y es tiempo del aparato, no del operario.';

-- ═══════════════════════════════════════════════════════════════
-- b) crear_producto_y_contar: además, guarda cuánto tardó el alta
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo vivo (el de 20260929000000), misma firma y
-- mismo comportamiento en TODO lo anterior. El único agregado es leer una
-- key nueva y opcional del jsonb (`duracion_segundos`) y copiarla al log.
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
  v_fraccionable boolean;
  v_unidades_por_blister integer;
  v_blisters_por_caja integer;
  v_precio_blister numeric;
  v_precio_unidad numeric;
  -- `contenido` deja de ir inline en el insert porque ahora tiene dos
  -- orígenes posibles (lo que vino en el jsonb, o el derivado del
  -- desglose) y hay que decidirlo antes.
  v_contenido numeric;
  -- Métrica de supervisión, no un dato del producto: solo viaja al log.
  v_duracion_segundos integer;
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

  -- ── Venta fraccionada (opcional, 20260928000000) ───────────────
  -- Mismo patrón defensivo que `precio`: lo que no castea queda en null en
  -- vez de reventar el alta entera. La diferencia es que acá el default es
  -- "no fraccionable", que es el comportamiento de siempre — el que no
  -- manda nada no nota ningún cambio.
  begin
    v_fraccionable := coalesce(nullif(trim(p_nuevo_producto ->> 'fraccionable'), '')::boolean, false);
  exception when others then
    v_fraccionable := false;
  end;

  begin
    v_unidades_por_blister := nullif(trim(p_nuevo_producto ->> 'unidades_por_blister'), '')::integer;
  exception when others then
    v_unidades_por_blister := null;
  end;

  begin
    v_blisters_por_caja := nullif(trim(p_nuevo_producto ->> 'blisters_por_caja'), '')::integer;
  exception when others then
    v_blisters_por_caja := null;
  end;

  begin
    v_precio_blister := nullif(trim(p_nuevo_producto ->> 'precio_blister'), '')::numeric;
  exception when others then
    v_precio_blister := null;
  end;

  begin
    v_precio_unidad := nullif(trim(p_nuevo_producto ->> 'precio_unidad'), '')::numeric;
  exception when others then
    v_precio_unidad := null;
  end;

  -- Mismo patrón defensivo que los cinco de arriba, y acá importa todavía
  -- más: es una métrica accesoria, así que un valor raro tiene que quedar
  -- en null sin que se caiga el alta. Nunca un `raise` — el operario no
  -- tiene forma de "corregir" un cronómetro.
  begin
    v_duracion_segundos := nullif(trim(p_nuevo_producto ->> 'duracion_segundos'), '')::integer;
  exception when others then
    v_duracion_segundos := null;
  end;

  -- El desglose es lo único que no puede quedar a medias: sin él,
  -- `contenido` no se puede derivar y el producto quedaría marcado como
  -- fraccionable sin saber en cuántas partes se fracciona. Los dos precios
  -- sueltos SÍ pueden faltar (se cargan después desde el panel) — mismo
  -- criterio que el ABM, que los avisa pero no los bloquea.
  --
  -- Mensaje calcado, palabra por palabra, del de productos-abm.tsx: el
  -- operario y el admin tienen que leer exactamente lo mismo.
  if v_fraccionable and (
    coalesce(v_unidades_por_blister, 0) <= 0 or coalesce(v_blisters_por_caja, 0) <= 0
  ) then
    raise exception
      'Un producto fraccionable necesita cuántas unidades trae el blíster y cuántos blísteres la caja (ambos mayores a 0).';
  end if;

  -- Contenido DERIVADO cuando hay fraccionamiento: pisa lo que haya venido
  -- en el jsonb, igual que hace el ABM del lado del cliente (ver el
  -- comentario de productos.contenido en 20260918000001). Los dos números
  -- son lo mismo por definición, y dejar que el cliente mande un tercero
  -- abriría la puerta a que no coincidan.
  if v_fraccionable then
    v_contenido := v_blisters_por_caja::numeric * v_unidades_por_blister::numeric;
  else
    begin
      v_contenido := nullif(trim(p_nuevo_producto ->> 'contenido'), '')::numeric;
    exception when others then
      v_contenido := null;
    end;
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
    v_contenido,
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
  --
  -- Las cinco columnas de fraccionamiento van peladas en el do update
  -- (excluded.x, sin coalesce), igual que `precio`: este RPC ACABA de crear
  -- el producto unas líneas más arriba, así que no hay fila previa realista
  -- que preservar — el on conflict está por prolijidad e idempotencia, no
  -- porque se espere colisión. `fraccionable` además es not null, así que
  -- pasa por coalesce a false antes de tocar la columna.
  v_codigo_proveedor := nullif(trim(p_nuevo_producto ->> 'codigo_proveedor'), '');
  insert into public.productos_empresa (
    empresa_id, producto_id, precio, codigo_proveedor,
    fraccionable, unidades_por_blister, blisters_por_caja, precio_blister, precio_unidad
  )
  values (
    v_empresa_id, v_producto_id, v_precio, v_codigo_proveedor,
    coalesce(v_fraccionable, false), v_unidades_por_blister, v_blisters_por_caja,
    v_precio_blister, v_precio_unidad
  )
  on conflict (empresa_id, producto_id) do update
    set precio = excluded.precio,
        codigo_proveedor = coalesce(excluded.codigo_proveedor, public.productos_empresa.codigo_proveedor),
        fraccionable = excluded.fraccionable,
        unidades_por_blister = excluded.unidades_por_blister,
        blisters_por_caja = excluded.blisters_por_caja,
        precio_blister = excluded.precio_blister,
        precio_unidad = excluded.precio_unidad;

  -- El log de auditoría (20260929000000). Va DENTRO de la misma
  -- transacción que el resto a propósito: si el alta se cae por cualquier
  -- motivo, no queda un registro de un producto que no existe; y si el
  -- alta sale bien, el registro existe siempre — no hay forma de crear un
  -- producto desde apps/conteo sin dejar rastro.
  --
  -- Se guarda p_nuevo_producto ENTERO, sin desarmar campo por campo: lo
  -- que interesa es lo que el operario cargó, incluidas las keys que este
  -- RPC decidió ignorar. Si mañana el formulario agrega un campo, el log
  -- lo registra solo.
  --
  -- duracion_segundos sale además a su propia columna (y no sólo adentro
  -- de `datos`) porque es lo único de este jsonb sobre lo que se AGREGA:
  -- el promedio de cuánto tarda un alta es una métrica de la pantalla de
  -- admin, y sacarla de un jsonb en cada consulta sería trabajo de más
  -- para un entero.
  insert into public.altas_manuales_conteo (
    empresa_id, conteo_id, producto_id, usuario_id, dispositivo, codigo_raw, foto_path,
    duracion_segundos, datos
  )
  values (
    v_empresa_id, p_conteo, v_producto_id, auth.uid(), p_dispositivo, p_codigo_raw,
    nullif(trim(p_nuevo_producto ->> 'foto_path'), ''), v_duracion_segundos, p_nuevo_producto
  );

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

comment on function crear_producto_y_contar(uuid, text, uuid, jsonb, integer, text) is
  'Alta manual de un producto desde apps/conteo + el escaneo contado en el mismo paso. p_nuevo_producto acepta: nombre (obligatorio), precio (obligatorio, de VENTA), laboratorio (por NOMBRE, se resuelve acá con SECURITY DEFINER), principio_activo, accion_terapeutica, concentracion, forma, contenido, unidad, codigo_proveedor, el desglose de venta fraccionada —desde 20260928000000— (fraccionable, unidades_por_blister, blisters_por_caja, precio_blister, precio_unidad), —desde 20260929000000— foto_path, la ruta en el bucket ''altas-manuales'' de la foto que sacó el operario (opcional: si el upload falló, el alta sigue igual), y —desde 20260930000000— duracion_segundos, cuánto tardó el operario en llenar el formulario (opcional, lo cronometra el cliente desde que se abre el paso 1; se copia a altas_manuales_conteo.duracion_segundos). Los cinco del fraccionamiento solo tienen efecto con fraccionable = true; en ese caso unidades_por_blister y blisters_por_caja son obligatorios (> 0) y productos.contenido se escribe DERIVADO (blisters_por_caja * unidades_por_blister), ignorando el contenido que venga en el jsonb. Además, desde 20260929000000 cada alta deja una fila en altas_manuales_conteo (log de auditoría para admin/gerente) con el jsonb completo tal cual se recibió. NO existe `costo` en este RPC: el precio de COMPRA al proveedor sigue afuera de apps/conteo.';

-- ═══════════════════════════════════════════════════════════════
-- c) resumen_conteo: expone inicio, fin y duración
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo vivo (el de 20260911000000). Los mismos
-- guards, las mismas métricas, cuatro agregados al JSON:
--
--   - iniciado_at / cerrado_at, que estaban en la tabla desde el día uno
--     pero no salían por ningún lado. Se devuelven CRUDOS (timestamptz),
--     no formateados: la UI decide el formato — y en esta pantalla decide
--     mostrar fecha Y HORA, que es lo que se pidió.
--   - duracion_horas, que ya se calculaba acá adentro (v_horas, el
--     divisor de escaneos_por_hora) y se tiraba. Exponerla evita que el
--     cliente la recalcule distinto y termine mostrando un número que no
--     cierra con los "por hora" de la misma tabla.
--   - primer_escaneo_at / ultimo_escaneo_at por operario: con esos dos, la
--     tabla de productividad deja de ser "cuántos escaneó" y pasa a
--     contestar "cuándo estuvo trabajando" — quién arrancó tarde, quién
--     aflojó antes del cierre.
create or replace function resumen_conteo(p_conteo uuid)
returns json
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_conteo record;
  v_resultado jsonb;
  v_horas numeric;
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para ver el resumen de un conteo';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo;
  if not found then
    raise exception 'Conteo % no existe', p_conteo;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  v_horas := greatest(
    extract(epoch from (coalesce(v_conteo.cerrado_at, now()) - v_conteo.iniciado_at)) / 3600.0,
    1.0 / 60 -- piso de 1 minuto, evita división por ~0 en conteos recién abiertos
  );

  select jsonb_build_object(
    'conteo_id', v_conteo.id,
    'estado', v_conteo.estado,

    -- cerrado_at es null mientras el conteo sigue abierto; en ese caso
    -- duracion_horas es "lo que va corrido hasta ahora", no un total. La
    -- UI lo distingue mirando cerrado_at, no la duración.
    'iniciado_at', v_conteo.iniciado_at,
    'cerrado_at', v_conteo.cerrado_at,
    'duracion_horas', round(v_horas, 2),

    'unidades_totales', coalesce(sum(cl.cantidad), 0),
    'skus_distintos', count(distinct cl.producto_id) filter (where cl.producto_id is not null),
    'valor_costo', coalesce(sum(cl.cantidad * pe.costo), 0),
    'valor_precio', coalesce(sum(cl.cantidad * pe.precio), 0),
    'margen_teorico', coalesce(sum(cl.cantidad * pe.precio), 0) - coalesce(sum(cl.cantidad * pe.costo), 0),

    'skus_catalogo_no_encontrados', (
      select count(*) from public.productos_empresa pe2
      where pe2.empresa_id = v_conteo.empresa_id and pe2.activo
        and not exists (
          select 1 from public.conteo_lineas cl2
          where cl2.conteo_id = p_conteo and cl2.producto_id = pe2.producto_id
        )
    ),

    'top_20_valor_inmovilizado', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select
          p.id as producto_id,
          p.nombre,
          cl3.cantidad,
          (cl3.cantidad * coalesce(pe3.costo, 0)) as valor_costo
        from public.conteo_lineas cl3
        join public.productos p on p.id = cl3.producto_id
        left join public.productos_empresa pe3
          on pe3.producto_id = cl3.producto_id and pe3.empresa_id = v_conteo.empresa_id
        where cl3.conteo_id = p_conteo and cl3.producto_id is not null
        order by (cl3.cantidad * coalesce(pe3.costo, 0)) desc
        limit 20
      ) t
    ),

    'desconocidos_pendientes_este_conteo', (
      select count(*) from public.conteo_lineas
      where conteo_id = p_conteo and desconocido_id is not null
    ),
    'desconocidos_detectados_este_conteo', (
      select count(*) from public.desconocidos where conteo_deteccion_id = p_conteo
    ),
    'desconocidos_resueltos_ia_este_conteo', (
      select count(*) from public.desconocidos d
      join public.productos p on p.id = d.producto_resuelto_id
      where d.conteo_deteccion_id = p_conteo and d.estado = 'resuelto' and p.origen = 'ia'
    ),
    'desconocidos_resueltos_manual_este_conteo', (
      select count(*) from public.desconocidos d
      join public.productos p on p.id = d.producto_resuelto_id
      where d.conteo_deteccion_id = p_conteo and d.estado = 'resuelto' and p.origen <> 'ia'
    ),

    'desconocidos_empresa_total', (
      select count(*) from public.desconocidos where empresa_id = v_conteo.empresa_id
    ),
    'desconocidos_empresa_resueltos_ia', (
      select count(*) from public.desconocidos d
      join public.productos p on p.id = d.producto_resuelto_id
      where d.empresa_id = v_conteo.empresa_id and d.estado = 'resuelto' and p.origen = 'ia'
    ),
    'desconocidos_empresa_resueltos_manual', (
      select count(*) from public.desconocidos d
      join public.productos p on p.id = d.producto_resuelto_id
      where d.empresa_id = v_conteo.empresa_id and d.estado = 'resuelto' and p.origen <> 'ia'
    ),
    'desconocidos_empresa_pendientes', (
      select count(*) from public.desconocidos
      where empresa_id = v_conteo.empresa_id and estado <> 'resuelto'
    ),

    'productividad_por_operario', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select
          e.usuario_id,
          count(*) as escaneos,
          round(count(*) / v_horas, 1) as escaneos_por_hora,
          -- El rango real de trabajo de CADA operario, que no es el del
          -- conteo: escaneos_por_hora divide por las horas del conteo
          -- entero, así que uno que entró a la mitad aparece lento sin
          -- serlo. Con estos dos, quien lee el resumen puede ver por qué.
          min(e.created_at) as primer_escaneo_at,
          max(e.created_at) as ultimo_escaneo_at
        from public.escaneos e
        where e.conteo_id = p_conteo
        group by e.usuario_id
      ) t
    ),

    'tiene_vencimientos', exists (
      select 1 from public.escaneos where conteo_id = p_conteo and vencimiento is not null
    ),
    'vencimientos_menos_90_dias', (
      select count(distinct e.linea_id) from public.escaneos e
      where e.conteo_id = p_conteo and e.vencimiento is not null
        and e.vencimiento < current_date + interval '90 days'
    ),
    'vencimientos_menos_180_dias', (
      select count(distinct e.linea_id) from public.escaneos e
      where e.conteo_id = p_conteo and e.vencimiento is not null
        and e.vencimiento < current_date + interval '180 days'
    )
  )
  into v_resultado
  from public.conteo_lineas cl
  left join public.productos_empresa pe
    on pe.producto_id = cl.producto_id and pe.empresa_id = v_conteo.empresa_id
  where cl.conteo_id = p_conteo;

  return v_resultado::json;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- d) comparar_conteo: el conteo anterior también trae su duración
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo vivo (el de 20260913000000). Lo único que
-- cambia es la subquery de anterior_misma_sucursal, que ahora devuelve
-- cerrado_at y duracion_horas: sin eso, el comparativo podía decir
-- "contaron más unidades que la vez pasada" pero no "y además tardaron
-- media hora menos", que es la mitad de la pregunta.
--
-- El coalesce sobre cerrado_at es redundante (la query ya filtra por
-- estado = 'cerrado', así que siempre tiene valor) pero se deja por
-- consistencia con resumen_conteo: si algún día aparece un conteo cerrado
-- sin cerrado_at, las dos funciones se comportan igual en vez de una
-- devolver null y la otra un número.
create or replace function comparar_conteo(p_conteo_id uuid)
returns json
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_conteo record;
  v_resultado jsonb;
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para ver comparativos';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo_id;
  if not found then
    raise exception 'Conteo % no existe', p_conteo_id;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  select jsonb_build_object(
    'anterior_misma_sucursal', (
      select jsonb_build_object(
        'conteo_id', c.id,
        'nombre', c.nombre,
        'iniciado_at', c.iniciado_at,
        'cerrado_at', c.cerrado_at,
        -- El ::numeric explícito es porque round(x, 2) solo existe para
        -- numeric: resumen_conteo se lo ahorra porque ahí el valor pasa
        -- antes por una variable declarada numeric, acá va inline.
        'duracion_horas', round(
          greatest(
            extract(epoch from (coalesce(c.cerrado_at, c.iniciado_at) - c.iniciado_at))::numeric / 3600.0,
            1.0 / 60
          ),
          2
        ),
        'unidades_totales', coalesce((select sum(cantidad) from public.conteo_lineas where conteo_id = c.id), 0),
        'valor_precio', coalesce((
          select sum(cl.cantidad * pe.precio)
          from public.conteo_lineas cl
          left join public.productos_empresa pe
            on pe.producto_id = cl.producto_id and pe.empresa_id = v_conteo.empresa_id
          where cl.conteo_id = c.id
        ), 0)
      )
      from public.conteos c
      where c.sucursal_id = v_conteo.sucursal_id
        and c.estado = 'cerrado'
        and c.iniciado_at < v_conteo.iniciado_at
      order by c.iniciado_at desc
      limit 1
    ),
    'otras_sucursales', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select distinct on (s.id)
          s.id as sucursal_id,
          s.nombre as sucursal_nombre,
          c.id as conteo_id,
          c.nombre as conteo_nombre,
          c.iniciado_at,
          coalesce((select sum(cantidad) from public.conteo_lineas where conteo_id = c.id), 0) as unidades_totales
        from public.sucursales s
        join public.conteos c on c.sucursal_id = s.id and c.estado = 'cerrado'
        where s.empresa_id = v_conteo.empresa_id and s.id <> v_conteo.sucursal_id
        order by s.id, c.iniciado_at desc
      ) t
    )
  )
  into v_resultado;

  return v_resultado::json;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- e) curva_ritmo_conteo: el ritmo a lo largo del conteo
-- ═══════════════════════════════════════════════════════════════
-- La pregunta que contesta: "¿arrancan lento y agarran ritmo, o se cansan
-- y aflojan?". Un promedio de escaneos por hora no la contesta — es el
-- mismo número para un equipo parejo que para uno que hizo todo en la
-- primera hora y después se fue a almorzar.
--
-- AGREGADO de todo el equipo, una sola serie: decisión explícita del
-- usuario. La pregunta es sobre el conteo, no sobre quién rinde más — para
-- eso ya está productividad_por_operario en resumen_conteo.
--
-- El intervalo es ADAPTATIVO porque el mismo gráfico tiene que servir para
-- un conteo de 20 minutos de una bodega chica y para uno de 8 horas de la
-- sucursal grande. Con un intervalo fijo, uno de los dos queda ilegible:
-- 3 puntos o 96. Se apunta a ~10 y se redondea a una unidad que un humano
-- lee bien (5/10/15/30/60 min) en vez de un número arbitrario como 13.
create or replace function curva_ritmo_conteo(p_conteo uuid)
returns json
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_conteo record;
  v_duracion_minutos numeric;
  v_intervalo_minutos integer;
  v_buckets json;
begin
  -- Mismos guards que resumen_conteo / comparar_conteo: es la misma
  -- pantalla y la misma información de supervisión.
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para ver la curva de ritmo de un conteo';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo;
  if not found then
    raise exception 'Conteo % no existe', p_conteo;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  -- Mismo piso que v_horas en resumen_conteo, en minutos: un conteo recién
  -- abierto no puede dar 0 y arrastrar la división de abajo.
  v_duracion_minutos := greatest(
    extract(epoch from (coalesce(v_conteo.cerrado_at, now()) - v_conteo.iniciado_at)) / 60.0,
    1
  );

  v_intervalo_minutos := case
    when v_duracion_minutos / 10 <= 5 then 5
    when v_duracion_minutos / 10 <= 10 then 10
    when v_duracion_minutos / 10 <= 15 then 15
    when v_duracion_minutos / 10 <= 30 then 30
    else 60
  end;

  -- Solo los buckets CON escaneos: un hueco en el medio (el almuerzo) se
  -- ve igual porque el eje X son horas reales, y rellenar los vacíos con
  -- ceros haría que un conteo de 8 horas con dos ráfagas devolviera 96
  -- puntos de los cuales 90 son 0.
  --
  -- El greatest(0, ...) es por las dudas: escaneos.created_at lo pone el
  -- servidor con now(), así que nunca debería ser anterior al inicio del
  -- conteo, pero un bucket negativo dibujaría un punto a la izquierda del
  -- arranque y no hay lectura posible de eso.
  select coalesce(
    json_agg(
      json_build_object(
        'inicio_bucket', v_conteo.iniciado_at + (b.idx * v_intervalo_minutos) * interval '1 minute',
        'escaneos', b.escaneos
      )
      order by b.idx
    ),
    '[]'::json
  )
  into v_buckets
  from (
    select
      greatest(
        floor(extract(epoch from (e.created_at - v_conteo.iniciado_at)) / 60.0 / v_intervalo_minutos),
        0
      )::integer as idx,
      count(*) as escaneos
    from public.escaneos e
    where e.conteo_id = p_conteo
    group by 1
  ) b;

  return json_build_object('intervalo_minutos', v_intervalo_minutos, 'buckets', v_buckets);
end;
$$;

comment on function curva_ritmo_conteo(uuid) is
  'Ritmo de escaneo del conteo a lo largo del tiempo, bucketizado en intervalos adaptativos (~10-12 puntos, redondeados a 5/10/15/30/60 min según la duración total) para que el gráfico se lea igual de bien en un conteo de 20 minutos que en uno de 8 horas. Agregado de todo el equipo, no separado por operario. Devuelve solo los intervalos con al menos un escaneo. admin/gerente/superadmin, acotado a la propia empresa.';
