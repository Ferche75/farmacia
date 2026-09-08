-- Bug real, en producción: resumen_conteo() y su gate en el frontend
-- (apps/admin/app/(app)/conteos/[id]/detalle-conteo.tsx) excluían al rol
-- 'admin', dejando solo 'gerente'/'superadmin'. CONTEXTO.md dice
-- explícitamente que apps/admin (incluido "el resumen gerencial") es para
-- admin/gerente/superadmin — el chequeo nunca reflejó eso.
--
-- Efecto en producción: un usuario admin que entra al detalle de un
-- conteo ve el encabezado (eso lo carga la Server Component, sin RPC) y
-- después nada — ResumenGerencial ni se pedía porque puedeVerResumen daba
-- false. Si de alguna forma se hubiera pedido igual, el RPC lo habría
-- rechazado con 'Solo el rol gerente puede ver el resumen de un conteo'.
--
-- CREATE OR REPLACE: mismo cuerpo que 20260806000008, un solo cambio —
-- 'admin' entra a la lista de roles permitidos (acá y en el mensaje de
-- error).
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
