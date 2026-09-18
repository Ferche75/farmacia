-- Calculadora de precios por presentación — ayuda a PRECARGAR, no
-- reemplaza la carga manual.
--
-- Contexto (ver HANDOFF-calculadora-precios.md en la raíz del repo, que
-- describe un diseño viejo, DESCARTADO): en
-- 20260918000001_fraccionamiento_marca_y_lotes_manuales.sql se confirmó
-- explícitamente con el usuario que precio_blister y precio_unidad son
-- independientes del precio de caja y los fija el vendedor A MANO —
-- llevarse la caja sale más barato por unidad que comprar suelto, así
-- que no son una simple fracción. Esa decisión NO se toca acá.
--
-- Lo que pide ahora el Claude del lado de pdvlat es una calculadora que
-- VIVE en Farmacia (donde se carga el producto) y le ahorra al
-- farmacéutico la cuenta a mano: a partir del precio de caja + una
-- regla configurable por empresa, sugiere un precio_blister y un
-- precio_unidad de arranque. El vendedor los ve como propuesta editable
-- en el formulario (apps/admin/lib/calculadora-precios.ts +
-- productos-abm.tsx) y decide si los usa tal cual, los ajusta o los
-- ignora — nada se guarda solo. Por eso acá NO hace falta ninguna tabla
-- nueva ni tocar /api/pdvlat/catalogo: la sugerencia es 100% client-side
-- contra los 3 campos que ya existen.
--
-- Solo 2 reglas por empresa (una para "blíster", una para "unidad"), no
-- una lista abierta de tipos: el modelo de fraccionamiento de este repo
-- ya es fijo a 3 niveles (caja/blíster/unidad), a diferencia del diseño
-- descartado que asumía tipos de presentación abiertos por código de
-- barra. Mismo mecanismo de guardado que vencimiento_semaforo/
-- campos_personalizados (20260813000007/20260813000010): jsonb libre en
-- empresas.config, RPC propio con SECURITY DEFINER porque admin/gerente
-- no tiene UPDATE directo sobre `empresas`.
create function actualizar_calculadora_precios_empresa(
  p_blister_operacion text,
  p_blister_valor numeric,
  p_unidad_operacion text,
  p_unidad_valor numeric
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_empresa_id uuid := public.mi_empresa_id();
begin
  if public.mi_rol() not in ('admin', 'gerente') then
    raise exception 'No autorizado para editar la calculadora de precios';
  end if;

  if p_blister_operacion is not null and p_blister_operacion not in ('suma', 'multiplicador', 'porcentaje') then
    raise exception 'Operación de blíster inválida: %', p_blister_operacion;
  end if;
  if p_unidad_operacion is not null and p_unidad_operacion not in ('suma', 'multiplicador', 'porcentaje') then
    raise exception 'Operación de unidad inválida: %', p_unidad_operacion;
  end if;
  -- Regla a medio cargar (operación sin valor, o viceversa) no tiene
  -- sentido: o está la regla completa, o no hay regla (null, "todavía
  -- sin configurar" — la sugerencia simplemente no aparece).
  if (p_blister_operacion is null) <> (p_blister_valor is null) then
    raise exception 'La regla de blíster necesita operación y valor juntos';
  end if;
  if (p_unidad_operacion is null) <> (p_unidad_valor is null) then
    raise exception 'La regla de unidad necesita operación y valor juntos';
  end if;

  update public.empresas
  set config = config || jsonb_build_object(
    'calculadora_precios', jsonb_build_object(
      'blister', case when p_blister_operacion is null then null
        else jsonb_build_object('operacion', p_blister_operacion, 'valor', p_blister_valor) end,
      'unidad', case when p_unidad_operacion is null then null
        else jsonb_build_object('operacion', p_unidad_operacion, 'valor', p_unidad_valor) end
    )
  )
  where id = v_empresa_id;

  return json_build_object('empresa_id', v_empresa_id);
end;
$$;
