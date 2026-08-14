-- Diagnóstico de solo lectura: qué migraciones pendientes ya están
-- aplicadas en este proyecto de Supabase y cuáles faltan. No modifica
-- nada — se puede correr las veces que haga falta.
--
-- Cada fila chequea algo que ESA migración crea (columna, tabla, función
-- o trigger). Correr en el SQL Editor y mirar la columna `aplicada`.

select 'empresas.telefono (20260806000010)' as chequeo,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'empresas' and column_name = 'telefono'
  ) as aplicada
union all
select 'productos.creado_por (20260806000011)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productos' and column_name = 'creado_por'
  )
union all
select 'función actualizar_usuario_superadmin (20260806000011)',
  exists (select 1 from pg_proc where proname = 'actualizar_usuario_superadmin')
union all
select 'productos.categoria (20260812000000)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productos' and column_name = 'categoria'
  )
union all
select 'productos_empresa.codigo_proveedor (20260812000000)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productos_empresa' and column_name = 'codigo_proveedor'
  )
union all
select 'laboratorio por fila / actualizar sin código (20260812000001)',
  exists (
    select 1 from pg_proc
    where proname = 'confirmar_importacion_lote'
      and prosrc like '%producto_no_encontrado_por_nombre%'
  )
union all
select 'tabla bodegas (20260812000002)',
  exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'bodegas'
  )
union all
select 'tabla lotes / cerrar_conteo con vencimiento (20260812000003)',
  exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'lotes'
  )
union all
select 'conteos.bodega_id (20260813000000)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'conteos' and column_name = 'bodega_id'
  )
union all
select 'lotes.bodega_id (20260813000000)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lotes' and column_name = 'bodega_id'
  )
union all
select 'trigger conteos_validar_bodega (20260813000000)',
  exists (select 1 from pg_trigger where tgname = 'conteos_validar_bodega')
union all
select 'función actualizar_datos_contacto_empresa (20260813000001)',
  exists (select 1 from pg_proc where proname = 'actualizar_datos_contacto_empresa')
union all
select 'sucursales/bodegas autoservicio (20260813000002)',
  exists (select 1 from pg_policies where tablename = 'sucursales' and policyname = 'sucursales_insert_propia_empresa')
union all
select 'importaciones.sucursal_id (20260813000003)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'importaciones' and column_name = 'sucursal_id'
  )
union all
select 'laboratorio realmente opcional (20260813000004)',
  exists (
    select 1 from pg_proc
    where proname = 'confirmar_importacion_lote' and prosrc not like '%laboratorio_no_definido%'
  )
union all
select 'operario puede cerrar conteo (20260813000005)',
  exists (
    select 1 from pg_proc
    where proname = 'cerrar_conteo' and prosrc like '%''operario''%'
  )
union all
select 'codigos_barra.unidades_por_codigo en importador (20260813000006)',
  exists (
    select 1 from pg_proc
    where proname = 'confirmar_importacion_lote' and prosrc like '%v_unidades_por_codigo%'
  )
union all
select 'función actualizar_config_operativa_empresa (20260813000007)',
  exists (select 1 from pg_proc where proname = 'actualizar_config_operativa_empresa')
union all
select 'productos.fabricante (20260813000007)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productos' and column_name = 'fabricante'
  )
union all
select 'productos_empresa.lote_catalogo (20260813000007)',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productos_empresa' and column_name = 'lote_catalogo'
  )
union all
select 'tabla productos_sucursales (20260813000008)',
  exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'productos_sucursales'
  )
order by 1;
