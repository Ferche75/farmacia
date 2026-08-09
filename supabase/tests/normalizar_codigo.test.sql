-- Tests de normalizar_codigo() — 18 casos. Sin dependencias de pgTAP:
-- corre en cualquier lado (SQL Editor de Supabase Studio, psql, CLI) y
-- tira una excepción con el detalle de cada caso que falle. Si termina
-- sin error, se ve el RAISE NOTICE final con el total de casos OK.
--
-- Se corre DESPUÉS de aplicar 20260806000001_catalogo_conteo.sql y
-- 20260806000002_funciones_rpc.sql. No modifica datos (no hace INSERT en
-- ninguna tabla), así que se puede correr las veces que haga falta.

do $$
declare
  v_caso record;
  v_resultado codigo_normalizado;
  v_fallos integer := 0;
  v_total integer := 0;
begin
  for v_caso in
    select * from (values
      -- descripcion, input, esperado_norm, esperado_lote, esperado_venc

      -- EAN-13 plano
      ('EAN-13 plano', '7501234567892', '7501234567892', null::text, null::date),
      ('EAN-13 con guiones/espacios', ' 750-1234567892 ', '7501234567892', null::text, null::date),

      -- UPC-A -> EAN-13 (se completa con un 0 adelante)
      ('UPC-A simple', '036000291452', '0036000291452', null::text, null::date),
      ('UPC-A que ya arranca en 0', '003600029145', '0003600029145', null::text, null::date),

      -- GTIN-14 -> se le sacan los ceros a la izquierda
      ('GTIN-14 con un cero adelante (matchea el EAN-13 de arriba)', '07501234567892', '7501234567892', null::text, null::date),
      ('GTIN-14 con varios ceros adelante', '00001234567890', '1234567890', null::text, null::date),
      ('GTIN-14 todo ceros (caso límite)', '00000000000000', '0', null::text, null::date),

      -- Otros largos (no tocados por las reglas de 12/14)
      ('EAN-8 plano, sin tocar', '12345670', '12345670', null::text, null::date),

      -- Vacíos / basura
      ('String vacío', '', null::text, null::text, null::date),
      ('Solo espacios', '   ', null::text, null::text, null::date),
      ('NULL', null::text, null::text, null::text, null::date),
      ('Solo letras, sin dígitos', 'ABCDEF', null::text, null::text, null::date),

      -- GS1 DataMatrix legible: (01)(17)(10) en distinto orden/subconjunto
      ('DataMatrix 01+17+10 completo', '(01)07501234567892(17)251231(10)LOTE123', '7501234567892', 'LOTE123', '2025-12-31'::date),
      ('DataMatrix 01+10+17, orden distinto, GTIN con varios ceros', '(01)00001234567890(10)ABC-99(17)260101', '1234567890', 'ABC-99', '2026-01-01'::date),
      ('DataMatrix solo 01+10, sin vencimiento', '(01)00360002914523(10)L1', '360002914523', 'L1', null::date),
      ('DataMatrix solo 01+17, sin lote', '(01)12345678901234(17)260630', '12345678901234', null::text, '2026-06-30'::date),
      ('DataMatrix con GTIN inválido (no 14 dígitos) pero 17 sí parsea', '(01)1234567890(17)260101', null::text, null::text, '2026-01-01'::date),

      -- GS1-128 "crudo" (sin paréntesis), orden 01 -> 17 -> 10, sin FNC1 real
      ('GS1-128 crudo 01+17+10 sin separador',
        '01' || '00360002914523' || '17' || '260731' || '10' || 'LOTE7',
        '360002914523', 'LOTE7', '2026-07-31'::date),

      -- GS1-128 crudo, solo GTIN (sin 17 ni 10)
      ('GS1-128 crudo, solo 01', '01' || '12345678901234', '12345678901234', null::text, null::date)
    ) as t(descripcion, input, esperado_norm, esperado_lote, esperado_venc)
  loop
    v_total := v_total + 1;
    v_resultado := normalizar_codigo(v_caso.input);

    if v_resultado.codigo_norm is distinct from v_caso.esperado_norm
       or v_resultado.lote is distinct from v_caso.esperado_lote
       or v_resultado.vencimiento is distinct from v_caso.esperado_venc
    then
      v_fallos := v_fallos + 1;
      raise warning
        'FALLÓ [%] input=% → obtenido=(norm=%, lote=%, venc=%) esperado=(norm=%, lote=%, venc=%)',
        v_caso.descripcion, v_caso.input,
        v_resultado.codigo_norm, v_resultado.lote, v_resultado.vencimiento,
        v_caso.esperado_norm, v_caso.esperado_lote, v_caso.esperado_venc;
    end if;
  end loop;

  if v_fallos > 0 then
    raise exception '% de % casos de normalizar_codigo() fallaron — ver los WARNING de arriba', v_fallos, v_total;
  end if;

  raise notice 'OK: % de % casos de normalizar_codigo() pasaron', v_total, v_total;
end $$;
