-- Corrige 20260930000001: esa primera pasada de la calculadora de
-- precios tenía UNA sola regla global para "blíster" y otra para
-- "unidad", aplicada por igual a las 7 presentaciones fraccionables
-- (comprimidos, capsulas, tabletas, supositorios, ovulos, ampollas,
-- vial — ver PRESENTACIONES_FRACCIONABLES en
-- packages/db/src/campos-producto.ts). Eso no sirve: el margen de
-- "blíster" de comprimidos no tiene por qué ser el mismo que el de
-- "bandeja" de ampollas (pedido explícito del usuario, corrigiendo la
-- primera pasada). Ahora hay una regla `default` (fallback) y reglas
-- puntuales `por_presentacion`, indexadas por el mismo string que ya usa
-- `productos.unidad`.
--
-- Firma nueva (jsonb único en vez de 4 escalares) porque el shape ahora
-- es abierto —tantas entradas como presentaciones fraccionables tenga
-- configuradas la empresa—, mismo criterio que ya usa
-- actualizar_campos_personalizados_empresa (20260813000010) para su
-- array abierto. Signature distinta = Postgres no la reemplaza sola, hay
-- que dropear la vieja explícitamente.
drop function if exists actualizar_calculadora_precios_empresa(text, numeric, text, numeric);

-- Helpers de validación, reusados dos veces (default + cada entrada de
-- por_presentacion) — separados en vez de repetir el cuerpo, a
-- diferencia del resto de este archivo de RPCs que suele ser un único
-- bloque: acá el anidamiento (config → niveles → regla) lo pedía.
create function es_regla_calculadora_valida(p_regla jsonb)
returns boolean
language plpgsql
as $$
begin
  if p_regla is null or jsonb_typeof(p_regla) = 'null' then
    return true;
  end if;
  if jsonb_typeof(p_regla) <> 'object' then
    return false;
  end if;
  if (p_regla ->> 'operacion') not in ('suma', 'multiplicador', 'porcentaje') then
    return false;
  end if;
  begin
    if (p_regla ->> 'valor') is null or (p_regla ->> 'valor')::numeric is null then
      return false;
    end if;
  exception when others then
    return false;
  end;
  return true;
end;
$$;

comment on function es_regla_calculadora_valida(jsonb) is
  'true si p_regla es null (sin regla, válido) o {"operacion": suma|multiplicador|porcentaje, "valor": numeric}. Usado solo por actualizar_calculadora_precios_empresa.';

create function es_niveles_calculadora_validos(p_niveles jsonb)
returns boolean
language plpgsql
as $$
begin
  if p_niveles is null or jsonb_typeof(p_niveles) = 'null' then
    return true;
  end if;
  if jsonb_typeof(p_niveles) <> 'object' then
    return false;
  end if;
  return public.es_regla_calculadora_valida(p_niveles -> 'nivel_intermedio')
     and public.es_regla_calculadora_valida(p_niveles -> 'unidad');
end;
$$;

comment on function es_niveles_calculadora_validos(jsonb) is
  'true si p_niveles es null o {"nivel_intermedio": <regla>|null, "unidad": <regla>|null}, cada una validada con es_regla_calculadora_valida.';

-- p_config: {"default": <niveles>|null, "por_presentacion": {"<presentacion>": <niveles>, ...}}.
-- Mismo permiso y mismo mecanismo (empresas.config, jsonb || jsonb) que
-- vencimiento_semaforo/campos_personalizados (20260813000007/20260813000010).
create function actualizar_calculadora_precios_empresa(p_config jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_empresa_id uuid := public.mi_empresa_id();
  -- Mismo listado que PRESENTACIONES_FRACCIONABLES en
  -- packages/db/src/campos-producto.ts (derivado ahí de
  -- CAMPOS_POR_PRESENTACION con fraccionable=true) — no hay generación de
  -- código compartida entre SQL y TS en este proyecto, así que si se marca
  -- una presentación nueva como fraccionable allá, hay que sumarla acá
  -- también (mismo patrón ya documentado en
  -- actualizar_config_operativa_empresa para campos_requeridos_importacion).
  v_presentaciones_validas text[] := array[
    'comprimidos', 'capsulas', 'tabletas', 'supositorios', 'ovulos', 'ampollas', 'vial'
  ];
  v_key text;
  v_valor jsonb;
begin
  if public.mi_rol() not in ('admin', 'gerente') then
    raise exception 'No autorizado para editar la calculadora de precios';
  end if;

  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'Config de calculadora inválida';
  end if;

  if not public.es_niveles_calculadora_validos(p_config -> 'default') then
    raise exception 'La regla por defecto de la calculadora es inválida';
  end if;

  if p_config ? 'por_presentacion' and jsonb_typeof(p_config -> 'por_presentacion') <> 'null' then
    if jsonb_typeof(p_config -> 'por_presentacion') <> 'object' then
      raise exception 'por_presentacion tiene que ser un objeto';
    end if;

    for v_key, v_valor in select * from jsonb_each(p_config -> 'por_presentacion')
    loop
      if not (v_key = any (v_presentaciones_validas)) then
        raise exception 'Presentación desconocida para la calculadora: %', v_key;
      end if;
      if not public.es_niveles_calculadora_validos(v_valor) then
        raise exception 'Regla inválida para la presentación %', v_key;
      end if;
    end loop;
  end if;

  update public.empresas
  set config = config || jsonb_build_object('calculadora_precios', p_config)
  where id = v_empresa_id;

  return json_build_object('empresa_id', v_empresa_id);
end;
$$;
