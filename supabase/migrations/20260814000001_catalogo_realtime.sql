-- El catálogo local de apps/conteo se baja UNA sola vez al empezar un
-- conteo (descargar-catalogo.ts) y nunca se vuelve a actualizar mientras
-- ese conteo sigue abierto — ni con conexión. Si desde apps/admin se
-- carga o edita un producto mientras alguien está contando, no aparece
-- hasta que esa persona cierra el conteo y empieza uno nuevo. Pedido
-- explícito: que aparezca solo, en vivo.
--
-- Mismo mecanismo que ya usa la tarjeta de sugerencia para `desconocidos`
-- (20260806000006): agregar la tabla a la publicación de Realtime.
-- `productos`/`codigos_barra` ya son de lectura pública para cualquier
-- autenticado (productos_select/codigos_barra_select, Fase 1) — no hace
-- falta tocar RLS, Realtime respeta esas mismas policies.
alter publication supabase_realtime add table productos;
alter publication supabase_realtime add table codigos_barra;

-- REPLICA IDENTITY FULL solo en codigos_barra: para poder borrar del
-- catálogo local un código que se eliminó/desactivó, el cliente necesita
-- el codigo_norm de la fila BORRADA, y por default Postgres solo manda la
-- primary key (id) en el payload "old" de un DELETE — no el codigo_norm.
-- Tabla chica y sin datos sensibles (ni costo ni precio viven acá), así
-- que el costo extra de replicar la fila completa es despreciable.
alter table codigos_barra replica identity full;
