-- Fase 7: panel de superadmin. Hasta acá, empresas/sucursales/perfiles
-- solo tenían policies de SELECT (ver nota en 20260806000000_tenancy.sql) —
-- el alta se hacía a mano con la service_role key. Esta migración agrega
-- las policies de escritura que le faltaban, todas acotadas a
-- mi_rol() = 'superadmin'.
--
-- No hay policies de DELETE a propósito: empresas/sucursales/perfiles
-- siguen el mismo patrón "activo" que productos (soft delete) — permitir
-- DELETE físico desde la UI abriría la puerta a un ON DELETE CASCADE en
-- cadena (empresas → sucursales → conteos → ...) disparado por un click,
-- que es un radio de explosión que ninguna pantalla de superadmin necesita
-- cubrir todavía.

create policy empresas_insert on empresas
  for insert
  with check (mi_rol() = 'superadmin');

create policy empresas_update on empresas
  for update
  using (mi_rol() = 'superadmin')
  with check (mi_rol() = 'superadmin');

create policy sucursales_insert on sucursales
  for insert
  with check (mi_rol() = 'superadmin');

create policy sucursales_update on sucursales
  for update
  using (mi_rol() = 'superadmin')
  with check (mi_rol() = 'superadmin');

-- El alta real de un usuario primero crea la fila en auth.users (Admin
-- API, requiere service_role — ninguna policy de Postgres puede cubrir
-- eso) y RECIÉN DESPUÉS esta fila en perfiles, con el id que devolvió esa
-- llamada. La policy solo cubre este segundo paso.
create policy perfiles_insert on perfiles
  for insert
  with check (mi_rol() = 'superadmin');

create policy perfiles_update on perfiles
  for update
  using (mi_rol() = 'superadmin')
  with check (mi_rol() = 'superadmin');

create policy perfiles_sucursal_insert on perfiles_sucursal
  for insert
  with check (mi_rol() = 'superadmin');

create policy perfiles_sucursal_delete on perfiles_sucursal
  for delete
  using (mi_rol() = 'superadmin');
