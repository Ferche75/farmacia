-- Segunda mitad del autoservicio de operarios. 20260915000000 cubrió el
-- ALTA y dejó dicho, explícitamente, que reasignar sucursales o dar de
-- baja a alguien que YA existe seguía siendo exclusivo del superadmin
-- "porque todavía no tiene UI ni criterio definido". Ya lo tiene: el
-- admin/gerente de la farmacia necesita mover a un operario de sucursal
-- (cubre una licencia, lo trasladan) y desactivarlo cuando se va, el
-- mismo día y sin pedir permiso. Esperar al superadmin para eso es
-- exactamente el cuello de botella que la pasada anterior vino a sacar.
--
-- Mismo criterio de siempre (20260813000002_sucursales_bodegas_autoservicio.sql,
-- 20260915000000): se agregan policies NUEVAS y acotadas que CONVIVEN con
-- las de superadmin (perfiles_update, perfiles_sucursal_delete de
-- 20260806000009_superadmin_rls.sql). Las policies son permisivas —
-- Postgres las OR-ea — así que las viejas quedan intactas y el superadmin
-- sigue pudiendo tocar cualquier rol en cualquier empresa como hasta hoy.
--
-- El recorte es el mismo que el del alta, por los mismos motivos:
--   * rol = 'operario' — un admin/gerente no puede editar (ni desactivar)
--     a otro admin, a un gerente ni a un superadmin. La cadena de mando
--     no se toca desde adentro de la empresa.
--   * empresa_id = mi_empresa_id() — nunca se cruza la frontera de
--     tenancy.
-- Lo que NO se habilita: borrar el perfil. Desactivar es reversible y no
-- deja huérfanos los conteos que esa persona ya hizo; borrar sí. El
-- offboarding duro sigue siendo del superadmin.

-- El `with check` no es una copia decorativa del `using`. El `using`
-- decide QUÉ FILAS se pueden tocar (las de un operario de mi empresa);
-- el `with check` decide CÓMO PUEDEN QUEDAR después del UPDATE. Sin él,
-- un admin/gerente podría agarrar una fila que legítimamente puede
-- editar y, en el mismo UPDATE, moverle el `rol` a 'admin' o el
-- `empresa_id` a otra empresa — la fila pasaría el `using` (era un
-- operario propio ANTES de escribir) y el cambio quedaría hecho. Con el
-- `with check`, la fila tiene que seguir siendo operario y de la misma
-- empresa DESPUÉS de la escritura, así que esos dos movimientos rebotan
-- aunque el request venga modificado a mano. Es el mismo backstop que
-- describe crearOperario para el alta: la Server Action ya manda solo
-- `activo`, pero acá el chequeo de RLS es el piso, no el único control.
create policy perfiles_update_operario_propia_empresa on perfiles
  for update
  using (
    mi_rol() in ('admin', 'gerente')
    and empresa_id = mi_empresa_id()
    and rol = 'operario'
  )
  with check (
    mi_rol() in ('admin', 'gerente')
    and empresa_id = mi_empresa_id()
    and rol = 'operario'
  );

-- Solo falta el DELETE. perfiles_sucursal_insert_operario_propia_empresa
-- (20260915000000) no está atada al momento del alta: su `with check`
-- solo mira que el perfil sea un operario de mi empresa y que la sucursal
-- sea de mi empresa, dos cosas que siguen siendo ciertas meses después.
-- O sea que AGREGARLE una sucursal a un operario que ya existe ya era
-- legal; lo único que faltaba era poder SACARLE una. Por eso no se suma
-- una policy de insert redundante.
--
-- Se valida una sola punta (el perfil) y no las dos como en el insert
-- porque acá no hay nada que falsificar del lado de la sucursal: la fila
-- ya existe y su sucursal ya fue validada cuando se insertó. Lo que
-- importa es de quién es la fila que se está borrando.
create policy perfiles_sucursal_delete_operario_propia_empresa on perfiles_sucursal
  for delete
  using (
    mi_rol() in ('admin', 'gerente')
    and exists (
      select 1 from public.perfiles p
      where p.id = perfil_id and p.empresa_id = mi_empresa_id() and p.rol = 'operario'
    )
  );
