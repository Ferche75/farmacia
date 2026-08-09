-- Fase 6: cierre de conteo + resumen gerencial ampliado + comparativo.
--
-- Gap de diseño heredado de Fase 4, documentado acá porque es donde se
-- nota: resolver_desconocido() (Fase 4) migra conteo_lineas.desconocido_id
-- a null cuando se resuelve, a propósito (así el UNIQUE de
-- conteo_lineas(conteo_id, producto_id) puede aplicar). Consecuencia:
-- una vez resuelto, ya no se puede saber desde conteo_lineas "esta línea
-- ERA un desconocido de ESTE conteo en particular". Por eso el desglose
-- de desconocidos "resueltos por IA / resueltos manualmente" de este
-- resumen es a nivel EMPRESA (todo el historial), no filtrado a este
-- conteo puntual — es lo único que el esquema permite responder con
-- precisión. "Pendientes" sí es preciso por conteo (esos todavía tienen
-- desconocido_id sin migrar).

create function cerrar_conteo(p_conteo_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conteo record;
  v_desconocidos_pendientes integer;
begin
  if public.mi_rol() not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para cerrar conteos';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo_id;
  if not found then
    raise exception 'Conteo % no existe', p_conteo_id;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  if v_conteo.estado = 'cerrado' then
    raise exception 'El conteo ya está cerrado';
  end if;

  select count(*) into v_desconocidos_pendientes
  from public.conteo_lineas
  where conteo_id = p_conteo_id and desconocido_id is not null;

  update public.conteos
  set estado = 'cerrado', cerrado_at = now(), cerrado_por = auth.uid()
  where id = p_conteo_id;

  -- A partir de acá el conteo queda de solo lectura de verdad: tanto
  -- registrar_escaneos_batch como registrar_escaneo_desconocido (Fases 1
  -- y 4) ya chequean `estado <> 'abierto'` y rechazan cualquier escritura.

  return json_build_object(
    'id', p_conteo_id,
    'desconocidos_pendientes', v_desconocidos_pendientes
  );
end;
$$;

-- CREATE OR REPLACE: reemplaza el resumen_conteo de Fase 1, no es una
-- función nueva — mismo nombre, mismo contrato de seguridad
-- (gerente/superadmin), respuesta ampliada con lo que pide Fase 6.
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

-- Comparativo: conteo anterior CERRADO de la misma sucursal, y el
-- conteo cerrado más reciente de cada OTRA sucursal de la empresa.
create function comparar_conteo(p_conteo_id uuid)
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
    raise exception 'Solo el rol gerente puede ver comparativos';
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
