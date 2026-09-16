-- Tercera pasada del autoservicio de empleados. Las dos anteriores
-- (20260915000000, el alta; 20260917000000, la edición) dejaron al
-- admin/gerente manejando SOLO operarios, con el argumento de que
-- "escalar privilegios sigue siendo decisión del superadmin". En la
-- práctica ese recorte convirtió al superadmin en el cuello de botella
-- del segundo caso más común: la farmacia contrata un encargado nuevo, o
-- asciende a alguien, y tiene que pedir por afuera de la app una
-- decisión que es enteramente suya sobre su propia gente. Es exactamente
-- el mismo cuello de botella que 20260915000000 vino a sacar, un escalón
-- más arriba. Se corrige: el admin/gerente pasa a poder dar de alta y
-- editar CUALQUIER empleado de su empresa salvo un superadmin.
--
-- La frontera que importa nunca fue 'operario', era 'superadmin'. Un
-- superadmin no pertenece a la empresa aunque su fila tenga un
-- empresa_id: es el operador de la plataforma y ve y escribe en TODAS
-- las empresas (perfiles_select, perfiles_insert, perfiles_update de
-- 20260806000009_superadmin_rls.sql). Que alguien de adentro de una
-- farmacia pudiera fabricarse uno — o ascenderse a sí mismo — sería
-- fugarse de su propio tenant; no es "un permiso más fuerte", es salirse
-- del modelo de tenancy entero. Un admin creando otro admin, en cambio,
-- no cruza ninguna frontera: los dos ven lo mismo, la misma empresa.
-- Por eso el recorte nuevo es exactamente ese y nada más:
--
--   rol <> 'superadmin'
--
-- y no una lista blanca ('admin', 'gerente', 'operario'). Hoy son
-- equivalentes por el check constraint de perfiles.rol
-- (20260806000000_tenancy.sql), pero si mañana aparece un rol nuevo del
-- lado de la empresa, la lista blanca lo dejaría afuera en silencio y
-- habría que acordarse de tocar estas policies. El denylist de uno dice
-- lo que de verdad se está defendiendo.
--
-- ─────────────────────────────────────────────────────────────────
-- Por qué se REEMPLAZAN las policies viejas en vez de sumar hermanas
-- ─────────────────────────────────────────────────────────────────
-- El patrón de esta base (20260813000002, 20260915000000,
-- 20260917000000) es agregar policies nuevas que CONVIVEN con las que ya
-- estaban, porque son permisivas y Postgres las OR-ea. Acá ese patrón no
-- aplica y agregar al lado sería un error: aquellas conviven con las de
-- superadmin porque cubren sujetos DISTINTOS (mi_rol() = 'superadmin'
-- contra mi_rol() in ('admin','gerente')) y ninguna es subconjunto de la
-- otra. Estas dos son el mismo sujeto con el mismo predicado salvo por
-- el rango de `rol`: una hermana con `rol <> 'superadmin'` deja a la
-- vieja redundante al 100% — todo lo que pasaba por `rol = 'operario'`
-- pasa también por `rol <> 'superadmin'`. Quedarían dos policies muertas
-- que el próximo que lea pg_policies va a tener que descartar a mano
-- para entender qué está permitido. Se dropean.
--
-- El nombre cambia junto con el alcance (..._operario_... pasa a
-- ..._empleado_...): un `alter policy` habría conservado el predicado
-- nuevo bajo un nombre que sigue diciendo "operario".
--
-- ─────────────────────────────────────────────────────────────────
-- Lo que NO se toca: perfiles_sucursal
-- ─────────────────────────────────────────────────────────────────
-- Las policies de perfiles_sucursal (..._insert_operario_propia_empresa
-- de 20260915000000 y ..._delete_operario_propia_empresa de
-- 20260917000000) se dejan tal cual, con su `p.rol = 'operario'`. No es
-- un olvido ni una asimetría pendiente: para un admin/gerente esa tabla
-- no significa nada. tengo_acceso_sucursal()
-- (20260806000001_catalogo_conteo.sql) corta por lo sano antes de
-- mirarla —
--   when mi_rol() in ('admin','gerente','superadmin') then <toda la empresa>
--   else <lo que diga perfiles_sucursal>
-- — y del lado de la app pasa lo mismo (apps/conteo/lib/sucursales.ts
-- solo consulta la tabla si rol = 'operario', y el RPC
-- actualizar_usuario_superadmin directamente BORRA las filas de alguien
-- que deja de ser operario). Una fila de perfiles_sucursal apuntando a
-- un admin no le daría ni le quitaría acceso a nada: sería basura que
-- confunde a quien la lea después. Asignar sucursales sigue siendo, a
-- propósito, una operación sobre operarios — y la UI esconde esa sección
-- cuando el empleado que se está editando no lo es.

drop policy perfiles_insert_operario_propia_empresa on perfiles;

create policy perfiles_insert_empleado_propia_empresa on perfiles
  for insert
  with check (
    mi_rol() in ('admin', 'gerente')
    and empresa_id = mi_empresa_id()
    and rol <> 'superadmin'
  );

-- El `with check` repetido sigue siendo el backstop de verdad, y ahora
-- más que antes. El `using` decide QUÉ FILAS se pueden tocar (las que
-- HOY no son de un superadmin); el `with check`, CÓMO PUEDEN QUEDAR
-- después del UPDATE. Sin repetirlo, un admin podría agarrar su propia
-- fila — que pasa el `using` sin problema, es un admin de su empresa —
-- y en el mismo UPDATE ponerle rol = 'superadmin': el `using` ya se
-- evaluó contra el estado ANTERIOR y no tiene nada que decir sobre el
-- posterior. Con el `with check`, la fila tiene que seguir siendo de la
-- propia empresa y no-superadmin DESPUÉS de escribir, así que tanto la
-- autopromoción como la mudanza de empresa_id rebotan aunque el request
-- venga armado a mano contra PostgREST.
--
-- Lo que sí queda habilitado, y es intencional: un admin/gerente puede
-- cambiarle el rol a un empleado suyo entre operario/gerente/admin. No
-- hay UI para eso (actualizarEstadoEmpleado manda únicamente `activo`),
-- pero si alguien lo hace por fuera no rompe nada que no estuviera roto:
-- quien puede CREAR un admin de cero — que es lo que esta pasada
-- habilita — ya puede conseguir el mismo resultado. Prohibir el ascenso
-- y permitir el alta sería una línea sin sentido. La única que importa
-- la sostienen las dos cláusulas de arriba.
drop policy perfiles_update_operario_propia_empresa on perfiles;

create policy perfiles_update_empleado_propia_empresa on perfiles
  for update
  using (
    mi_rol() in ('admin', 'gerente')
    and empresa_id = mi_empresa_id()
    and rol <> 'superadmin'
  )
  with check (
    mi_rol() in ('admin', 'gerente')
    and empresa_id = mi_empresa_id()
    and rol <> 'superadmin'
  );
