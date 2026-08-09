-- Seed de catálogo ficticio para medir rendimiento desde ya (objetivo del
-- spec: 10.000+ SKU, escalable a 100.000 — esto deja 12.000 productos +
-- 25 laboratorios + un código de barra EAN-13 único por producto).
--
-- No toca productos_empresa a propósito: este seed es sobre el catálogo
-- global (para medir el índice trigram de nombre y el lookup de
-- codigo_norm), no sobre pricing de una empresa en particular.
--
-- Corrible una sola vez tal cual. Todo lleva el prefijo 'Producto Demo' /
-- 'Laboratorio Demo' para poder borrarlo después con:
--   delete from productos where nombre like 'Producto Demo %';
--   delete from laboratorios where nombre like 'Laboratorio Demo %';
-- (los codigos_barra se van solos por el ON DELETE CASCADE a productos).

insert into laboratorios (nombre)
select 'Laboratorio Demo ' || lpad(i::text, 3, '0')
from generate_series(1, 25) as i
on conflict (nombre) do nothing;

with labs as (
  select id, row_number() over (order by id) as n
  from laboratorios
  where nombre like 'Laboratorio Demo %'
),
total_labs as (
  select count(*) as c from labs
),
nuevos_productos as (
  insert into productos (
    nombre, laboratorio_id, principio_activo, concentracion, forma,
    contenido, unidad, requiere_receta, controlado, origen
  )
  select
    'Producto Demo ' || lpad(s.i::text, 6, '0'),
    labs.id,
    (array['Paracetamol', 'Ibuprofeno', 'Amoxicilina', 'Loratadina',
           'Omeprazol', 'Metformina', 'Losartán', 'Atorvastatina'])[1 + (s.i % 8)],
    (array['250 mg', '500 mg', '20 mg', '10 mg', '850 mg', '5 mg'])[1 + (s.i % 6)],
    (array['comprimidos', 'cápsulas', 'jarabe', 'ampollas', 'sobres'])[1 + (s.i % 5)],
    (10 + (s.i % 90))::numeric,
    (array['comprimidos', 'cápsulas', 'ml', 'g', 'sobres'])[1 + (s.i % 5)],
    (s.i % 10 = 0),
    (s.i % 50 = 0),
    'manual'
  from generate_series(1, 12000) as s (i)
  join total_labs on true
  join labs on labs.n = 1 + (s.i % total_labs.c)
  returning id
),
numerados as (
  select id, row_number() over () as n from nuevos_productos
)
insert into codigos_barra (producto_id, codigo_norm, codigo_raw, tipo, es_principal, unidades_por_codigo)
select
  id,
  lpad((7800000000000 + n)::text, 13, '0'),
  lpad((7800000000000 + n)::text, 13, '0'),
  'EAN13',
  true,
  1
from numerados;
