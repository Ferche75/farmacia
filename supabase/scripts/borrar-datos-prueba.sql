-- Borra todos los datos de prueba antes de dar de alta el primer cliente
-- real (Farmacia San Francisco de Asís). Dos partes independientes:
--   1) el tenant "Empresa de prueba" del bootstrap (bootstrap-usuario-
--      inicial.sql) con todo lo que se haya cargado adentro (sucursales,
--      perfiles, conteos, importaciones, etc.)
--   2) el catálogo demo (seed-productos-demo.sql) — es GLOBAL, no
--      pertenece a ninguna empresa, así que se borra aparte.
--
-- Revisá el SELECT de abajo antes de correr el DELETE. Si usaste otro
-- nombre de empresa de prueba (por ejemplo creaste alguna a mano desde
-- el panel de superadmin), agregalo a v_nombres_prueba.

-- ── 1) Vista previa: qué se va a borrar ─────────────────────────────
select id, nombre, created_at
from empresas
where nombre = any(array['Empresa de prueba']);

-- ── 2) Borrado del/los tenant(s) de prueba ──────────────────────────
do $$
declare
  v_nombres_prueba text[] := array['Empresa de prueba'];
  v_empresa_ids uuid[];
begin
  select array_agg(id) into v_empresa_ids
  from empresas
  where nombre = any(v_nombres_prueba);

  if v_empresa_ids is null then
    raise notice 'No se encontraron empresas de prueba con esos nombres, nada que borrar.';
    return;
  end if;

  -- Orden importa: estas tablas referencian a `perfiles` sin ON DELETE
  -- CASCADE (ver 20260806000001_catalogo_conteo.sql), así que hay que
  -- vaciarlas antes de poder borrar los perfiles. `conteos` cascadea
  -- solo a conteo_lineas/escaneos, no a esto.
  delete from conteos where empresa_id = any(v_empresa_ids);
  delete from desconocidos where empresa_id = any(v_empresa_ids);
  delete from importaciones where empresa_id = any(v_empresa_ids);
  delete from movimientos_stock where empresa_id = any(v_empresa_ids);

  -- perfiles tiene ON DELETE RESTRICT contra empresas — hay que
  -- borrarlo a mano antes de poder borrar la empresa.
  delete from perfiles where empresa_id = any(v_empresa_ids);

  -- El resto (sucursales, bodegas, productos_empresa, mapeos_columnas,
  -- lotes, perfiles_sucursal) tiene ON DELETE CASCADE desde empresa_id
  -- (o desde perfiles/sucursales, ya borrados arriba), se va solo.
  delete from empresas where id = any(v_empresa_ids);

  raise notice 'Borradas % empresa(s) de prueba.', array_length(v_empresa_ids, 1);
end $$;

-- ── 3) Catálogo demo (global, no pertenece a ninguna empresa) ───────
-- Los codigos_barra se van solos por el ON DELETE CASCADE a productos.
delete from productos where nombre like 'Producto Demo %';
delete from laboratorios where nombre like 'Laboratorio Demo %';

-- ── 4) Opcional: el usuario de Auth de prueba ───────────────────────
-- Borrar `perfiles` NO borra el usuario de Authentication (la cascada
-- va al revés: auth.users → perfiles). Si además querés eliminar el
-- login de prueba de Authentication → Users, descomentá y completá el
-- UID (el que usaste en bootstrap-usuario-inicial.sql):
-- delete from auth.users where id = '1ae7ab50-52c8-42cd-8e74-48aa7fef5b74';
