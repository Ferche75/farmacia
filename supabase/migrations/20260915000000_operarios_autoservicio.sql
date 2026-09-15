-- El admin/gerente de una farmacia necesita poder dar de alta a sus
-- propios operarios (la gente que hace los conteos físicos) sin esperar
-- a que el superadmin lo haga por ellos — es el caso común: contratan a
-- alguien y quieren que cuente ESE día. Hasta acá el alta de usuarios
-- estaba 100% reservada a superadmin (perfiles_insert /
-- perfiles_sucursal_insert de 20260806000009_superadmin_rls.sql).
--
-- Mismo criterio que 20260813000002_sucursales_bodegas_autoservicio.sql:
-- se agregan policies NUEVAS, acotadas, que conviven con las de
-- superadmin ya existentes (las policies son permisivas: Postgres las
-- OR-ea entre sí, no se reemplazan). Las de superadmin quedan intactas y
-- siguen siendo el único camino para crear cualquier rol en cualquier
-- empresa.
--
-- El recorte es doble y a propósito:
--   * rol = 'operario' — un admin/gerente NO puede fabricarse un par
--     admin/gerente/superadmin nuevo. Escalar privilegios sigue siendo
--     decisión del superadmin, que es lo único que hace que el rol
--     signifique algo. Dar de alta un admin nuevo sigue pidiéndose.
--   * empresa_id = mi_empresa_id() — el alta nace atada a su propia
--     empresa, nunca a otra. Es la misma frontera de tenancy que el
--     resto del esquema.
-- La Server Action (configuracion/actions.ts, crearOperario) además
-- fuerza rol/empresa_id del lado del servidor sin aceptarlos del cliente:
-- defensa en profundidad, igual que registrar_venta o ajustar_stock —
-- acá el chequeo de RLS es el piso, no el único control.
--
-- Solo INSERT: esta pasada cubre el ALTA y nada más. Desactivar,
-- cambiar de rol o reasignar sucursales de un empleado que ya existe
-- (perfiles_update, perfiles_sucursal_delete) sigue siendo exclusivo del
-- superadmin — el offboarding tiene otro radio de explosión y todavía no
-- tiene UI ni criterio definido.
--
-- Como siempre, la fila en auth.users la crea antes la Admin API con la
-- service_role key (ninguna policy de Postgres puede cubrir eso); estas
-- policies solo autorizan el segundo paso, la fila en perfiles con el id
-- que devolvió esa llamada (ver la nota en perfiles_insert).

create policy perfiles_insert_operario_propia_empresa on perfiles
  for insert
  with check (
    mi_rol() in ('admin', 'gerente')
    and empresa_id = mi_empresa_id()
    and rol = 'operario'
  );

-- Asignación de sucursales del operario recién creado. Se validan las
-- DOS puntas de la fila contra la propia empresa, por el mismo motivo
-- que bodegas_insert_propia_empresa: sin eso, un admin/gerente podría
-- enganchar un perfil propio a una sucursal ajena (o al revés) y cruzar
-- la frontera de tenancy por la puerta de atrás. El `rol = 'operario'`
-- se repite acá porque esta policy se evalúa sola: que el perfil exista
-- no implica que lo haya creado esta misma policy.
-- Los subselects corren bajo el rol que llama, así que además ya quedan
-- acotados por perfiles_select / sucursales_select.
create policy perfiles_sucursal_insert_operario_propia_empresa on perfiles_sucursal
  for insert
  with check (
    mi_rol() in ('admin', 'gerente')
    and exists (
      select 1 from public.perfiles p
      where p.id = perfil_id and p.empresa_id = mi_empresa_id() and p.rol = 'operario'
    )
    and exists (
      select 1 from public.sucursales s
      where s.id = sucursal_id and s.empresa_id = mi_empresa_id()
    )
  );
