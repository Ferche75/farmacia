-- Hasta ahora, un código "No encontrado" en el conteo solo ofrecía
-- "Tomar foto" (dispara IA vía n8n, y recién un admin/gerente lo resuelve
-- después desde la tarjeta de sugerencia o la bandeja de revisión). Pedido
-- explícito del usuario: quien está contando tiene que poder cargar el
-- producto completo (nombre, laboratorio, concentración, presentación) AHÍ
-- MISMO, sin foto ni esperar a que nadie más lo revise — hay datos que la
-- IA nunca va a poder adivinar bien solo con una foto.
--
-- Es un camino nuevo y paralelo a registrar_escaneo_desconocido/
-- resolver_desconocido, no un reemplazo: no pasa por la tabla
-- `desconocidos` en absoluto (no hay nada que revisar después, el
-- producto ya se crea completo y confirmado). Mismo criterio de permisos
-- que registrar_escaneo_desconocido (mi_rol() is not null, no se exige
-- admin/gerente) — a propósito, porque el punto es que la persona que
-- cuenta lo resuelva sola, sin depender de otro rol. Si más adelante hace
-- falta acotar esto a admin/gerente, es cambiar una sola condición acá.
create function crear_producto_y_contar(
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
    nombre, laboratorio_id, principio_activo, concentracion, forma, contenido, unidad, origen
  )
  values (
    p_nuevo_producto ->> 'nombre',
    v_laboratorio_id,
    p_nuevo_producto ->> 'principio_activo',
    p_nuevo_producto ->> 'concentracion',
    p_nuevo_producto ->> 'forma',
    nullif(p_nuevo_producto ->> 'contenido', '')::numeric,
    p_nuevo_producto ->> 'unidad',
    'manual'
  )
  returning id into v_producto_id;

  insert into public.codigos_barra (producto_id, codigo_norm, codigo_raw, es_principal)
  values (v_producto_id, v_codigo_norm, p_codigo_raw, true);

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
