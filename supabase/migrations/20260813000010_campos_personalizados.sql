-- Campos personalizados reales, a pedido explícito del usuario: los 4
-- campos fijos de 20260813000007 (fabricante/distribuidor/lote/lote2)
-- no alcanzaban — quiere poder definir SUS PROPIOS campos, no una lista
-- cerrada que yo elegí.
--
-- Definiciones (nombre de cada campo) en `empresas.config.campos_
-- personalizados` — mismo mecanismo que campos_requeridos_importacion/
-- vencimiento_semaforo (20260813000007), RPC propio en vez del patrón
-- JS spread-merge que solo funciona para superadmin. VALORES en
-- `productos_empresa.campos_extra` (jsonb, clave → valor de texto) — es
-- dato de la relación empresa-producto, mismo criterio que costo/
-- distribuidor/lote_catalogo, así que se escribe con el mismo INSERT/
-- UPDATE directo que ya usa el ABM (RLS de Fase 2 ya lo permite para
-- admin/gerente/superadmin), sin necesitar un RPC nuevo para los
-- valores — solo para las DEFINICIONES, que viven en `empresas.config`.

alter table productos_empresa
  add column campos_extra jsonb not null default '{}'::jsonb;

-- p_campos: array de {"clave": "...", "etiqueta": "..."}. "clave" es el
-- identificador interno (se usa como key dentro de campos_extra) —
-- restringido a minúsculas/números/guión bajo para poder usarse como
-- key de jsonb sin sorpresas; "etiqueta" es lo que se muestra en la UI.
create function actualizar_campos_personalizados_empresa(p_campos jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_empresa_id uuid := public.mi_empresa_id();
  v_item jsonb;
  v_clave text;
  v_etiqueta text;
  v_claves text[] := '{}';
begin
  if public.mi_rol() not in ('admin', 'gerente') then
    raise exception 'No autorizado para editar los campos personalizados';
  end if;

  if p_campos is null or jsonb_typeof(p_campos) is distinct from 'array' then
    raise exception 'p_campos tiene que ser un array';
  end if;

  if jsonb_array_length(p_campos) > 20 then
    raise exception 'Demasiados campos personalizados (máximo 20)';
  end if;

  for v_item in select * from jsonb_array_elements(p_campos)
  loop
    v_clave := v_item ->> 'clave';
    v_etiqueta := nullif(trim(v_item ->> 'etiqueta'), '');

    if v_clave is null or v_clave !~ '^[a-z0-9_]{1,40}$' then
      raise exception 'Clave de campo inválida: %', v_clave;
    end if;
    if v_etiqueta is null then
      raise exception 'Falta la etiqueta del campo "%"', v_clave;
    end if;
    if v_clave = any (v_claves) then
      raise exception 'Clave repetida: %', v_clave;
    end if;
    v_claves := array_append(v_claves, v_clave);
  end loop;

  update public.empresas
  set config = config || jsonb_build_object('campos_personalizados', p_campos)
  where id = v_empresa_id;

  return json_build_object('empresa_id', v_empresa_id);
end;
$$;
