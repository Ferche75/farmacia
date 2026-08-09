-- Corrección post-revisión del gap documentado en
-- 20260806000007_cierre_resumen.sql: el desglose "resueltos por IA /
-- resueltos manualmente" del resumen gerencial estaba a nivel EMPRESA,
-- no por conteo, porque resolver_desconocido() (Fase 4) borra
-- conteo_lineas.desconocido_id al migrar la línea y no quedaba forma de
-- saber en qué conteo se DETECTÓ originalmente un desconocido ya
-- resuelto. Se agrega una columna que sobrevive la resolución,
-- específicamente para esto — no se toca conteo_lineas para nada.

alter table desconocidos
  add column conteo_deteccion_id uuid references conteos (id) on delete set null;

comment on column desconocidos.conteo_deteccion_id is
  'Conteo donde se detectó por primera vez este código (no cambia aunque se re-escanee en otros conteos después). Null en desconocidos creados antes de esta migración — ese dato no se puede reconstruir retroactivamente.';

-- CREATE OR REPLACE: misma función de Fase 4, un solo cambio — guarda
-- p_conteo en conteo_deteccion_id al crear un desconocido nuevo.
create or replace function registrar_escaneo_desconocido(
  p_conteo uuid,
  p_codigo_raw text,
  p_client_uuid uuid,
  p_foto_path text default null,
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
  v_desconocido_id uuid;
  v_es_nuevo boolean := false;
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

  v_codigo_norm := (public.normalizar_codigo(p_codigo_raw)).codigo_norm;
  if v_codigo_norm is null then
    raise exception 'Código inválido';
  end if;

  if exists (select 1 from public.codigos_barra where codigo_norm = v_codigo_norm) then
    raise exception
      'codigo_ya_en_catalogo: este código ya está en el catálogo, el dispositivo tenía datos desactualizados — refrescá el catálogo local';
  end if;

  select id into v_desconocido_id
  from public.desconocidos
  where empresa_id = v_empresa_id and codigo_norm = v_codigo_norm;

  if v_desconocido_id is null then
    if p_foto_path is null then
      raise exception 'Un desconocido nuevo necesita una foto';
    end if;

    insert into public.desconocidos (
      empresa_id, codigo_norm, codigo_raw, foto_path, estado, detectado_por, conteo_deteccion_id
    )
    values (
      v_empresa_id, v_codigo_norm, p_codigo_raw, p_foto_path, 'pendiente_ia', auth.uid(), p_conteo
    )
    returning id into v_desconocido_id;

    v_es_nuevo := true;
  end if;

  insert into public.conteo_lineas (conteo_id, desconocido_id)
  values (p_conteo, v_desconocido_id)
  on conflict (conteo_id, desconocido_id) where desconocido_id is not null
  do update set conteo_id = excluded.conteo_id
  returning id into v_linea_id;

  insert into public.escaneos (
    conteo_id, linea_id, codigo_raw, codigo_norm, delta, usuario_id, dispositivo, client_uuid
  )
  values (
    p_conteo, v_linea_id, p_codigo_raw, v_codigo_norm, 1, auth.uid(), p_dispositivo, p_client_uuid
  )
  on conflict (client_uuid) do nothing;

  return json_build_object(
    'desconocido_id', v_desconocido_id,
    'es_nuevo', v_es_nuevo,
    'linea_id', v_linea_id
  );
end;
$$;

-- resumen_conteo: ahora puede dar el desglose EXACTO de este conteo
-- puntual (conteo_deteccion_id = p_conteo), además de mantener los
-- totales a nivel empresa que ya devolvía (siguen siendo útiles como
-- contexto general — no se sacó nada, solo se agregó precisión).
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

  v_horas := greatest(
    extract(epoch from (coalesce(v_conteo.cerrado_at, now()) - v_conteo.iniciado_at)) / 3600.0,
    1.0 / 60 -- piso de 1 minuto, evita división por ~0 en conteos recién abiertos
  );

  select jsonb_build_object(
    'conteo_id', v_conteo.id,
    'estado', v_conteo.estado,

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
          round(count(*) / v_horas, 1) as escaneos_por_hora
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
