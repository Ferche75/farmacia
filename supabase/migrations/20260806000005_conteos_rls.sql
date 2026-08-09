-- Fase 3: falta la única policy de escritura que esta fase necesita en
-- el esquema — poder ABRIR un conteo nuevo. "Retomar uno abierto" ya
-- funciona con el SELECT de Fase 1. Cerrar un conteo (UPDATE estado a
-- 'cerrado') es Fase 6 — no se agrega policy de UPDATE todavía, mismo
-- criterio que se viene usando: la policy se agrega cuando existe la UI
-- que la necesita, no antes.
--
-- Cualquier rol (incluido operario) puede abrir un conteo en una
-- sucursal a la que tiene acceso — tengo_acceso_sucursal() ya resuelve
-- esa distinción (operario necesita perfiles_sucursal, el resto no).

create policy conteos_insert on conteos
  for insert
  with check (
    empresa_id = mi_empresa_id() and tengo_acceso_sucursal(sucursal_id)
  );
