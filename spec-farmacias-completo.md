# Sistema de Inventario Farmacéutico — Spec completa para Claude Code

Documento único. Cuando estés listo para arrancar, pasále a Claude Code la Fase 0 completa (todo el bloque de código de esa sección). Después de cada fase, probá antes de seguir con la próxima. No le mandes dos fases juntas.

---

## 1. Decisiones cerradas

| # | Decisión | Cierre |
|---|----------|--------|
| 1 | Alcance | Conteo ahora. El esquema deja la puerta abierta a stock permanente (compras/ventas) sin construirlo todavía |
| 2 | Catálogo | Global, compartido entre empresas |
| 3 | Vencimiento/lote | Sí, capturar siempre que el código lo traiga |
| 4 | Lector Bluetooth | **Pendiente — comprar y probar antes de la Fase 3.** Debe emular teclado (HID) y mandar Enter al final de cada lectura. Si no lo hace, el input de la app de conteo hay que rediseñarlo |
| 5 | Formato archivos de laboratorios | Varía según laboratorio → el mapeador visual de columnas (Fase 2) es imprescindible, no un nice-to-have |

**Bloqueante antes de Fase 3:** conseguir el lector Bluetooth y confirmar que es HID + Enter. Es barato de chequear y evita rediseñar el input a mitad de fase.

---

## 2. Arquitectura: dos apps, un backend

No es una sola PWA con navegación oculta por rol. Son dos apps de Next.js separadas que comparten el mismo proyecto de Supabase:

- **`/apps/conteo`** — PWA mobile-first. Solo login, elegir sucursal, escanear, contar, foto de desconocido. Nada de librerías de gráficos/Excel/PDF en este bundle.
- **`/apps/admin`** — Next.js desktop-first. Importador de catálogo, bandeja de revisión, resumen gerencial, panel de superadmin.

Motivo: performance real (el operario no descarga JS que nunca usa), superficie de ataque más chica (el código de precios ni siquiera existe en el bundle del celular), y deploys independientes.

```
/apps
  /conteo   ← PWA, operario (y admin/gerente cuando cuentan en el piso)
  /admin    ← desktop, admin/gerente/superadmin
/packages
  /db       ← cliente Supabase, tipos generados, wrappers de RPC
/supabase
  /migrations
```

---

## 3. CONTEXTO.md — va a la raíz del repo

```markdown
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
```

---

## 4. Esquema de base de datos (referencia, va completo en la Fase 1)

```sql
-- ═══════ MULTI-TENANCY ═══════
empresas (id, nombre, nit, pais, config jsonb, activo, created_at)
sucursales (id, empresa_id→, nombre, direccion, activo)
perfiles (id = auth.users.id, nombre, empresa_id→, rol, activo)
 -- rol: superadmin | gerente | admin | operario
perfiles_sucursal (perfil_id→, sucursal_id→)

-- ═══════ CATÁLOGO MAESTRO (global, compartido entre empresas) ═══════
laboratorios (id, nombre)
productos (id, nombre, laboratorio_id→, principio_activo, concentracion,
 forma, contenido numeric, unidad, requiere_receta bool, controlado bool,
 origen, activo, created_at, updated_at)
codigos_barra (id, producto_id→, codigo_norm, codigo_raw, tipo, es_principal,
 unidades_por_codigo int DEFAULT 1)

-- ═══════ DATOS POR EMPRESA ═══════
productos_empresa (empresa_id→, producto_id→, costo numeric(14,4),
 precio numeric(14,4), stock_minimo, activo)

-- ═══════ CONTEO ═══════
conteos (id, empresa_id→, sucursal_id→, nombre, tipo, estado,
 iniciado_por→, iniciado_at, cerrado_at, cerrado_por→)
conteo_lineas (id, conteo_id→, producto_id→ NULL, desconocido_id→ NULL,
 cantidad int DEFAULT 0, notas)
escaneos (id, conteo_id→, linea_id→, codigo_raw, codigo_norm, delta int,
 lote, vencimiento, usuario_id→, dispositivo, created_at)

-- ═══════ DESCONOCIDOS ═══════
desconocidos (id, empresa_id→, codigo_norm, codigo_raw, foto_path,
 estado, ia_respuesta jsonb, ia_confianza numeric, ia_intentos int,
 producto_resuelto_id→, revisado_por→, revisado_at, detectado_por→, created_at)

-- ═══════ IMPORTACIÓN ═══════
importaciones (id, empresa_id→, archivo, mapeo jsonb, filas_ok, filas_error,
 log jsonb, estado, creado_por→, created_at)

-- ═══════ RESERVADO — NO CONSTRUIR TODAVÍA ═══════
-- movimientos_stock (id, empresa_id→, sucursal_id→, producto_id→,
--  tipo, -- ingreso|venta|ajuste
--  delta int, referencia, usuario_id→, created_at)
```

**Índices:**
```sql
CREATE UNIQUE INDEX ix_cb_norm ON codigos_barra (codigo_norm);
CREATE INDEX ix_cb_producto ON codigos_barra (producto_id);
CREATE INDEX ix_prod_nombre ON productos USING gin (nombre gin_trgm_ops);
CREATE INDEX ix_prod_lab ON productos (laboratorio_id) WHERE activo;
CREATE INDEX ix_pe_empresa ON productos_empresa (empresa_id) WHERE activo;
CREATE UNIQUE INDEX ix_linea_prod ON conteo_lineas (conteo_id, producto_id)
 WHERE producto_id IS NOT NULL;
CREATE UNIQUE INDEX ix_linea_desc ON conteo_lineas (conteo_id, desconocido_id)
 WHERE desconocido_id IS NOT NULL;
CREATE INDEX ix_escaneos ON escaneos (conteo_id, created_at DESC);
CREATE INDEX ix_desc_pend ON desconocidos (empresa_id, estado) WHERE estado <> 'resuelto';
CREATE INDEX ix_conteos_suc ON conteos (sucursal_id, estado, iniciado_at DESC);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

**Funciones RPC:**
```sql
normalizar_codigo(text) → text
buscar_producto(p_empresa uuid, p_codigo text) → json
registrar_escaneos_batch(p_conteo uuid, p_escaneos jsonb) → json
resumen_conteo(p_conteo uuid) → json
```

---

## 5. Prompt Gemini (para el flujo n8n de la Fase 4)

```
Analizás la fotografía de la caja de un medicamento.
Devolvé ÚNICAMENTE un objeto JSON válido. Sin markdown, sin backticks,
sin explicación, sin texto antes ni después.

Estructura exacta:
{"reconocido":true,"nombre":"","laboratorio":"","concentracion":"","contenido":0,"unidad":"","confianza":0.0}

Reglas:
- nombre: nombre comercial tal como figura en la caja, sin el laboratorio.
- laboratorio: fabricante impreso en la caja.
- concentracion: ej "400 mg", "500 mg/5 ml". Vacío si no está visible.
- contenido: solo el número. "Caja x 20 comprimidos" → 20. "Frasco 120 ml" → 120.
- unidad: uno de comprimidos|capsulas|ml|g|unidades|sobres|ampollas.
- confianza: 0.0 a 1.0 según qué tan legible está la caja.
- NO inventes datos que no estén visibles. Campo ilegible → "" o 0, y bajá la confianza.
- Si no podés identificar el medicamento, devolvé:
  {"reconocido":false,"nombre":"","laboratorio":"","concentracion":"","contenido":0,"unidad":"","confianza":0.0}
```

Config extra en la llamada a Gemini: `response_mime_type: application/json`. Reintentos: 3. Si falla o no reconoce → estado `no_reconocido`.

---

## 6. PROMPTS PARA CLAUDE CODE — uno por fase

### Fase 0 — Fundaciones

```
Leé CONTEXTO.md.

Creá un monorepo con pnpm workspaces:

/apps
  /conteo   ← PWA mobile-first, para operarios (y admin/gerente cuando cuentan)
  /admin    ← Next.js desktop-first, para admin/gerente/superadmin
/packages
  /db       ← cliente Supabase, tipos generados, wrappers de las funciones RPC
/supabase
  /migrations

Las dos apps son proyectos Next.js (App Router) + TypeScript + Tailwind
independientes, cada una con su propio bundle — la app /conteo NO debe incluir
ninguna dependencia de reportes, gráficos o exportación (eso vive solo en /admin).
Ambas comparten el mismo proyecto de Supabase (mismo Auth, mismo Postgres) a
través del paquete /packages/db.

En /apps/conteo: configurá la PWA (manifest, service worker, instalable en
Android). Esta es la única app que corre en el celular del operario.

En /apps/admin: app de escritorio normal, sin PWA.

Implementá autenticación con Supabase Auth (email + contraseña) en ambas apps,
y el modelo de tenancy en /packages/db: empresas, sucursales, perfiles con rol
y perfiles_sucursal. Creá las políticas RLS base para estas tablas.

Creá en /packages/db un helper server-side `getPerfilActual()` que devuelva
empresa_id, rol y sucursales asignadas — usado por ambas apps.

En /apps/admin: layout con navegación que muestre solo lo permitido según el
rol (admin ve menos que gerente, gerente no ve panel de superadmin).
En /apps/conteo: layout mínimo, sin navegación — es una sola pantalla.

Si un usuario con rol operario intenta entrar a /apps/admin, redirigir con
mensaje claro de que esa app no es para su rol.

No implementes todavía catálogo ni conteo.
```

### Fase 1 — Esquema y funciones

```
Implementá el esquema completo de base de datos como migraciones de Supabase,
según el documento adjunto (sección 4): catálogo maestro global (laboratorios,
productos, codigos_barra), datos por empresa (productos_empresa), conteo
(conteos, conteo_lineas, escaneos), desconocidos e importaciones.

Incluí también la tabla movimientos_stock (id, empresa_id, sucursal_id,
producto_id, tipo [ingreso|venta|ajuste], delta, referencia, usuario_id,
created_at) con su RLS, pero SIN ninguna UI ni RPC que la use todavía —
solo queda reservada en el esquema para cuando se decida construir stock
permanente.

Incluí TODOS los índices especificados y habilitá pg_trgm.

Implementá las funciones:
- normalizar_codigo(text): parsea GS1 DataMatrix y GS1-128 extrayendo el GTIN
  (AI 01), lote (AI 10) y vencimiento (AI 17); normaliza UPC-A a EAN-13 y quita
  ceros a la izquierda de GTIN-14.
- buscar_producto(empresa, codigo): devuelve el producto con los campos
  permitidos según el rol de quien llama.
- registrar_escaneos_batch(conteo, jsonb): UPSERT idempotente por client_uuid.
- resumen_conteo(conteo): solo ejecutable por rol gerente.

Escribí tests para normalizar_codigo con al menos 15 casos reales, incluyendo
EAN-13, UPC-A, GTIN-14 y DataMatrix con lote y vencimiento.

Generá también un seed con 12.000 productos ficticios para poder medir
rendimiento desde ahora.
```

### Fase 2 — Importador de catálogo (apps/admin)

```
Pantalla de importación de catálogo en apps/admin (roles admin y gerente).

Sube un archivo CSV o XLSX de un laboratorio y presenta un mapeador visual de
columnas: el usuario asocia cada columna del archivo a un campo del sistema
(codigo_barra, nombre, laboratorio, concentracion, contenido, unidad, forma,
costo, precio). El formato varía según el laboratorio, así que el mapeo se
guarda con nombre para reutilizarlo la próxima vez que llegue el archivo de
ese mismo laboratorio.

Antes de confirmar, mostrá una vista previa con las primeras 20 filas y un
resumen: cuántas se van a crear, cuántas actualizar, cuántas rechazar y por qué.
Nada se escribe hasta que el usuario confirma.

Los códigos se normalizan al importar. Si un código ya existe apuntando a otro
producto, esa fila se rechaza y queda en el log de la importación — nunca se
pisa silenciosamente.

Procesá en lotes de 500 filas con barra de progreso. Tiene que aguantar
archivos de 20.000 filas sin colgar el navegador.

Agregá también un ABM manual de productos y un buscador con búsqueda por nombre
usando el índice trigram.
```

### Fase 3 — Conteo offline (apps/conteo, el corazón)

```
Módulo de conteo en apps/conteo, optimizado para celular Android con lector de
código de barras Bluetooth. Esta es la pantalla más importante del sistema.

Nota: antes de arrancar esta fase, confirmá que el lector Bluetooth ya
comprado emula teclado (HID) y manda Enter al final de cada lectura. Si en
vez de Enter manda Tab u otra tecla, avisame antes de programar el input.

Flujo:
1. El usuario elige sucursal y abre un conteo nuevo o retoma uno abierto.
2. La app descarga el catálogo a IndexedDB con Dexie (solo código, nombre,
   laboratorio, presentación — NUNCA costo ni precio) con barra de progreso e
   indicador de "listo para trabajar offline".
3. Campo de escaneo con foco permanente e inputmode="none".
4. Cada lectura: normalizar → buscar en IndexedDB → si existe, incrementar en 1,
   mostrar el detalle en verde, beep corto, vibración corta.
5. Si no existe: mensaje en ROJO, beep distinto, y botón grande "Tomar foto".
6. Debounce de 400 ms para lecturas idénticas, con aviso visual de duplicado.
7. Botón deshacer el último escaneo.
8. Opción de ingresar cantidad manual para cajas repetidas.
9. Lista en vivo de lo contado, ordenada por último escaneo, editable.
10. Cola de escaneos en IndexedDB, sincronizada cada 10 segundos o al recuperar
    conexión, en lotes, vía registrar_escaneos_batch. Indicador visible de
    pendientes de sincronizar.

Requisitos duros:
- Del escaneo al feedback en pantalla: menos de 100 ms.
- Con el avión activado, el conteo funciona completo y sincroniza al volver.
- Cerrar y reabrir la app no pierde ni un escaneo pendiente.

Probalo simulando 500 escaneos seguidos y mostrame los tiempos.
```

### Fase 4 — Desconocidos y foto (apps/conteo + n8n)

```
Cuando un código no está en el catálogo (en apps/conteo):
- Botón para tomar foto de la parte superior de la caja usando la cámara del
  dispositivo. Comprimir a máximo 1280px de lado mayor y calidad 0.8 antes de
  subir. Subir a Supabase Storage en la ruta empresa_id/conteo_id/.
- Crear el registro en `desconocidos` con estado pendiente_ia y una línea de
  conteo asociada al desconocido, con cantidad 1.
- Si ese mismo código se vuelve a escanear en cualquier momento posterior, NO
  pedir la foto: mostrar la foto ya guardada como confirmación visual y sumar 1.
  Esto debe funcionar también offline (cachear la miniatura localmente).
- Disparar el webhook de n8n de forma asincrónica. El conteo NO se bloquea.
- Cuando llega la respuesta por Supabase Realtime, mostrar una tarjeta no
  invasiva en la parte superior con la sugerencia y los botones Aceptar,
  Corregir y Descartar. Si el usuario la ignora, queda en la bandeja de revisión.

Incluí el flujo de n8n exportado como JSON, listo para importar, con el prompt
de Gemini de la sección 5 de este documento, response_mime_type application/json,
parseo tolerante y 3 reintentos. Si falla o Gemini no reconoce, el estado pasa
a no_reconocido.

Config por empresa: modo "confirmar en el momento" o "solo foto, revisar después".
```

### Fase 5 — Bandeja de revisión (apps/admin)

```
Pantalla de escritorio en apps/admin para roles admin y gerente.

Vista de dos paneles: a la izquierda la lista de desconocidos con filtros por
estado (sugerido, no_reconocido, pendiente_ia), sucursal, conteo y fecha, con
contadores por estado.

A la derecha, la foto grande con zoom y el formulario de identificación, con los
campos precargados por la sugerencia de la IA cuando existe, mostrando el nivel
de confianza. El usuario corrige lo que haga falta.

Al guardar, dos caminos:
- Vincular a un producto que ya existe en el catálogo (buscador con autocompletado).
- Crear un producto nuevo en el catálogo maestro con origen 'ia' o 'manual'.

En ambos casos el código de barra se asocia al producto y TODAS las líneas de
conteo que apuntaban a ese desconocido se migran al producto real, conservando
la cantidad acumulada. La operación es transaccional.

Navegación por teclado para resolver muchos seguidos sin usar el mouse:
Enter para guardar y pasar al siguiente, flechas para navegar.
```

### Fase 6 — Cierre y resumen gerencial (apps/admin)

```
Cierre de conteo: valida que no queden escaneos sin sincronizar, avisa cuántos
desconocidos quedan sin identificar y pide confirmación. Una vez cerrado, el
conteo es de solo lectura.

Resumen gerencial en apps/admin, accesible ÚNICAMENTE por rol gerente
(validado en RLS, no solo en el frontend):
- Valorización total a costo y a precio, con margen teórico.
- Unidades totales, SKU distintos contados, SKU del catálogo no encontrados.
- Top 20 productos por valor inmovilizado.
- Desconocidos: total, resueltos por IA, resueltos manualmente, pendientes.
- Productividad por operario y por hora.
- Comparativo entre sucursales y contra el conteo anterior de la misma sucursal.
- Si se capturaron vencimientos: productos con menos de 90 y 180 días.

Export a Excel y a PDF. Gráficos simples, pensados para leerse en una reunión.
```

### Fase 7 — Cierre técnico

```
Auditoría final:
- Revisá que TODAS las tablas con empresa_id tengan RLS activa y probá con dos
  empresas distintas que ninguna vea datos de la otra.
- Verificá que un usuario con rol operario no pueda leer costo ni precio por
  ningún camino, incluida la API REST directa de Supabase.
- Verificá que apps/conteo no incluya en su bundle final ninguna librería de
  reportes, gráficos o exportación (revisar el bundle analyzer).

Panel de superadmin (apps/admin) para crear empresas, sucursales y usuarios.
Backup y export completo del catálogo.
README de instalación y guía corta de operación para el empleado que cuenta,
en español, con capturas.
```

---

## 7. Antes de arrancar (checklist)

- [ ] Comprar y probar el lector Bluetooth (HID + Enter confirmado)
- [ ] Confirmar que tenés acceso al proyecto Supabase
- [ ] Tener a mano al menos un archivo real de catálogo de un laboratorio (para probar el mapeador en Fase 2)
