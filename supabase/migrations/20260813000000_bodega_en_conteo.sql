-- Bodega en el conteo: hasta acá `bodegas` (20260812000002) era pura
-- decoración — se podía crear desde el panel de superadmin, pero ninguna
-- otra tabla la referenciaba y ninguna pantalla de apps/conteo la usaba.
-- La nota de esa migración ya lo anticipaba: "cuando se necesite contar
-- por bodega, es la migración natural que sigue". El cliente real (7
-- empresas, algunas con varias bodegas por sucursal) la necesita ahora.
--
-- bodega_id se agrega a `conteos` (se elige una vez, al abrir el conteo)
-- y a `lotes` (hereda la bodega del conteo que lo generó, vía
-- cerrar_conteo). `escaneos` NO necesita bodega_id propio — ya cuelga de
-- conteo_id, que ya sabe su bodega.
--
-- NULLABLE a propósito en las dos: la mayoría de las empresas no van a
-- tener bodegas cargadas nunca, y eso tiene que seguir funcionando
-- exactamente igual que hoy. bodega_id = null significa "toda la
-- sucursal", no "dato faltante".

alter table conteos
  add column bodega_id uuid references bodegas (id) on delete restrict;

alter table lotes
  add column bodega_id uuid references bodegas (id) on delete restrict;

-- movimientos_stock (tabla reservada de Fase 1, sin RLS de escritura,
-- sin uso todavía) también gana bodega_id por consistencia a futuro —
-- costo cero, nadie la usa todavía.
alter table movimientos_stock
  add column bodega_id uuid references bodegas (id) on delete restrict;

-- ═══════════════════════════════════════════════════════════════
-- Invariante: la bodega tiene que ser de la MISMA sucursal/empresa
-- ═══════════════════════════════════════════════════════════════
-- La FK sola no alcanza: nada impide, a nivel de columna, que alguien
-- mande la bodega de OTRA sucursal (o de otra empresa) para un conteo.
-- conteos_insert (Fase 3, 20260806000005_conteos_rls.sql) es un INSERT
-- directo del cliente sujeto a RLS, no un RPC, así que esta regla no
-- puede vivir en ningún SECURITY DEFINER que valide el payload primero
-- — tiene que ser la base la que la garantice. Mismo criterio que
-- recalcular_cantidad_linea o el constraint XOR de conteo_lineas: una
-- invariante de datos, no de permisos, se aplica con trigger/constraint,
-- no con RLS.
create function validar_bodega_conteo()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bodega record;
begin
  if new.bodega_id is null then
    return new;
  end if;

  select * into v_bodega from public.bodegas where id = new.bodega_id;

  if not found then
    raise exception 'La bodega % no existe', new.bodega_id;
  end if;

  if v_bodega.sucursal_id <> new.sucursal_id or v_bodega.empresa_id <> new.empresa_id then
    raise exception 'La bodega % no pertenece a esta sucursal/empresa', new.bodega_id;
  end if;

  if not v_bodega.activo then
    raise exception 'La bodega % está inactiva', new.bodega_id;
  end if;

  return new;
end;
$$;

-- Solo INSERT: conteos.sucursal_id/empresa_id son inmutables en la
-- práctica (no hay policy de UPDATE que los toque) y nada en la app
-- cambia bodega_id después de abrir el conteo — si en el futuro aparece
-- esa UI, ahí se suma "or update of bodega_id".
create trigger conteos_validar_bodega
  before insert on conteos
  for each row
  execute function validar_bodega_conteo();

-- ═══════════════════════════════════════════════════════════════
-- Llave única de lotes: bodega entra a la llave
-- ═══════════════════════════════════════════════════════════════
-- Antes (empresa, sucursal, producto, lote, vencimiento) trataba toda la
-- sucursal como un solo balde. Ahora la misma combinación en dos
-- bodegas distintas de la misma sucursal son lotes DISTINTOS. Mismo
-- truco coalesce(...,'') que ya usaba `lote`: dos lotes sin bodega
-- elegida (bodega_id null) siguen colisionando entre sí como "la
-- sucursal entera" — sin esto, NULL <> NULL los trataría como filas
-- siempre distintas y el ON CONFLICT de cerrar_conteo dejaría de
-- funcionar para todas las empresas sin bodegas.
drop index ix_lotes_clave;

create unique index ix_lotes_clave on lotes (
  empresa_id, sucursal_id, (coalesce(bodega_id::text, '')), producto_id,
  (coalesce(lote, '')), vencimiento
);

-- ═══════════════════════════════════════════════════════════════
-- cerrar_conteo: propaga bodega_id del conteo a cada lote que genera
-- ═══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE: mismo cuerpo que 20260812000003_lotes_vencimiento.sql,
-- dos cambios — el INSERT a `lotes` suma bodega_id (v_conteo.bodega_id,
-- puede ser null) a la lista de columnas, y el ON CONFLICT apunta a la
-- llave nueva de arriba.
create or replace function cerrar_conteo(p_conteo_id uuid)
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

  insert into public.lotes (
    empresa_id, sucursal_id, bodega_id, producto_id, lote, vencimiento, cantidad,
    actualizado_en_conteo_id, updated_at
  )
  select
    v_conteo.empresa_id, v_conteo.sucursal_id, v_conteo.bodega_id, cl.producto_id, e.lote, e.vencimiento,
    sum(e.delta), p_conteo_id, now()
  from public.escaneos e
  join public.conteo_lineas cl on cl.id = e.linea_id
  where e.conteo_id = p_conteo_id
    and e.vencimiento is not null
    and cl.producto_id is not null
  group by cl.producto_id, e.lote, e.vencimiento
  on conflict (empresa_id, sucursal_id, (coalesce(bodega_id::text, '')), producto_id, (coalesce(lote, '')), vencimiento)
  do update set
    cantidad = excluded.cantidad,
    actualizado_en_conteo_id = excluded.actualizado_en_conteo_id,
    updated_at = now();

  -- A partir de acá el conteo queda de solo lectura de verdad: tanto
  -- registrar_escaneos_batch como registrar_escaneo_desconocido (Fases 1
  -- y 4) ya chequean `estado <> 'abierto'` y rechazan cualquier escritura.

  return json_build_object(
    'id', p_conteo_id,
    'desconocidos_pendientes', v_desconocidos_pendientes
  );
end;
$$;
