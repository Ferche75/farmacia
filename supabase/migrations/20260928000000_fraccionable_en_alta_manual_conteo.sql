-- VENTA FRACCIONADA EN EL ALTA MANUAL DE apps/conteo
--
-- Hasta acá el fraccionamiento (caja / blíster / unidad suelta, agregado
-- por 20260918000001_fraccionamiento_marca_y_lotes_manuales.sql) sólo se
-- podía cargar desde el ABM de apps/admin. Un operario que daba de alta un
-- producto desde el conteo —el camino de "Producto sin código de barras" /
-- "No encontrado", que llama a crear_producto_y_contar— creaba el producto
-- entero MENOS el desglose, y alguien tenía que entrar después al panel a
-- completarlo. Justo lo que este RPC vino a evitar con el resto de los
-- campos.
--
-- El operario que está contando tiene la caja en la mano: sabe cuántos
-- comprimidos trae el blíster y cuántos blísteres la caja, que es
-- exactamente el dato que falta. Mismo razonamiento por el que
-- 20260923000000 le abrió `precio`.
--
-- MISMO MODELO DE DATOS QUE apps/admin, sin una variante nueva: se escriben
-- las mismas cinco columnas de productos_empresa (fraccionable,
-- unidades_por_blister, blisters_por_caja, precio_blister, precio_unidad),
-- con la misma regla de "fraccionable ⇒ contenido DERIVADO"
-- (blisters_por_caja * unidades_por_blister) que el ABM aplica del lado del
-- cliente y que documenta el comentario de productos.contenido. Un producto
-- dado de alta desde el conteo queda indistinguible de uno dado de alta
-- desde el panel.
--
-- POR QUÉ LA VALIDACIÓN VIVE ACÁ Y NO EN UN CHECK: igual que explica
-- 20260918000001, un CHECK de "fraccionable ⇒ blísteres y unidades > 0"
-- rompería cualquier UPDATE parcial de productos_empresa (el importador,
-- por ejemplo, escribe esa fila sin saber nada de fraccionamiento). La
-- regla se valida en el punto de entrada —el formulario, y acá como red del
-- servidor— con el MISMO mensaje literal que muestra productos-abm.tsx, para
-- que el operario y el admin lean exactamente lo mismo.
--
-- El desglose es OPCIONAL: si no llega `fraccionable` (o llega false), este
-- RPC se comporta igual que antes, `contenido` sale del jsonb tal cual y las
-- cinco columnas quedan en su default. No hay cambio de contrato para quien
-- ya lo llamaba.
--
-- `costo` SIGUE SIN EXISTIR EN ESTE RPC, igual que en 20260922000000 y
-- 20260923000000: acá se suman precios de VENTA por nivel (blíster y unidad
-- suelta), no el precio de COMPRA al proveedor. Mismo alcance de siempre.
--
-- Tampoco se toca nada de stock: stock_actual / stock_actual_lote /
-- registrar_venta / ajustar_stock y /api/pdvlat/catalogo siguen leyendo
-- `contenido` igual que antes — la única diferencia es de dónde sale ese
-- número cuando el producto es fraccionable.

-- ═══════════════════════════════════════════════════════════════
-- crear_producto_y_contar: acepta el desglose de venta fraccionada
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE del cuerpo vivo (el de 20260923000000), misma firma.
-- Todo lo anterior queda igual: los mismos guards de rol/conteo/sucursal, el
-- mismo corte por client_uuid duplicado, nombre y precio obligatorios, la
-- resolución del laboratorio por nombre y los mismos inserts a
-- codigos_barra / conteo_lineas / escaneos.
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
  'Alta manual de un producto desde apps/conteo + el escaneo contado en el mismo paso. p_nuevo_producto acepta: nombre (obligatorio), precio (obligatorio, de VENTA), laboratorio (por NOMBRE, se resuelve acá con SECURITY DEFINER), principio_activo, accion_terapeutica, concentracion, forma, contenido, unidad, codigo_proveedor y —desde 20260928000000— el desglose de venta fraccionada: fraccionable, unidades_por_blister, blisters_por_caja, precio_blister, precio_unidad. Los ultimos cinco son opcionales y solo tienen efecto con fraccionable = true; en ese caso unidades_por_blister y blisters_por_caja son obligatorios (> 0) y productos.contenido se escribe DERIVADO (blisters_por_caja * unidades_por_blister), ignorando el contenido que venga en el jsonb. NO existe `costo` en este RPC: el precio de COMPRA al proveedor sigue afuera de apps/conteo.';
