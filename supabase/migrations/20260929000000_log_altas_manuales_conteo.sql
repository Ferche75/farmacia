-- LOG DE AUDITORÍA DE LAS ALTAS MANUALES HECHAS DESDE apps/conteo
--
-- Qué se perdió por el camino: la bandeja de `desconocidos`
-- (20260806000006) existía porque el operario sacaba una foto y NO cargaba
-- nada — el producto lo terminaba de crear un admin desde el panel,
-- mirando esa foto. Ahí quedaba todo registrado: quién lo detectó, la
-- foto, y quién lo resolvió.
--
-- Desde que el alta manual es completa en el celular (crear_producto_y_contar,
-- el camino "Sin código de barras" / "No encontrado"), ese circuito se
-- salteó entero: el operario crea el producto él mismo, con nombre, precio
-- y fraccionamiento, y nunca pasa por la bandeja. El resultado es que el
-- admin se encuentra productos nuevos en el catálogo sin saber quién los
-- cargó, con qué datos ni contra qué caja física — y peor, la foto que el
-- operario SÍ saca en ese formulario nunca se subía a ningún lado (era
-- puro `fotoCapturada` en memoria del cliente, ver el comentario en
-- apps/conteo/app/(app)/pantalla-conteo.tsx).
--
-- Esto no revive la bandeja ni mete un paso de aprobación en el medio: el
-- alta sigue siendo inmediata y el operario sigue siendo quien decide. Es
-- SOLO un log de auditoría, para leer después desde el detalle del conteo
-- en apps/admin.
--
-- POR QUÉ LA FOTO VIVE 7 DÍAS Y EL RESTO PARA SIEMPRE: el texto (quién,
-- cuándo, qué datos) pesa nada y es lo que sirve dentro de seis meses
-- cuando aparece una diferencia de inventario. La foto pesa, se acumula
-- con cada alta de cada conteo de cada empresa y su valor es de CORTO
-- plazo — sirve para el "¿esto qué es?" de los días siguientes al conteo,
-- no para el archivo histórico. Borrarla no borra la fila: queda
-- foto_borrada_at marcando que la hubo, así la UI puede distinguir "nunca
-- se subió" (falló la red, dato de soporte) de "venció" (normal). El
-- borrado lo hace apps/admin/app/api/mantenimiento/borrar-fotos-vencidas,
-- que llama n8n una vez por día — no hay cron en la base.

-- ═══════════════════════════════════════════════════════════════
-- altas_manuales_conteo
-- ═══════════════════════════════════════════════════════════════

create table altas_manuales_conteo (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id),
  conteo_id uuid not null references conteos (id) on delete cascade,
  producto_id uuid not null references productos (id),
  -- auth.uid() del operario que hizo el alta. Nullable solo por prudencia
  -- ante un borde raro de auth, igual que conteo_dispositivos_estado: en
  -- la práctica el RPC exige perfil activo antes de llegar acá.
  usuario_id uuid references perfiles (id),
  -- Mismo "dispositivo" flojo de escaneos.dispositivo: user agent
  -- truncado. Sirve para cruzar con el panel de dispositivos del mismo
  -- conteo, no para identificar un aparato.
  dispositivo text,
  codigo_raw text not null,
  -- Ruta en el bucket 'altas-manuales' (empresa_id/conteo_id/archivo.jpg).
  -- null tiene DOS significados distintos, que se desambiguan con
  -- foto_borrada_at: null + foto_borrada_at null = nunca se pudo subir
  -- (falló la red y el alta siguió igual, la foto no bloquea nada);
  -- null + foto_borrada_at con valor = la tuvo y la limpieza la borró.
  foto_path text,
  foto_borrada_at timestamptz,
  -- El p_nuevo_producto ENTERO tal cual llegó. Snapshot inmutable: si
  -- mañana alguien corrige el producto desde el ABM de apps/admin, este
  -- jsonb NO cambia. Justamente la gracia del log es poder comparar lo que
  -- se cargó en el momento contra lo que quedó — leer el producto actual
  -- por producto_id contestaría otra pregunta.
  datos jsonb not null,
  creado_at timestamptz not null default now()
);

comment on table altas_manuales_conteo is
  'Log de auditoría de los productos creados a mano desde apps/conteo con crear_producto_y_contar: quién, con qué datos y con qué foto. Solo lectura para admin/gerente; lo escribe únicamente el RPC. La foto se borra a los 7 días, el resto de la fila queda para siempre.';

comment on column altas_manuales_conteo.datos is
  'Snapshot inmutable del p_nuevo_producto recibido (incluye el desglose de fraccionamiento si lo hubo). No se actualiza nunca — es la foto del momento del alta, no el estado actual del producto.';

comment on column altas_manuales_conteo.foto_borrada_at is
  'Cuándo la limpieza automática borró la foto del Storage. Se escribe junto con poner foto_path en null: es lo único que distingue "la foto venció" de "nunca se pudo subir".';

-- El único acceso de lectura real: el detalle de UN conteo, más nuevas
-- primero (mismo orden que muestra el componente).
create index ix_altas_manuales_conteo_conteo
  on altas_manuales_conteo (conteo_id, creado_at desc);

-- Parcial a propósito: la limpieza diaria barre TODAS las empresas y solo
-- le importan las filas que todavía tienen foto. Con el índice parcial, el
-- barrido no crece con el histórico — las filas ya limpiadas salen del
-- índice al ponerse foto_path en null.
create index ix_altas_manuales_conteo_limpieza
  on altas_manuales_conteo (creado_at) where foto_path is not null;

alter table altas_manuales_conteo enable row level security;

-- SELECT: calcado de conteo_dispositivos_estado_select (20260912000000).
-- Excluye a operario por el mismo motivo: es una herramienta de
-- supervisión de apps/admin, y el operario que cargó el producto ya sabe
-- lo que cargó.
create policy altas_manuales_conteo_select on altas_manuales_conteo
  for select using (
    mi_rol() = 'superadmin'
    or (
      empresa_id = mi_empresa_id()
      and mi_rol() in ('admin', 'gerente')
      and exists (
        select 1 from conteos c
        where c.id = altas_manuales_conteo.conteo_id
          and tengo_acceso_sucursal(c.sucursal_id)
      )
    )
  );

-- A propósito SIN policy de INSERT/UPDATE/DELETE para authenticated. Hay
-- exactamente dos escritores y ninguno pasa por RLS:
--   - crear_producto_y_contar (SECURITY DEFINER), que inserta la fila y
--     fija usuario_id con auth.uid() — nunca con un id que mande el
--     cliente, mismo criterio que conteo_dispositivos_estado;
--   - el endpoint de mantenimiento, que usa la service_role key para
--     apagar foto_path/foto_borrada_at.
-- Un log que el autor puede editar o borrar no sirve como auditoría.

-- ═══════════════════════════════════════════════════════════════
-- STORAGE: bucket 'altas-manuales'
-- ═══════════════════════════════════════════════════════════════
-- Bucket aparte de 'desconocidos' y no una carpeta adentro: son dos ciclos
-- de vida distintos (la foto de un desconocido vive hasta que alguien lo
-- resuelve; ésta vence a los 7 días sí o sí) y el barrido de limpieza
-- borra por bucket entero. Mezclarlos sería una forma muy cara de
-- equivocarse una vez.
--
-- Privado (public=false), misma convención de ruta que 'desconocidos':
-- empresa_id/conteo_id/archivo.jpg — split_part(name,'/',1) es el
-- empresa_id. El helper subirFotoAltaManual de packages/db/src/rpc.ts
-- depende de este formato exacto.

insert into storage.buckets (id, name, public)
values ('altas-manuales', 'altas-manuales', false)
on conflict (id) do nothing;

-- INSERT: cualquier authenticated de su propia empresa, igual que
-- desconocidos_storage_insert — la sube el OPERARIO desde el celular, en
-- el mismo paso en que guarda el producto.
create policy altas_manuales_storage_insert on storage.objects
  for insert with check (
    bucket_id = 'altas-manuales'
    and split_part(name, '/', 1) = mi_empresa_id()::text
  );

-- SELECT: acá SÍ se restringe por rol, a diferencia de
-- desconocidos_storage_select (que deja leer a cualquiera de la empresa
-- porque el operario ve la foto en su propia tarjeta de desconocido). En
-- este flujo el operario nunca necesita releerla: la ve localmente desde
-- el Blob mientras completa el formulario y después no vuelve nunca a esa
-- pantalla. El único lector es el log de apps/admin.
create policy altas_manuales_storage_select on storage.objects
  for select using (
    bucket_id = 'altas-manuales'
    and (
      mi_rol() = 'superadmin'
      or (mi_rol() in ('admin', 'gerente') and split_part(name, '/', 1) = mi_empresa_id()::text)
    )
  );

-- Sin policy de DELETE: los objetos los borra el endpoint de
-- mantenimiento con la service_role key, que ignora RLS. Nadie con sesión
-- de usuario tiene por qué borrar una foto de auditoría a mano.

-- ═══════════════════════════════════════════════════════════════
-- crear_producto_y_contar: además, deja el registro en el log
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo vivo (el de 20260928000000), misma firma y
-- mismo comportamiento en TODO lo anterior. El único agregado es el insert
-- a altas_manuales_conteo, y una key nueva opcional en el jsonb:
-- `foto_path`, que el cliente llena con lo que devolvió el upload al
-- bucket.
--
-- La foto NO es un requisito del alta: si el upload falló (red del
-- celular, que es la norma en el depósito) la key no llega, foto_path
-- queda en null y el producto se crea igual. Bloquear un alta por una
-- foto de auditoría sería exactamente el tipo de fricción que este
-- formulario vino a sacar — comparar con registrar_escaneo_desconocido,
-- donde la foto sí es obligatoria porque sin ella el admin no tiene NADA
-- para resolver el desconocido.
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
  insert into public.altas_manuales_conteo (
    empresa_id, conteo_id, producto_id, usuario_id, dispositivo, codigo_raw, foto_path, datos
  )
  values (
    v_empresa_id, p_conteo, v_producto_id, auth.uid(), p_dispositivo, p_codigo_raw,
    nullif(trim(p_nuevo_producto ->> 'foto_path'), ''), p_nuevo_producto
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
  'Alta manual de un producto desde apps/conteo + el escaneo contado en el mismo paso. p_nuevo_producto acepta: nombre (obligatorio), precio (obligatorio, de VENTA), laboratorio (por NOMBRE, se resuelve acá con SECURITY DEFINER), principio_activo, accion_terapeutica, concentracion, forma, contenido, unidad, codigo_proveedor, el desglose de venta fraccionada —desde 20260928000000— (fraccionable, unidades_por_blister, blisters_por_caja, precio_blister, precio_unidad) y —desde 20260929000000— foto_path, la ruta en el bucket ''altas-manuales'' de la foto que sacó el operario (opcional: si el upload falló, el alta sigue igual). Los cinco del fraccionamiento solo tienen efecto con fraccionable = true; en ese caso unidades_por_blister y blisters_por_caja son obligatorios (> 0) y productos.contenido se escribe DERIVADO (blisters_por_caja * unidades_por_blister), ignorando el contenido que venga en el jsonb. Además, desde 20260929000000 cada alta deja una fila en altas_manuales_conteo (log de auditoría para admin/gerente) con el jsonb completo tal cual se recibió. NO existe `costo` en este RPC: el precio de COMPRA al proveedor sigue afuera de apps/conteo.';
