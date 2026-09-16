-- Cuatro pedidos del usuario que caen todos en la misma pantalla
-- (/productos, el modal de alta/edición) y por eso viajan en una sola
-- migración:
--   1) Venta fraccionada con precios por nivel (caja / blíster / unidad).
--   2) `marca` en el catálogo global.
--   3) `accion_terapeutica` y `especialidad` en el catálogo global.
--   4) Carga MANUAL de lote + vencimiento, que por primera vez escribe
--      `lotes` desde una sesión normal (hasta acá solo la escribía
--      cerrar_conteo, SECURITY DEFINER).
--
-- Nada de esto toca stock_actual / stock_actual_lote / registrar_venta /
-- ajustar_stock ni el endpoint de catálogo de pdvlat: el contrato de
-- stock y de precio unitario que se cerró en
-- 20260910000000_stock_en_unidades_individuales.sql queda exactamente
-- igual. Consumir las columnas de precio nuevas del lado de pdvlat es
-- una tarea aparte, posterior a esta.

-- ═══════════════════════════════════════════════════════════════
-- 1) Venta fraccionada y precios por nivel — POR EMPRESA
-- ═══════════════════════════════════════════════════════════════
-- En una farmacia boliviana un mismo comprimido se vende en tres
-- niveles: la caja cerrada, el blíster suelto y la unidad suelta. Los
-- tres precios NO son proporcionales entre sí — comprar suelto sale más
-- caro por unidad que llevarse la caja, y es el vendedor quien fija los
-- tres a mano. Por eso son tres columnas independientes y no una sola
-- dividida por un factor.
--
-- Van en productos_empresa y no en productos (confirmado con el
-- usuario): que un producto se fraccione o no es una decisión comercial
-- de CADA farmacia. La misma "Ibupirac Fem" del catálogo global puede
-- venderse fraccionada en una empresa y solo por caja en otra.
--
-- `precio` NO se renombra a `precio_caja`. A partir de ahora significa
-- específicamente "precio de la caja / envase completo", que es lo que
-- ya significaba de hecho, pero la columna se queda como está: la leen
-- el importador (confirmar_importacion_lote, 3 caminos distintos),
-- /api/pdvlat/catalogo, exportar-catalogo.ts, el ABM y el mapeo del CSV
-- (campos-sistema.ts, más el whitelist de
-- actualizar_config_operativa_empresa). Renombrarla obligaría a tocar
-- todo eso — incluida la ruta de pdvlat, que esta tarea tiene prohibido
-- modificar — a cambio de cero cambio de comportamiento. Se documenta
-- el significado acá y listo.
--
-- Sin CHECK de consistencia interna a propósito: la validación de
-- "fraccionable ⇒ blísteres y unidades > 0" vive en el formulario. Un
-- CHECK acá rompería en seco cualquier UPDATE parcial de fila (el
-- importador, por ejemplo, escribe productos_empresa sin saber nada de
-- fraccionamiento) y convertiría un dato a medio cargar en un error
-- duro en vez de en un campo por completar.
alter table productos_empresa
  add column fraccionable boolean not null default false,
  add column unidades_por_blister integer,
  add column blisters_por_caja integer,
  add column precio_blister numeric(14, 4),
  add column precio_unidad numeric(14, 4);

comment on column productos_empresa.precio is
  'Precio de la CAJA / envase completo, en Bs. Con fraccionable = true conviven precio_blister y precio_unidad, que NO son este valor dividido: los tres los fija el vendedor por separado.';
comment on column productos_empresa.fraccionable is
  'Esta empresa vende el producto también por blíster y/o por unidad suelta, no solo la caja cerrada.';
comment on column productos_empresa.unidades_por_blister is
  'Comprimidos/cápsulas que trae un blíster. Junto con blisters_por_caja deriva productos.contenido (ver el comentario de esa columna).';
comment on column productos_empresa.blisters_por_caja is
  'Blísteres que trae una caja.';

-- TENSIÓN CONOCIDA Y ACEPTADA para esta pasada:
-- blisters_por_caja * unidades_por_blister es, por definición, el
-- contenido de la caja — pero `contenido` vive en `productos` (global,
-- compartido por todas las empresas) porque es el factor que
-- stock_actual/stock_actual_lote ya usan para convertir envases a
-- unidades sueltas, y ese contrato no se toca. Si dos empresas cargan
-- desgloses distintos para el mismo producto global, se pisan el
-- `contenido` entre ellas: gana la última que guarde. No se resuelve
-- ahora (la salida sería mover `contenido` a productos_empresa, que es
-- justamente el contrato de stock que esta tarea no puede cambiar).
comment on column productos.contenido is
  'Unidades individuales que trae un envase. Factor global que usan stock_actual/stock_actual_lote y el precio unitario de /api/pdvlat/catalogo. Cuando productos_empresa.fraccionable esta en true, el ABM lo escribe derivado (blisters_por_caja * unidades_por_blister) — y como esta columna es GLOBAL y el desglose es POR EMPRESA, dos empresas con desgloses distintos del mismo producto se pisan el valor: gana la ultima en guardar.';

-- ═══════════════════════════════════════════════════════════════
-- 2) marca — catálogo global
-- ═══════════════════════════════════════════════════════════════
-- El nombre comercial con el que se vende el producto (ej. "Tafirol").
-- Es un hecho de identidad del producto, igual que `fabricante` o
-- `laboratorio_id`, así que va en `productos` (global) y no en
-- productos_empresa.
--
-- Deliberadamente NO cambia nada de `nombre`: `nombre` sigue siendo lo
-- que ya era (lo que trae el importador, lo que escribe el ABM o lo que
-- devuelve el reconocimiento por IA en /desconocidos) y todo lo que
-- busca por nombre — buscar_producto, el match por nombre exacto de
-- confirmar_importacion_lote — sigue mirando esa columna y solo esa.
-- `marca` se suma al lado, opcional, sin desplazarlo.
alter table productos
  add column marca text;

comment on column productos.marca is
  'Nombre comercial con el que se vende (ej. "Tafirol"). Distinto de `nombre` (el rotulo con el que entro al catalogo) y de laboratorio_id (quien lo fabrica). No lo usa ninguna busqueda: es informativo.';

-- ═══════════════════════════════════════════════════════════════
-- 3) accion_terapeutica y especialidad — catálogo global
-- ═══════════════════════════════════════════════════════════════
-- Mismo nivel que `categoria` y `principio_activo`: clasificación del
-- producto en sí, no de la relación con una empresa. Texto libre, igual
-- que `categoria` — el vocabulario todavía no está cerrado y forzar un
-- enum ahora sería adivinarlo.
alter table productos
  add column accion_terapeutica text,
  add column especialidad text;

comment on column productos.accion_terapeutica is
  'Para que sirve (ej. "analgesico", "antihipertensivo"). Texto libre, mismo criterio que categoria.';
comment on column productos.especialidad is
  'Especialidad medica que lo receta (ej. "cardiologia"). Texto libre.';

-- ═══════════════════════════════════════════════════════════════
-- 4) Carga manual de lote + vencimiento
-- ═══════════════════════════════════════════════════════════════
-- Hasta acá `lotes` no tenía NINGUNA policy de escritura para una sesión
-- normal: la llenaba exclusivamente cerrar_conteo (SECURITY DEFINER),
-- ver la nota al pie de 20260812000003_lotes_vencimiento.sql. Eso deja
-- afuera un caso real: llega una compra, el encargado sabe que ese lote
-- vence en marzo y quiere que el semáforo de vencimientos lo vigile YA,
-- sin esperar al próximo conteo físico.
--
-- La frontera que estas policies defienden es `actualizado_en_conteo_id`:
--   * Las filas con conteo (actualizado_en_conteo_id is not null) son
--     el resultado de un recuento físico. NADIE las edita ni las borra
--     desde el panel — su `cantidad` es la foto de lo que efectivamente
--     se escaneó, y dejar que una pantalla de catálogo la pise sería
--     borrar el dato que justifica todo el flujo de conteo. El filtro va
--     en el USING, no solo en la UI.
--   * Las filas manuales (actualizado_en_conteo_id is null) son
--     declaraciones de "este lote existe y vence tal día". Nacen con
--     cantidad = 0 (el default) a propósito: NO afirman existencia
--     física. Si después un conteo cuenta ese mismo lote, el ON CONFLICT
--     de cerrar_conteo las adopta — les pone la cantidad real y les
--     estampa el actualizado_en_conteo_id, y a partir de ahí quedan del
--     lado intocable de esta frontera, que es exactamente lo que se
--     quiere.
--
-- Nivel de permiso: mi_rol() in ('admin','gerente','superadmin') +
-- empresa_id = mi_empresa_id(), calcado de productos_empresa_insert /
-- _update (20260806000003_importacion_abm.sql). Esto es gestión de
-- catálogo y vencimientos, no de empleados ni de tenancy: le corresponde
-- la misma sensibilidad que ya tiene editar el precio de un producto, no
-- la de dar de alta un usuario.
--
-- La sucursal se valida contra la propia empresa con un EXISTS, mismo
-- patrón que perfiles_sucursal_insert_operario_propia_empresa
-- (20260915000000): sin eso, un admin podría colgar un lote de su
-- empresa de una sucursal ajena y cruzar la frontera de tenancy por la
-- puerta de atrás. `bodega_id` queda en null en esta carga manual — es
-- "la sucursal entera", el mismo valor que ya usan todas las empresas
-- que no dividen por bodega (ver 20260813000000_bodega_en_conteo.sql).

create policy lotes_insert_manual on lotes
  for insert
  with check (
    mi_rol() in ('admin', 'gerente', 'superadmin')
    and empresa_id = mi_empresa_id()
    and actualizado_en_conteo_id is null
    and exists (
      select 1 from public.sucursales s
      where s.id = sucursal_id and s.empresa_id = mi_empresa_id()
    )
  );

-- USING y WITH CHECK los dos: el USING decide qué filas se pueden tocar
-- (solo las manuales, de la propia empresa) y el WITH CHECK decide cómo
-- pueden quedar después (que no se muden a otra empresa/sucursal, y que
-- nadie se auto-adjudique un actualizado_en_conteo_id para blindar una
-- fila manual haciéndola pasar por conteo).
create policy lotes_update_manual on lotes
  for update
  using (
    mi_rol() in ('admin', 'gerente', 'superadmin')
    and empresa_id = mi_empresa_id()
    and actualizado_en_conteo_id is null
  )
  with check (
    mi_rol() in ('admin', 'gerente', 'superadmin')
    and empresa_id = mi_empresa_id()
    and actualizado_en_conteo_id is null
    and exists (
      select 1 from public.sucursales s
      where s.id = sucursal_id and s.empresa_id = mi_empresa_id()
    )
  );

-- DELETE para deshacer un error de tipeo (la fecha mal cargada, la
-- sucursal equivocada). Igual que arriba: las filas que dejó un conteo
-- quedan fuera del alcance del USING, así que son indeleteables desde
-- una sesión normal aunque la UI lo intentara.
create policy lotes_delete_manual on lotes
  for delete
  using (
    mi_rol() in ('admin', 'gerente', 'superadmin')
    and empresa_id = mi_empresa_id()
    and actualizado_en_conteo_id is null
  );
