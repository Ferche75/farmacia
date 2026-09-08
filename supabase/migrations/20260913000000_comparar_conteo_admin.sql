-- Mismo bug que 20260911000000, en una función hermana que se nos pasó
-- esa vez: comparar_conteo (llamada junto con resumen_conteo desde
-- ResumenGerencial, en paralelo) también excluía a 'admin'. Con
-- resumen_conteo ya arreglado, ResumenGerencial seguía rompiendo porque
-- el Promise.all de las dos fallaba si cualquiera de las dos tiraba.
--
-- CREATE OR REPLACE: mismo cuerpo que 20260806000007, un solo cambio —
-- 'admin' entra a la lista de roles permitidos.
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
