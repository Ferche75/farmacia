-- "Vinculado" hoy es un flag de UNA sola vez: `vinculado_at` se pone
-- cuando pdvlat canjea el código, y desde ahí el panel dice "Vinculado"
-- para siempre, aunque el POS nunca vuelva a llamar a nada — un problema
-- de configuración del otro lado quedaría invisible acá.
--
-- Pedido del usuario: que el estado sea una confirmación CRUZADA — no solo
-- "en algún momento se intercambiaron credenciales", sino "pdvlat está
-- usando esta credencial de verdad". Eso no se puede afirmar con un dato
-- que solo escribe Farmacia; hace falta que cada llamada AUTENTICADA de
-- pdvlat dejé una marca.
--
-- `ultima_actividad_at` se actualiza en autenticarPdv() (apps/admin/lib/pdvlat.ts),
-- que es el paso común a /api/pdvlat/catalogo, /api/pdvlat/ventas y
-- /api/pdvlat/auth-empleado — cualquier llamada exitosa con
-- X-PDV-Api-Key/Secret la toca. Deliberadamente NO reusa `updated_at`
-- (que ya existe, con su propio trigger): `updated_at` se pisaría con
-- cualquier UPDATE futuro de esta fila por otro motivo (rotar
-- credenciales, cambiar sucursal por defecto) y dejaría de significar
-- "actividad real del POS" para significar "la fila cambió por lo que
-- sea". Una columna aparte, tocada SOLO desde el paso de autenticación,
-- no se presta a esa ambigüedad.
alter table integraciones_pdv
  add column ultima_actividad_at timestamptz;

comment on column integraciones_pdv.ultima_actividad_at is
  'Última vez que esta credencial autenticó con éxito una llamada real (/catalogo, /ventas o /auth-empleado) -- ver autenticarPdv() en apps/admin/lib/pdvlat.ts. Null significa que el código se canjeó pero pdvlat todavía no hizo ninguna llamada con esta credencial. Distinto de vinculado_at (cuándo se canjeó el código, una sola vez) y de updated_at (cualquier cambio de la fila, no solo actividad del POS).';
