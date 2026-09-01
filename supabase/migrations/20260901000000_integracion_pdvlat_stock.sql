-- Integración con el POS externo "pdvlat" (Express + MySQL, repo aparte).
--
-- Farmacia sigue siendo la fuente de verdad del CATÁLOGO (nombre, código
-- de barras, principio activo, lote/vencimiento). pdvlat, al vender,
-- llama a la API de Farmacia para descontar stock en el momento, sin
-- esperar al próximo conteo físico.
--
-- Esta migración hace tres cosas:
--   1. Despierta `movimientos_stock` (tabla reservada desde Fase 1, con
--      RLS habilitada y CERO policies — CONTEXTO.md decía "no construir
--      hasta que se pida"; ahora se pidió).
--   2. Agrega `registrar_venta` (escritura, solo service_role) y
--      `stock_actual` (lectura) — el stock permanente que faltaba.
--   3. Agrega `integraciones_pdv`: el pairing empresa(Farmacia) ↔
--      tenant(pdvlat) y las credenciales servidor-a-servidor.


-- ═══════════════════════════════════════════════════════════════
-- 1. movimientos_stock: activación
-- ═══════════════════════════════════════════════════════════════

-- usuario_id se creó NOT NULL en Fase 1 asumiendo que todo movimiento
-- nacía de una acción de un usuario de Farmacia. Una venta de pdvlat no
-- tiene ningún perfil de Farmacia detrás (es tráfico servidor-a-servidor,
-- el cajero es un usuario del POS, que Farmacia no conoce). Queda
-- nullable: null = "lo generó una integración externa", y la trazabilidad
-- de esa venta la da `referencia` (el número de orden de pdvlat).
alter table movimientos_stock
  alter column usuario_id drop not null;

-- Índice de trabajo de stock_actual: siempre se consulta por
-- (empresa, producto) y se filtra/ordena por sucursal + fecha.
create index ix_mov_stock_producto
  on movimientos_stock (empresa_id, producto_id, sucursal_id, created_at);

-- Idempotencia de registrar_venta: se busca "¿ya registré esta orden?"
-- por (empresa, referencia). No es único a propósito — una orden tiene
-- una fila por línea vendida.
create index ix_mov_stock_referencia
  on movimientos_stock (empresa_id, referencia)
  where referencia is not null;

-- SELECT: mismo patrón que `lotes`/`conteos` — la empresa propia y solo
-- las sucursales a las que el usuario tiene acceso. La tabla no lleva
-- costo ni precio (eso vive en productos_empresa, con su propia policy),
-- así que no hace falta excluir a operario.
create policy movimientos_stock_select on movimientos_stock
  for select
  using (
    mi_rol() = 'superadmin'
    or (empresa_id = mi_empresa_id() and tengo_acceso_sucursal(sucursal_id))
  );

-- A propósito SIN policy de INSERT/UPDATE/DELETE para authenticated: el
-- único camino de escritura es `registrar_venta` (SECURITY DEFINER, con
-- EXECUTE revocado a anon/authenticated y concedido solo a service_role),
-- llamada desde el route handler de la integración. Un cliente browser
-- con sesión normal no puede insertar un movimiento ni aunque arme el
-- payload a mano — service_role ignora RLS, así que tampoco necesita una
-- policy propia. Mismo criterio que `lotes` y `escaneos`.


-- ═══════════════════════════════════════════════════════════════
-- 2. stock_actual
-- ═══════════════════════════════════════════════════════════════
-- Criterio (no es obvio, así que queda documentado):
--
-- El stock de un producto = la última FOTO física + todo lo que se movió
-- DESPUÉS de esa foto.
--
--  * La foto es `conteo_lineas.cantidad` del último conteo CERRADO que
--    incluyó a ese producto — NO `lotes.cantidad`. `lotes` solo guarda lo
--    que se escaneó con fecha de vencimiento (ver
--    20260812000003_lotes_vencimiento.sql: "Filas escaneadas sin
--    vencimiento no generan lote acá"), o sea que es un SUBCONJUNTO del
--    conteo. Usarlo como base daría stock 0 para todo lo que se contó sin
--    fecha. `lotes` sigue siendo la fuente para "qué está por vencer",
--    que es otra pregunta.
--
--  * "Último conteo cerrado" se resuelve POR PRODUCTO, no por sucursal:
--    un conteo parcial solo toca algunos SKU, y los que no aparecieron
--    tienen que seguir valiendo lo que dijo su conteo anterior.
--
--  * El ámbito de agregación es (sucursal_id, bodega_id), con bodega_id
--    null tratado como su propio ámbito "la sucursal entera" — misma
--    convención coalesce(bodega_id::text,'') que ya usa la llave única de
--    `lotes` (20260813000000_bodega_en_conteo.sql). Cada ámbito trae su
--    propia foto y sus propios movimientos posteriores, y recién después
--    se suman: así agregar bodegas o sucursales no mezcla cortes de
--    tiempo distintos.
--
--  * Un ámbito sin ningún conteo cerrado para ese producto aporta base 0
--    y TODOS sus movimientos (no hay foto contra la cual recortar).
--
-- SECURITY INVOKER a propósito (no DEFINER como el resto de los RPC): así
-- la RLS de conteos/conteo_lineas/movimientos_stock filtra sola y la
-- función no necesita reimplementar el control de acceso. Un usuario ve
-- el stock de las sucursales a las que tiene acceso; service_role (la
-- integración de pdvlat) ignora RLS y ve todo, como corresponde.
create function stock_actual(
  p_empresa_id uuid,
  p_producto_id uuid,
  p_sucursal_id uuid default null
)
returns integer
language sql
stable
set search_path = ''
as $$
  with ambito as (
    select distinct on (c.sucursal_id, coalesce(c.bodega_id::text, ''))
      c.sucursal_id,
      c.bodega_id,
      c.cerrado_at,
      cl.cantidad
    from public.conteos c
    join public.conteo_lineas cl
      on cl.conteo_id = c.id
     and cl.producto_id = p_producto_id
    where c.empresa_id = p_empresa_id
      and c.estado = 'cerrado'
      and c.cerrado_at is not null
      and (p_sucursal_id is null or c.sucursal_id = p_sucursal_id)
    order by c.sucursal_id, coalesce(c.bodega_id::text, ''), c.cerrado_at desc
  ),
  base as (
    select coalesce(sum(cantidad), 0)::integer as q from ambito
  ),
  posteriores as (
    select coalesce(sum(m.delta), 0)::integer as q
    from public.movimientos_stock m
    left join ambito a
      on a.sucursal_id = m.sucursal_id
     and coalesce(a.bodega_id::text, '') = coalesce(m.bodega_id::text, '')
    where m.empresa_id = p_empresa_id
      and m.producto_id = p_producto_id
      and (p_sucursal_id is null or m.sucursal_id = p_sucursal_id)
      and (a.sucursal_id is null or m.created_at > a.cerrado_at)
  )
  select base.q + posteriores.q from base, posteriores;
$$;


-- ═══════════════════════════════════════════════════════════════
-- 3. registrar_venta
-- ═══════════════════════════════════════════════════════════════
-- Descarga de stock por venta del POS. Recibe la orden COMPLETA (todas
-- sus líneas) en un solo llamado: una función plpgsql corre dentro de una
-- única transacción, así que si una línea falla (código desconocido,
-- cantidad inválida) se revierte la orden entera — todo o nada. Registrar
-- media venta sería peor que no registrarla.
--
-- Idempotente por (empresa_id, referencia): pdvlat puede reintentar el
-- POST sin miedo a descontar dos veces la misma orden. Mismo espíritu que
-- la regla 2 de CONTEXTO.md (client_uuid en escaneos).
--
-- NUNCA confía en un codigo_norm que mande el cliente externo: cada
-- código pasa por normalizar_codigo() acá adentro (CONTEXTO.md regla 4).
--
-- A propósito NO multiplica por codigos_barra.unidades_por_codigo: el
-- conteo físico (registrar_escaneos_batch) tampoco lo hace, así que la
-- unidad de stock del sistema es "lo que se escanea". Multiplicar solo de
-- un lado dejaría el stock descuadrado contra su propia foto base.
--
-- p_lineas: [{"codigo_barra": "7790...", "cantidad": 2},
--            {"producto_id": "uuid", "cantidad": 1}, ...]
create function registrar_venta(
  p_empresa_id uuid,
  p_sucursal_id uuid,
  p_referencia text,
  p_lineas jsonb,
  p_bodega_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referencia text := nullif(trim(coalesce(p_referencia, '')), '');
  v_sucursal record;
  v_bodega record;
  v_item jsonb;
  v_codigo_raw text;
  v_norm text;
  v_producto_id uuid;
  v_cantidad integer;
  v_lineas_ok jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  if v_referencia is null then
    raise exception 'Falta la referencia de la venta (número de orden del POS)';
  end if;

  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'La venta no tiene líneas';
  end if;

  select * into v_sucursal
  from public.sucursales
  where id = p_sucursal_id and empresa_id = p_empresa_id;

  if not found then
    raise exception 'La sucursal % no pertenece a esta empresa', p_sucursal_id;
  end if;

  if not v_sucursal.activo then
    raise exception 'La sucursal % está inactiva', p_sucursal_id;
  end if;

  if p_bodega_id is not null then
    select * into v_bodega
    from public.bodegas
    where id = p_bodega_id;

    if not found then
      raise exception 'La bodega % no existe', p_bodega_id;
    end if;

    if v_bodega.empresa_id <> p_empresa_id or v_bodega.sucursal_id <> p_sucursal_id then
      raise exception 'La bodega % no pertenece a esta sucursal/empresa', p_bodega_id;
    end if;

    if not v_bodega.activo then
      raise exception 'La bodega % está inactiva', p_bodega_id;
    end if;
  end if;

  -- Reintento de una orden ya procesada: no se vuelve a descontar nada.
  if exists (
    select 1 from public.movimientos_stock
    where empresa_id = p_empresa_id
      and tipo = 'venta'
      and referencia = v_referencia
  ) then
    return json_build_object(
      'referencia', v_referencia,
      'duplicada', true,
      'lineas', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'producto_id', m.producto_id,
          'cantidad', -m.delta,
          'stock_resultante', public.stock_actual(p_empresa_id, m.producto_id, p_sucursal_id)
        )), '[]'::jsonb)
        from public.movimientos_stock m
        where m.empresa_id = p_empresa_id
          and m.tipo = 'venta'
          and m.referencia = v_referencia
      )
    );
  end if;

  for v_item in select * from jsonb_array_elements(p_lineas)
  loop
    begin
      v_cantidad := (v_item ->> 'cantidad')::integer;
    exception when others then
      v_cantidad := null;
    end;

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'Cantidad inválida en una línea de la venta %: %',
        v_referencia, (v_item ->> 'cantidad');
    end if;

    v_producto_id := null;

    if nullif(trim(coalesce(v_item ->> 'producto_id', '')), '') is not null then
      begin
        v_producto_id := (v_item ->> 'producto_id')::uuid;
      exception when others then
        raise exception 'producto_id inválido en la venta %: %',
          v_referencia, (v_item ->> 'producto_id');
      end;

      if not exists (select 1 from public.productos where id = v_producto_id) then
        raise exception 'El producto % no existe en el catálogo', v_producto_id;
      end if;
    else
      v_codigo_raw := nullif(trim(coalesce(v_item ->> 'codigo_barra', '')), '');

      if v_codigo_raw is null then
        raise exception 'Cada línea de la venta necesita codigo_barra o producto_id';
      end if;

      -- Normalización server-side, siempre (CONTEXTO.md regla 4).
      v_norm := (public.normalizar_codigo(v_codigo_raw)).codigo_norm;

      if v_norm is null then
        raise exception 'Código de barras ilegible: %', v_codigo_raw;
      end if;

      select cb.producto_id into v_producto_id
      from public.codigos_barra cb
      where cb.codigo_norm = v_norm
      limit 1;

      if v_producto_id is null then
        raise exception 'El código % no existe en el catálogo de Farmacia', v_codigo_raw;
      end if;
    end if;

    insert into public.movimientos_stock (
      empresa_id, sucursal_id, bodega_id, producto_id, tipo, delta,
      referencia, usuario_id
    )
    values (
      p_empresa_id, p_sucursal_id, p_bodega_id, v_producto_id, 'venta',
      -v_cantidad, v_referencia, null
    );

    v_total := v_total + v_cantidad;
    v_lineas_ok := v_lineas_ok || jsonb_build_object(
      'producto_id', v_producto_id,
      'cantidad', v_cantidad,
      'stock_resultante', public.stock_actual(p_empresa_id, v_producto_id, p_sucursal_id)
    );
  end loop;

  return json_build_object(
    'referencia', v_referencia,
    'duplicada', false,
    'unidades_vendidas', v_total,
    'lineas', v_lineas_ok
  );
end;
$$;

-- Solo service_role. Es una función SECURITY DEFINER (corre como el dueño
-- del esquema, sin RLS) que recibe empresa_id como parámetro: si quedara
-- ejecutable por `authenticated`, cualquier usuario logueado podría
-- descontar stock de OTRA empresa pasándole su uuid. El único caller
-- legítimo es el route handler de /api/pdvlat/ventas, que ya autenticó a
-- pdvlat contra integraciones_pdv y usa la service_role key.
revoke all on function registrar_venta(uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function registrar_venta(uuid, uuid, text, jsonb, uuid) to service_role;


-- ═══════════════════════════════════════════════════════════════
-- 4. integraciones_pdv
-- ═══════════════════════════════════════════════════════════════
-- Pairing empresa(Farmacia) ↔ tenant(pdvlat) + credenciales de la API
-- servidor-a-servidor. Una fila por empresa (empresa_id único).
--
-- Flujo de alta, pensado para que nadie tenga que copiar un secreto por
-- WhatsApp:
--   1. El admin/gerente entra a "Mi empresa" en apps/admin y genera un
--      código de invitación corto (válido 72 h, de un solo uso).
--   2. Se lo dicta al operador de pdvlat.
--   3. pdvlat hace POST /api/pdvlat/vincular con {codigo, tenant_id}.
--      Ahí — y solo ahí — Farmacia devuelve api_key + api_secret, rotando
--      los que hubiera. El código queda consumido.
--   4. pdvlat guarda esas credenciales y las manda en cada request.
--
-- El secreto se guarda en claro, mismo criterio que
-- empresas.config.n8n_webhook_secret (20260806000006): es un secreto
-- compartido, no una contraseña de usuario, y el admin dueño tiene que
-- poder volver a verlo si lo perdió. La protección es la policy de
-- SELECT de abajo, no un hash.
create table integraciones_pdv (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null unique references empresas (id) on delete cascade,
  api_key text not null unique,
  api_secret text not null,
  codigo_invitacion text unique,
  codigo_expira_at timestamptz,
  tenant_id_pdvlat text,
  vinculado_at timestamptz,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- codigo_invitacion no necesita índice propio: el `unique` de la columna
-- ya crea el que usa la búsqueda de vincular_integracion_pdv.

create trigger integraciones_pdv_set_updated_at
  before update on integraciones_pdv
  for each row
  execute function set_updated_at();

alter table integraciones_pdv enable row level security;

-- Lectura solo para quien administra la empresa. Operario no: la fila
-- lleva las credenciales que dan acceso al catálogo con costo/precio, así
-- que es tan sensible como productos_empresa (CONTEXTO.md regla 3).
create policy integraciones_pdv_select on integraciones_pdv
  for select
  using (
    mi_rol() = 'superadmin'
    or (empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente'))
  );

-- Sin policies de escritura: se escribe solo por los dos RPC de abajo.

-- Aleatoriedad criptográfica sin depender de pgcrypto (que en Supabase
-- vive en el esquema `extensions` y obligaría a calificar el nombre desde
-- funciones con search_path=''): gen_random_uuid() es built-in de
-- Postgres 13+ y sale de la misma fuente del sistema. Dos UUID v4
-- concatenados = 244 bits reales de entropía, de sobra para un secreto
-- de integración.
create function generar_secreto_pdv()
returns text
language sql
volatile
set search_path = ''
as $$
  select replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');
$$;

-- Código de invitación: 12 caracteres hexadecimales en mayúscula, para
-- dictarlo por teléfono. El alfabeto hex (0-9 A-F) no tiene los pares
-- ambiguos O/0 ni I/1/l. 48 bits + vencimiento de 72 h + un solo uso.
create function generar_codigo_invitacion_texto()
returns text
language sql
volatile
set search_path = ''
as $$
  select upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 12));
$$;

-- ── generar_codigo_invitacion_pdv ──────────────────────────────
-- Crea la integración de la empresa si todavía no existe y le pone un
-- código de invitación nuevo (el anterior, si lo había, deja de servir).
--
-- p_empresa_id null = mi propia empresa. Un no-superadmin solo puede
-- operar sobre la suya — mismo criterio que
-- actualizar_datos_contacto_empresa (20260813000001), que directamente ni
-- acepta el parámetro; acá se acepta porque el superadmin sí necesita
-- poder dar de alta la integración de un cliente.
--
-- NO rota api_key/api_secret: si la empresa ya tenía pdvlat andando y
-- alguien genera un código nuevo por error, la integración vigente sigue
-- funcionando. La rotación pasa al canjear el código (vincular).
create function generar_codigo_invitacion_pdv(p_empresa_id uuid default null)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := public.mi_rol();
  v_empresa_id uuid := coalesce(p_empresa_id, public.mi_empresa_id());
  v_fila record;
begin
  if v_rol not in ('admin', 'gerente', 'superadmin') then
    raise exception 'No autorizado para configurar la integración con el punto de venta';
  end if;

  if v_rol <> 'superadmin' and v_empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para esa empresa';
  end if;

  if not exists (select 1 from public.empresas where id = v_empresa_id) then
    raise exception 'La empresa % no existe', v_empresa_id;
  end if;

  insert into public.integraciones_pdv (
    empresa_id, api_key, api_secret, codigo_invitacion, codigo_expira_at
  )
  values (
    v_empresa_id,
    'pdv_' || public.generar_secreto_pdv(),
    public.generar_secreto_pdv(),
    public.generar_codigo_invitacion_texto(),
    now() + interval '72 hours'
  )
  on conflict (empresa_id) do update set
    codigo_invitacion = public.generar_codigo_invitacion_texto(),
    codigo_expira_at = now() + interval '72 hours',
    activo = true
  returning * into v_fila;

  return json_build_object(
    'empresa_id', v_fila.empresa_id,
    'codigo_invitacion', v_fila.codigo_invitacion,
    'codigo_expira_at', v_fila.codigo_expira_at,
    'vinculado', v_fila.vinculado_at is not null,
    'tenant_id_pdvlat', v_fila.tenant_id_pdvlat
  );
end;
$$;

-- ── vincular_integracion_pdv ───────────────────────────────────
-- Canje del código. Lo llama el route handler /api/pdvlat/vincular con la
-- service_role key (pdvlat no tiene sesión de Supabase). Devuelve las
-- credenciales UNA sola vez, en el momento del canje, y las rota: quien
-- canjea un código nuevo invalida las credenciales viejas.
--
-- El código se compara tolerando guiones/espacios/minúsculas — se dicta
-- por teléfono y se escribe a mano del otro lado.
create function vincular_integracion_pdv(p_codigo text, p_tenant_id text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := upper(regexp_replace(coalesce(p_codigo, ''), '[^0-9A-Fa-f]', '', 'g'));
  v_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  v_fila record;
  v_empresa record;
begin
  if v_codigo = '' then
    raise exception 'Falta el código de vinculación';
  end if;

  if v_tenant is null then
    raise exception 'Falta el identificador del tenant de pdvlat';
  end if;

  select * into v_fila
  from public.integraciones_pdv
  where codigo_invitacion = v_codigo
    and activo
    and codigo_expira_at > now()
  for update;

  if not found then
    raise exception 'Código de vinculación inválido o vencido';
  end if;

  update public.integraciones_pdv
  set tenant_id_pdvlat = v_tenant,
      vinculado_at = now(),
      codigo_invitacion = null,
      codigo_expira_at = null,
      api_key = 'pdv_' || public.generar_secreto_pdv(),
      api_secret = public.generar_secreto_pdv()
  where id = v_fila.id
  returning * into v_fila;

  select * into v_empresa from public.empresas where id = v_fila.empresa_id;

  return json_build_object(
    'empresa_id', v_fila.empresa_id,
    'empresa_nombre', v_empresa.nombre,
    'tenant_id_pdvlat', v_fila.tenant_id_pdvlat,
    'api_key', v_fila.api_key,
    'api_secret', v_fila.api_secret,
    'vinculado_at', v_fila.vinculado_at
  );
end;
$$;

-- Solo service_role, por lo mismo que registrar_venta: devuelve
-- credenciales y no valida ninguna sesión (no puede — quien la llama es
-- un servidor externo sin usuario de Farmacia). Su control de acceso es
-- el código de invitación de un solo uso, y el rate limiting lo pone el
-- route handler.
revoke all on function vincular_integracion_pdv(text, text) from public, anon, authenticated;
grant execute on function vincular_integracion_pdv(text, text) to service_role;

-- Los generadores de secretos tampoco tienen por qué ser llamables desde
-- el browser: son building blocks de los dos RPC de arriba.
revoke all on function generar_secreto_pdv() from public, anon, authenticated;
revoke all on function generar_codigo_invitacion_texto() from public, anon, authenticated;
