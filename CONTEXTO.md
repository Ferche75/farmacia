# CONTEXTO DEL PROYECTO

## Qué es
Sistema de inventario para farmacias. Multi-empresa y multi-sucursal.
Dos apps separadas que comparten el mismo backend de Supabase:
- apps/conteo: PWA para el conteo físico de stock con lector de código de
  barras Bluetooth desde un celular Android. Uso: operarios.
- apps/admin: panel de escritorio para importar catálogo, revisar
  desconocidos y ver el resumen gerencial. Uso: admin/gerente/superadmin.

## Stack
- Next.js (App Router) + TypeScript + Tailwind, en dos apps independientes
  bajo un monorepo con pnpm workspaces
- Supabase: Postgres, Auth, Storage, Realtime, RLS — un solo proyecto
  compartido por ambas apps vía packages/db
- Dexie (IndexedDB) para el catálogo offline y la cola de escaneos, solo en
  apps/conteo
- n8n + Gemini para identificar productos desconocidos por foto

## Reglas no negociables
1. apps/conteo DEBE funcionar sin internet. El catálogo se descarga a
   IndexedDB al abrir el conteo y el match del código es 100% local.
2. Los escaneos se encolan localmente y se sincronizan en lotes. La
   sincronización es idempotente por client_uuid: un reintento NUNCA
   duplica cantidades.
3. Costos y precios se protegen con RLS a nivel de base, no ocultando en el
   frontend. apps/conteo no incluye código que siquiera pida costo/precio;
   el catálogo que baja al celular no contiene esos campos.
4. Todo código de barra pasa por normalizar_codigo() antes de cualquier
   búsqueda. Soporta EAN-13, UPC-A, GTIN-14 y GS1 DataMatrix / GS1-128 con AIs.
5. Cada escaneo se guarda como evento inmutable en `escaneos`. La cantidad
   de la línea es la suma de sus eventos, nunca un valor editado a mano sin
   registro.
6. La llamada a la IA es asincrónica y NUNCA bloquea el conteo.
7. Toda tabla con empresa_id lleva política RLS. Sin excepciones.
8. apps/conteo y apps/admin son proyectos separados con bundles separados.
   apps/conteo no importa librerías de reportes, gráficos ni exportación.

## Alcance: conteo ahora, stock permanente después
Hoy el sistema solo hace conteo físico. El esquema deja reservada (sin UI
todavía) una tabla movimientos_stock para cuando el cliente quiera
descontar por venta. No construir esa funcionalidad hasta que se pida.

## Objetivo de rendimiento
Catálogo de referencia: 10.000+ SKU, escalable a 100.000.
Del escaneo al feedback visual en pantalla: menos de 100 ms (match local).
La sincronización con el servidor es en segundo plano y no bloquea la UI.

## Interfaz del módulo de conteo (celular)
- Campo de entrada SIEMPRE con foco automático. El lector Bluetooth se
  comporta como un teclado HID: escribe el código y manda Enter.
- El teclado virtual del celular NO debe abrirse (inputmode="none").
- Contador grande y legible a un brazo de distancia.
- Feedback sonoro y vibración distintos para encontrado / desconocido / duplicado.
- Debounce de 400 ms para lecturas idénticas consecutivas.
- Botón deshacer último escaneo, siempre visible.
- Se usa con una mano y de pie. Botones grandes, mínimo contraste alto.

## Idioma
Toda la interfaz, mensajes y comentarios en español (Bolivia).
Moneda: Bolivianos (Bs). Formato de fecha: DD/MM/AAAA.
