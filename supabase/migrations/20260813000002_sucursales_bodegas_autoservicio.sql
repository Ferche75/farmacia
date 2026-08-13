-- El gerente/admin de una empresa necesita poder dar de alta sus propias
-- sucursales y bodegas sin depender de que el superadmin lo haga por
-- ellos — hasta acá (20260806000009_superadmin_rls.sql,
-- 20260812000002_bodegas.sql) el alta/edición de sucursales y bodegas
-- estaba 100% reservada a superadmin. Se agregan policies nuevas,
-- ACOTADAS a la propia empresa (mi_empresa_id()) — conviven con las de
-- superadmin ya existentes (las policies son permisivas: se OR-ean entre
-- sí, no se reemplazan una a otra).
--
-- No hace falta un RPC acá (a diferencia de actualizar_datos_contacto_
-- empresa): `sucursales`/`bodegas` no tienen ningún campo sensible tipo
-- `config`/`activo`-kill-switch como `empresas` — son solo nombre/
-- dirección/pertenencia, así que RLS de fila alcanza.

create policy sucursales_insert_propia_empresa on sucursales
  for insert
  with check (empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente'));

create policy sucursales_update_propia_empresa on sucursales
  for update
  using (empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente'))
  with check (empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente'));

-- Bodegas: mismo criterio, más una condición extra — `sucursal_id` tiene
-- que ser una sucursal de ESA MISMA empresa. Sin esto, un admin/gerente
-- podría crear una fila con `empresa_id` = la propia pero `sucursal_id`
-- de OTRA empresa, rompiendo la denormalización que el resto del
-- esquema asume consistente (mismo motivo que el trigger
-- validar_bodega_conteo de 20260813000000). El subselect corre bajo el
-- mismo rol que llama, así que ya queda acotado por sucursales_select
-- (RLS) a las sucursales de la propia empresa — es el mismo patrón que
-- ya usa perfiles_sucursal_select (20260806000000_tenancy.sql).
create policy bodegas_insert_propia_empresa on bodegas
  for insert
  with check (
    empresa_id = mi_empresa_id()
    and mi_rol() in ('admin', 'gerente')
    and sucursal_id in (select id from sucursales where empresa_id = mi_empresa_id())
  );

create policy bodegas_update_propia_empresa on bodegas
  for update
  using (empresa_id = mi_empresa_id() and mi_rol() in ('admin', 'gerente'))
  with check (
    empresa_id = mi_empresa_id()
    and mi_rol() in ('admin', 'gerente')
    and sucursal_id in (select id from sucursales where empresa_id = mi_empresa_id())
  );
