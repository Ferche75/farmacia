-- Fase 1: funciones RPC (normalizar_codigo, buscar_producto,
-- registrar_escaneos_batch, resumen_conteo).

-- ═══════════════════════════════════════════════════════════════
-- normalizar_codigo
-- ═══════════════════════════════════════════════════════════════
-- Gap detectado en Fase 1 (docs/decisiones.md): la sección 4 del spec
-- decía "normalizar_codigo(text) → text", pero el prompt de Fase 1 pide
-- que la misma función extraiga GTIN + lote + vencimiento — tres valores,
-- no uno. Se resuelve devolviendo un tipo compuesto en vez de texto.
--
-- Unifica EAN-13, UPC-A y GTIN-14 (y el GTIN embebido en GS1
-- DataMatrix/GS1-128 vía AI 01) al mismo código canónico: UPC-A (12
-- dígitos) se completa con un cero adelante, GTIN-14 se le sacan los
-- ceros a la izquierda. Así el mismo producto matchea sin importar qué
-- simbología lo escaneó.
--
-- El parseo de GS1-128 "crudo" (sin paréntesis, sin separador FNC1 real)
-- es una heurística basada en el orden 01→17→10: el lector Bluetooth
-- todavía no está confirmado (ver docs/decisiones.md, decisión #4 del
-- spec original) — cuando se confirme el modelo real, revisar esta rama
-- contra su output real y ajustar si hace falta.

create type codigo_normalizado as (
  codigo_norm text,
  lote text,
  vencimiento date
);

create function normalizar_codigo(p_codigo text)
returns codigo_normalizado
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_input text := trim(coalesce(p_codigo, ''));
  v_gtin text;
  v_lote text;
  v_venc date;
  v_match text[];
  v_resto text;
begin
  if v_input = '' then
    return (null, null, null)::public.codigo_normalizado;
  end if;

  if v_input ~ '\(01\)' then
    -- GS1 legible: (01)GTIN(17)AAMMDD(10)LOTE, en cualquier orden/subset.
    v_match := regexp_match(v_input, '\(01\)(\d{14})');
    if v_match is not null then
      v_gtin := v_match[1];
    end if;

    v_match := regexp_match(v_input, '\(17\)(\d{6})');
    if v_match is not null then
      begin
        v_venc := to_date(v_match[1], 'YYMMDD');
      exception when others then
        v_venc := null;
      end;
    end if;

    v_match := regexp_match(v_input, '\(10\)([^(]+)');
    if v_match is not null then
      v_lote := rtrim(v_match[1]);
    end if;

  elsif v_input ~ '^01\d{14}' then
    -- GS1-128 crudo (sin paréntesis): AIs concatenados, orden 01 → 17 → 10.
    -- Se respeta el separador FNC1 real (chr(29)) si el lector lo manda;
    -- si no, se asume que 10 (lote, largo variable) llega hasta el final.
    v_gtin := substring(v_input from 3 for 14);
    v_resto := replace(substring(v_input from 17), chr(29), '|');

    if v_resto ~ '^17\d{6}' then
      begin
        v_venc := to_date(substring(v_resto from 3 for 6), 'YYMMDD');
      exception when others then
        v_venc := null;
      end;
      v_resto := ltrim(substring(v_resto from 9), '|');
    end if;

    if v_resto ~ '^10' then
      v_lote := split_part(substring(v_resto from 3), '|', 1);
    end if;

  else
    -- Código numérico simple: EAN-13, UPC-A o GTIN-14 sin AIs.
    v_gtin := regexp_replace(v_input, '\D', '', 'g');
  end if;

  if v_gtin is null or v_gtin = '' then
    return (null, v_lote, v_venc)::public.codigo_normalizado;
  end if;

  if length(v_gtin) = 12 then
    v_gtin := '0' || v_gtin;
  elsif length(v_gtin) = 14 then
    v_gtin := ltrim(v_gtin, '0');
    if v_gtin = '' then
      v_gtin := '0';
    end if;
  end if;

  return (v_gtin, v_lote, v_venc)::public.codigo_normalizado;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- buscar_producto
-- ═══════════════════════════════════════════════════════════════
-- Gap detectado en Fase 0 (docs/decisiones.md): SECURITY DEFINER no
-- hereda RLS, así que el filtrado de costo/precio por rol tiene que
-- estar hardcodeado acá adentro. Además: p_empresa NO es de confianza
-- solo porque lo mandó el caller — se valida contra la empresa real de
-- quien llama (salvo superadmin), para que nadie pueda pasar el
-- empresa_id de otra empresa y espiar su catálogo con costo/precio.

create function buscar_producto(p_empresa uuid, p_codigo text)
returns json
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_norm text;
  v_producto record;
  v_pe record;
  v_resultado jsonb;
begin
  if v_rol is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;

  if v_rol <> 'superadmin' and p_empresa <> public.mi_empresa_id() then
    raise exception 'No autorizado para esa empresa';
  end if;

  v_norm := (public.normalizar_codigo(p_codigo)).codigo_norm;
  if v_norm is null then
    return null;
  end if;

  select p.* into v_producto
  from public.productos p
  join public.codigos_barra cb on cb.producto_id = p.id
  where cb.codigo_norm = v_norm
  limit 1;

  if not found then
    return null;
  end if;

  select * into v_pe
  from public.productos_empresa
  where empresa_id = p_empresa and producto_id = v_producto.id;

  v_resultado := jsonb_build_object(
    'id', v_producto.id,
    'nombre', v_producto.nombre,
    'laboratorio_id', v_producto.laboratorio_id,
    'principio_activo', v_producto.principio_activo,
    'concentracion', v_producto.concentracion,
    'forma', v_producto.forma,
    'contenido', v_producto.contenido,
    'unidad', v_producto.unidad,
    'requiere_receta', v_producto.requiere_receta,
    'controlado', v_producto.controlado,
    'codigo_norm', v_norm
  );

  -- Costo/precio: nunca para operario (CONTEXTO.md regla 3), nunca si la
  -- empresa ni siquiera cargó ese producto en productos_empresa.
  if v_rol <> 'operario' and v_pe.producto_id is not null then
    v_resultado := v_resultado || jsonb_build_object(
      'costo', v_pe.costo,
      'precio', v_pe.precio,
      'stock_minimo', v_pe.stock_minimo
    );
  end if;

  return v_resultado::json;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- registrar_escaneos_batch
-- ═══════════════════════════════════════════════════════════════
-- Idempotente por client_uuid: si ya existe un escaneo con ese
-- client_uuid, se cuenta como duplicado y no se reprocesa (el trigger de
-- recalculo de cantidad solo dispara en insert real, así que un reintento
-- nunca duplica cantidades — CONTEXTO.md regla 2).
--
-- A propósito NO recibe codigo_norm/lote/vencimiento del cliente: se
-- recalculan acá con normalizar_codigo(codigo_raw), nunca se confía en lo
-- que mande el cliente para eso. Tampoco confía en un usuario_id del
-- payload — usa auth.uid().
--
-- A propósito NO crea filas en `desconocidos` para los códigos no
-- encontrados — ese flujo necesita la foto del operario y es de Fase 4.
-- Acá simplemente se reportan en `no_encontrados` para que la UI decida
-- qué hacer.

create function registrar_escaneos_batch(p_conteo uuid, p_escaneos jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conteo record;
  v_item jsonb;
  v_codigo_raw text;
  v_client_uuid uuid;
  v_dispositivo text;
  v_delta integer;
  v_norm record;
  v_producto_id uuid;
  v_linea_id uuid;
  v_procesados integer := 0;
  v_duplicados integer := 0;
  v_no_encontrados jsonb := '[]'::jsonb;
begin
  if public.mi_rol() is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo;
  if not found then
    raise exception 'Conteo % no existe', p_conteo;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  if public.mi_rol() <> 'superadmin' and not public.tengo_acceso_sucursal(v_conteo.sucursal_id) then
    raise exception 'No autorizado para esa sucursal';
  end if;

  if v_conteo.estado <> 'abierto' then
    raise exception 'El conteo % ya está cerrado', p_conteo;
  end if;

  for v_item in select * from jsonb_array_elements(p_escaneos)
  loop
    v_codigo_raw := v_item ->> 'codigo_raw';
    begin
      v_client_uuid := (v_item ->> 'client_uuid')::uuid;
    exception when others then
      v_client_uuid := null;
    end;
    v_dispositivo := v_item ->> 'dispositivo';
    v_delta := coalesce((v_item ->> 'delta')::integer, 1);

    if v_codigo_raw is null or v_client_uuid is null then
      continue;
    end if;

    if exists (select 1 from public.escaneos where client_uuid = v_client_uuid) then
      v_duplicados := v_duplicados + 1;
      continue;
    end if;

    select (public.normalizar_codigo(v_codigo_raw)).* into v_norm;

    select p.id into v_producto_id
    from public.productos p
    join public.codigos_barra cb on cb.producto_id = p.id
    where cb.codigo_norm = v_norm.codigo_norm
    limit 1;

    if v_producto_id is null then
      v_no_encontrados := v_no_encontrados || jsonb_build_object(
        'codigo_raw', v_codigo_raw, 'client_uuid', v_client_uuid
      );
      continue;
    end if;

    insert into public.conteo_lineas (conteo_id, producto_id)
    values (p_conteo, v_producto_id)
    on conflict (conteo_id, producto_id) where producto_id is not null
    do update set conteo_id = excluded.conteo_id
    returning id into v_linea_id;

    insert into public.escaneos (
      conteo_id, linea_id, codigo_raw, codigo_norm, delta, lote,
      vencimiento, usuario_id, dispositivo, client_uuid
    )
    values (
      p_conteo, v_linea_id, v_codigo_raw, v_norm.codigo_norm, v_delta,
      v_norm.lote, v_norm.vencimiento, auth.uid(), v_dispositivo, v_client_uuid
    )
    on conflict (client_uuid) do nothing;

    v_procesados := v_procesados + 1;
  end loop;

  return json_build_object(
    'procesados', v_procesados,
    'duplicados', v_duplicados,
    'no_encontrados', v_no_encontrados
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- resumen_conteo
-- ═══════════════════════════════════════════════════════════════
-- El spec dice "solo ejecutable por rol gerente" — se agrega superadmin
-- también (mismo criterio que el resto del esquema: superadmin ve todo).
--
-- Cubre las métricas de Fase 6 que se pueden calcular con el esquema tal
-- cual queda en Fase 1 (unidades, SKUs, valorización, productividad por
-- operario, desconocidos pendientes). "Top 20 por valor inmovilizado" y
-- "comparativo contra sucursales/conteo anterior" quedan para cuando
-- Fase 6 defina la UI real que los consume — la forma de este json puede
-- cambiar en ese momento.

create function resumen_conteo(p_conteo uuid)
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
  if public.mi_rol() not in ('gerente', 'superadmin') then
    raise exception 'Solo el rol gerente puede ver el resumen de un conteo';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo;
  if not found then
    raise exception 'Conteo % no existe', p_conteo;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  select jsonb_build_object(
    'conteo_id', v_conteo.id,
    'estado', v_conteo.estado,
    'unidades_totales', coalesce(sum(cl.cantidad), 0),
    'skus_distintos', count(distinct cl.producto_id) filter (where cl.producto_id is not null),
    'valor_costo', coalesce(sum(cl.cantidad * pe.costo), 0),
    'valor_precio', coalesce(sum(cl.cantidad * pe.precio), 0),
    'desconocidos_pendientes', (
      select count(*) from public.conteo_lineas cl2
      where cl2.conteo_id = p_conteo and cl2.desconocido_id is not null
    ),
    'productividad_por_operario', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select e.usuario_id, count(*) as escaneos
        from public.escaneos e
        where e.conteo_id = p_conteo
        group by e.usuario_id
      ) t
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
