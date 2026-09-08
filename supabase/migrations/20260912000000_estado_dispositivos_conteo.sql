-- Gap de soporte real (cliente en Bolivia, 2026-09): un operario dijo
-- haber sacado fotos de productos desconocidos y del lado del servidor no
-- había NADA — cero filas en `desconocidos`, cero archivos en el bucket.
-- O sea: la cola local del celular (Dexie, apps/conteo/lib/motor-sync.ts)
-- nunca logró subir nada. apps/conteo ya muestra "N sin sincronizar" EN
-- LA PANTALLA DEL DISPOSITIVO, pero eso no sale del teléfono: el admin no
-- tiene forma de saberlo sin pedirle al operario que le lea la pantalla
-- por WhatsApp.
--
-- Esto agrega un canal de telemetría SEPARADO del sync de datos real:
-- solo números y texto corto, barato de mandar, para que pase incluso
-- cuando subir una foto no pasa. NO toca registrar_escaneos_batch,
-- registrar_escaneo_desconocido ni crear_producto_y_contar — es aditivo,
-- no cambia cómo se sincronizan los datos de verdad.

create table conteo_dispositivos_estado (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas (id),
  conteo_id uuid not null references conteos (id) on delete cascade,
  -- Mismo "dispositivo" flojo que escaneos.dispositivo: el user agent
  -- truncado que devuelve dispositivoActual() en
  -- apps/conteo/lib/motor-escaneo.ts. No es un identificador estable ni
  -- pretende serlo — alcanza para distinguir dos celulares contando el
  -- mismo conteo, que es todo lo que este panel necesita.
  dispositivo text not null,
  -- Quién está reportando AHORA (no "el dueño del dispositivo"): se pisa
  -- con auth.uid() en cada heartbeat. Nullable solo por prudencia ante un
  -- borde raro de auth; en la práctica el RPC exige perfil activo.
  usuario_id uuid references perfiles (id),
  pendientes integer not null default 0,
  fallados integer not null default 0,
  ultimo_error text,
  ultima_conexion timestamptz not null default now()
);

comment on table conteo_dispositivos_estado is
  'Heartbeat por dispositivo de un conteo: cuántos escaneos/desconocidos tiene trabados en su cola local y cuándo se lo escuchó por última vez. Telemetría de soporte, no dato de negocio — nunca es fuente de verdad de un conteo.';

comment on column conteo_dispositivos_estado.ultima_conexion is
  'Última vez que ESTE dispositivo pudo hablar con el servidor. Su ausencia de actualización es en sí la señal útil: "visto por última vez hace 3 horas" ya le dice al admin que el celular está sin red o apagado.';

-- Una fila por (conteo, dispositivo): el heartbeat es un upsert, no un
-- log. No interesa el histórico de pings, solo el estado actual.
create unique index ux_conteo_dispositivos_estado
  on conteo_dispositivos_estado (conteo_id, dispositivo);

-- El panel de conteos consulta "¿algún dispositivo de estos conteos tiene
-- algo trabado?" en una sola query agregada sobre varios conteo_id.
create index ix_conteo_dispositivos_estado_conteo
  on conteo_dispositivos_estado (conteo_id, ultima_conexion desc);

alter table conteo_dispositivos_estado enable row level security;

-- SELECT: mismo patrón que conteos/movimientos_stock (empresa propia +
-- sucursal accesible), pero además excluye a operario — esto es una
-- herramienta de supervisión de apps/admin, y CONTEXTO.md define ese
-- alcance como admin/gerente/superadmin (ver también el fix de
-- 20260911000000_resumen_conteo_admin.sql, donde 'admin' se había
-- quedado afuera por error).
create policy conteo_dispositivos_estado_select on conteo_dispositivos_estado
  for select using (
    mi_rol() = 'superadmin'
    or (
      empresa_id = mi_empresa_id()
      and mi_rol() in ('admin', 'gerente')
      and exists (
        select 1 from conteos c
        where c.id = conteo_dispositivos_estado.conteo_id
          and tengo_acceso_sucursal(c.sucursal_id)
      )
    )
  );

-- A propósito SIN policy de INSERT/UPDATE/DELETE para authenticated: el
-- único camino de escritura es reportar_estado_dispositivo (SECURITY
-- DEFINER), que fija usuario_id con auth.uid() y no acepta un usuario_id
-- del cliente — mismo criterio que registrar_escaneo_desconocido y
-- movimientos_stock.

-- ═══════════════════════════════════════════════════════════════
-- reportar_estado_dispositivo
-- ═══════════════════════════════════════════════════════════════
-- Fire-and-forget desde apps/conteo, cada ciclo del timer de sync (10s).
-- Chequeos de autorización calcados de registrar_escaneo_desconocido
-- (perfil activo → el conteo existe → misma empresa → acceso a la
-- sucursal), con UNA diferencia deliberada: NO exige que el conteo esté
-- 'abierto'. Un celular con cosas trabadas después de que se cerró el
-- conteo es justamente el caso más urgente de ver — quedó carga sin
-- destino — y rechazarle el heartbeat lo dejaría invisible para siempre.

create function reportar_estado_dispositivo(
  p_conteo_id uuid,
  p_dispositivo text,
  p_pendientes integer,
  p_fallados integer,
  p_ultimo_error text default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conteo record;
begin
  if public.mi_rol() is null then
    raise exception 'No autenticado o sin perfil activo';
  end if;

  select * into v_conteo from public.conteos where id = p_conteo_id;
  if not found then
    raise exception 'Conteo % no existe', p_conteo_id;
  end if;

  if public.mi_rol() <> 'superadmin' and v_conteo.empresa_id <> public.mi_empresa_id() then
    raise exception 'No autorizado para este conteo';
  end if;

  if public.mi_rol() <> 'superadmin' and not public.tengo_acceso_sucursal(v_conteo.sucursal_id) then
    raise exception 'No autorizado para esa sucursal';
  end if;

  -- empresa_id sale del conteo, no de mi_empresa_id(): así un superadmin
  -- reportando queda atado a la empresa correcta y no a la suya.
  insert into public.conteo_dispositivos_estado (
    empresa_id, conteo_id, dispositivo, usuario_id, pendientes, fallados, ultimo_error
  )
  values (
    v_conteo.empresa_id,
    p_conteo_id,
    coalesce(nullif(p_dispositivo, ''), 'desconocido'),
    auth.uid(),
    greatest(coalesce(p_pendientes, 0), 0),
    greatest(coalesce(p_fallados, 0), 0),
    nullif(p_ultimo_error, '')
  )
  on conflict (conteo_id, dispositivo) do update set
    pendientes = excluded.pendientes,
    fallados = excluded.fallados,
    ultimo_error = excluded.ultimo_error,
    ultima_conexion = now(),
    usuario_id = auth.uid();

  -- Telemetría, no un dato que la app necesite: alcanza con confirmar que
  -- llegó.
  return json_build_object('ok', true);
end;
$$;
