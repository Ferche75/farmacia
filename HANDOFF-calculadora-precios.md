> **ACTUALIZACIÓN 2026-09-18 — este diseño se descartó.** Se escribió mirando
> una versión vieja de Farmacia. La real ya tenía (desde
> `20260918000001_fraccionamiento_marca_y_lotes_manuales.sql`, confirmado
> con el dueño) un modelo fijo de 3 niveles —caja/blíster/unidad— donde
> `precio_blister`/`precio_unidad` los carga el vendedor A MANO,
> explícitamente NO proporcionales al precio de caja. Ese modelo no se
> tocó. Lo que se construyó en su lugar es una calculadora que solo
> SUGIERE (precarga editable, nunca guarda sola) esos dos campos, con
> reglas configurables por empresa en `/configuracion` (una para blíster,
> una para unidad — no una lista abierta de tipos). Ver:
> `supabase/migrations/20260930000001_calculadora_precios_empresa.sql`,
> `apps/admin/lib/calculadora-precios.ts`,
> `apps/admin/app/(app)/configuracion/calculadora-precios.tsx`, y el botón
> "Usar Bs…" en `productos-abm.tsx`. El resto de este documento queda como
> registro de la fórmula (suma/multiplicador/porcentaje + redondeo a 0,50
> hacia arriba, sí confirmada con el dueño) y del contexto original — no
> como plan vigente.

# Handoff: calculadora de precios por presentación

**Para:** otra sesión de Claude Code que va a revisar, terminar o rehacer este trabajo.
**Estado real:** todo lo de acá está **sin commitear y sin pushear**. `git status` en la raíz de este repo (`Farmacia/`) lo confirma — nada de esto llegó a `origin/main` ni a ninguna base de datos real. Es 100% descartable si se decide rehacerlo distinto.

## Por qué existe esto

Otra sesión de Claude (trabajando principalmente en el repo separado `pdvlat`, la raíz de `D:\escritorio\pdvlat`, NO en este) tocó este repo (`Farmacia/`) sin que el dueño se lo pidiera explícitamente a esa sesión — el dueño ya tenía pensado que esta parte la hiciera otra sesión de Claude aparte, dedicada a este repo. Fue un malentendido de esa sesión, no una instrucción del dueño. Por eso existe este documento: para que quien retome esto tenga el contexto completo sin tener que reconstruirlo, y decida si lo aprovecha, lo corrige o lo tira y empieza de cero.

## El problema de negocio

Una farmacia vende el mismo producto en varias presentaciones: la caja completa, el blíster suelto, el comprimido suelto. Hoy (antes de este cambio) el farmacéutico carga **un solo precio** por producto, en `productos_empresa.precio` — y ese precio es siempre el de la presentación con más unidades (típicamente la caja). Los demás precios no existen en ningún lado del sistema: se calculan a mano, en el mostrador, con una calculadora física.

Lo que se pidió: que el sistema calcule solo los precios de las demás presentaciones a partir de ese precio base, con una regla configurable por tipo de presentación, y un redondeo específico. El farmacéutico sigue cargando un solo precio (el de la caja) — nunca los otros a mano. Un producto con una sola presentación (ej. un jarabe, no fraccionable) no tiene nada que calcular.

### La fórmula exacta (confirmada con el dueño del negocio, no inventada)

Para cada código de barras del producto que **no** sea la presentación base:

```
fracción  = precio_base × (unidades_de_ese_código / unidades_del_código_base)
ajustado  = aplicarRegla(fracción, operación_del_tipo, valor_del_tipo)
precio    = redondear(ajustado)
```

- `aplicarRegla`: `suma` → `base + valor`; `multiplicador` → `base * valor`; `porcentaje` → `base * (1 + valor/100)`. Las tres conviven porque el farmacéutico a veces piensa en plata ("le sumo 1 peso") y a veces en margen ("le cargo 20%").
- `redondear`: **siempre hacia arriba**, al próximo múltiplo de 0,50. `Math.ceil(precio / 0.5) * 0.5`. Ejemplos reales que dio el dueño: `1.23 → 1.50` (no llega a la marca, sube), `1.51 → 2.00` (la pasó, sube a la del próximo entero), `1.50 → 1.50` (ya está justo, se queda). Verificado con Node, los tres exactos.
- La **presentación base** de un producto es la que tiene más `unidades_por_codigo` — no un tipo con nombre fijo ("caja"), sino la que matemáticamente tiene más unidades. Esa se muestra con el precio base tal cual, sin regla ni redondeo.
- Un código de barras **sin tipo de presentación asignado todavía** (el estado inicial de TODOS los códigos existentes hoy) devuelve `precio: null` — nunca se inventa un valor.

### Decisión clave: tipos de presentación abiertos, no fijos

El dueño eligió explícitamente que los tipos ("caja", "blíster", "unidad", o lo que sea — "frasco", "ampolla", "sobre") sean **configurables por empresa**, no una lista fija de 3. Cada tipo tiene su propia regla, configurada UNA vez por la empresa (no por producto individual) — todos los códigos de barra que tengan ese tipo asignado heredan la misma regla.

### Decisión clave: los datos existentes no se migran solos

Ningún código de barras existente tiene tipo asignado hoy. El dueño eligió explícitamente que el farmacéutico lo vaya completando **a mano, de a poco**, desde la pantalla de productos — sin migración masiva ni inferencia automática. Mientras un código no tenga tipo, ese producto se sigue viendo sin desglose (como si esto no existiera).

## Lo que se implementó

### 1. Migración SQL — `supabase/migrations/20260919000000_calculadora_precios_presentacion.sql`

**No se corrió contra ninguna base real.** Solo existe el archivo.

- Tabla `tipos_presentacion`: `id, empresa_id, nombre, operacion (check: 'suma'|'multiplicador'|'porcentaje'), valor numeric(14,4), activo, created_at, updated_at`, `unique(empresa_id, nombre)`. RLS habilitada: SELECT para cualquier usuario de la empresa (operario incluido — es lógica de precio, no costo/precio de producto puntual); INSERT/UPDATE/DELETE solo `admin`/`gerente` de la propia empresa, más policies separadas para superadmin (mismo patrón que `20260806000009_superadmin_rls.sql`).
- `alter table codigos_barra add column tipo_presentacion_id uuid references tipos_presentacion(id) on delete set null` + índice parcial (`where tipo_presentacion_id is not null`).
- El archivo tiene comentarios extensos explicando cada decisión (por qué es abierto, por qué no hay backfill, por qué `on delete set null` y no `cascade`, la particularidad de que `codigos_barra` es una tabla global sin `empresa_id` propio). Leerlos antes de tocar algo — ya justifican la mayoría de las decisiones de diseño.

### 2. Motor de cálculo — `apps/admin/lib/calculadora-precios.ts` (archivo nuevo)

Exporta `aplicarRegla`, `redondear`, `calcularPresentaciones` y los tipos `OperacionPresentacion`, `CodigoConTipo`, `PresentacionCalculada`. Sin dependencias de Next/Supabase — función pura, fácil de testear aislada. Usado tanto por el endpoint (servidor) como por la vista previa en vivo del formulario de productos (cliente) — por eso no tiene `"server-only"`.

Los precios **no se persisten en ningún lado** — se calculan al vuelo en cada request. Es a propósito (está documentado en el archivo): persistirlos duplicaría estado y dejaría precios viejos pegados si cambia la regla o el precio base.

### 3. Endpoint modificado — `apps/admin/app/api/pdvlat/catalogo/route.ts`

Este es el endpoint que ya usa pdvlat (el POS externo) para importar el catálogo. Cambios:

- **Se encontró y arregló un bug preexistente, no relacionado con la calculadora pero crítico**: el campo `codigo_barra` de la respuesta era un OBJETO `{codigo_norm, codigo_raw, unidades_por_codigo}`, pero pdvlat lo lee como si fuera un string. Ahora es un string (`principal.codigo_norm`) directamente. Se confirmó que ningún otro caller de este repo usa este endpoint (es exclusivo para la integración con pdvlat).
- Se agregó `stock` real por producto, vía la función `stock_actual()` que ya existía (`20260901000000_integracion_pdvlat_stock.sql`), en tandas de 25 llamadas RPC en paralelo (no las 500 de golpe, para no saturar el pooler de Supabase). Ojo: ese stock está expresado en "lo que se escanea" para ese código, no necesariamente en unidades sueltas — mismo criterio que ya usa `registrar_venta`, documentado en el código.
- Se agregó `fraccionable: boolean` (true si el producto tiene más de un código de barras) y `presentaciones: PresentacionCalculada[]` (el array calculado, incluida la base).
- **Nada de lo que ya mandaba el endpoint se borró** — es aditivo.
- El `.select()` de Supabase ahora también trae `tipo_presentacion_id` y hace join a `tipos_presentacion(empresa_id, nombre, operacion, valor)` dentro de `codigos_barra`. Hay un chequeo explícito de que el tipo traído sea de la MISMA empresa que está pidiendo el catálogo (porque `codigos_barra` es una tabla global sin `empresa_id`, y la consulta corre con `service_role` sin RLS) — un tipo de otra empresa se trata como "sin clasificar", nunca se usa su regla.

### 4. UI de administración

- **`apps/admin/app/(app)/configuracion/tipos-presentacion.tsx`** (archivo nuevo): ABM de tipos de presentación — crear, editar, activar/desactivar. Calcado del patrón de otra pantalla existente del repo (`sucursales-bodegas.tsx`), con una vista previa de la regla aplicada sobre un precio de muestra.
- **`apps/admin/app/(app)/configuracion/page.tsx`**: nueva sección "Presentaciones y precios" que enlaza a la pantalla de arriba, con visibilidad condicionada al rol (`admin`/`gerente`).
- **`apps/admin/app/(app)/productos/productos-abm.tsx`**: al editar un producto (no al crear uno nuevo — recién existe cuando ya tiene id), se listan sus códigos de barra existentes (ordenados de mayor a menor `unidades_por_codigo`, para que el primero sea intuitivamente "el que manda el precio base") con un `<select>` para asignarle un tipo de presentación a cada uno, y una columna con el precio calculado en vivo (usando `calcularPresentaciones` del lado del cliente, contra el precio base actual del formulario, sin guardar nada hasta tocar "Guardar"). Los cambios de tipo se guardan junto con el resto del formulario, no al tocar el select — así "Cancelar" sigue significando "no cambié nada".

### 5. Tipos de Supabase — `packages/db/src/types/database.types.ts`

Este archivo declara explícitamente en su propio header que los tipos son **manuales** (no generados desde un proyecto Supabase conectado). Se extendió a mano con `tipos_presentacion` y `codigos_barra.tipo_presentacion_id` porque si no, el typecheck fallaba. Si en algún momento este repo empieza a generar los tipos automáticamente, este parche manual se vuelve innecesario/puede chocar — revisarlo entonces.

## Lo que NO se hizo / quedó pendiente

1. **El build completo nunca se pudo correr.** `apps/admin/node_modules` tiene los paquetes de `next`/`typescript`/`@types/*` vacíos (no son symlinks rotos, son carpetas sin contenido) y `pnpm store status` avisa que el store cambió de ubicación o de major de pnpm. Reinstalar (`pnpm install`) iba a purgar `node_modules` desde cero con el store en un estado raro, así que no se corrió por precaución. Lo que SÍ se hizo: typecheck aislado de `calculadora-precios.ts` en modo `--strict` (OK), y chequeo de sintaxis con la API del compilador de TypeScript sobre los 6 archivos tocados/creados (todos parsean sin errores). **Antes de confiar en esto, hay que arreglar el entorno de `node_modules` y correr un build real.**
2. **No se corrió la migración contra ninguna base.** Ni local ni remota. Es solo el archivo SQL.
3. **El lado de pdvlat (el otro repo) también se tocó**, para consumir este nuevo contrato — leer `precio` en vez de un campo que nunca existió (`precio_venta`), arreglar OTRO bug de forma de respuesta (`{productos, siguiente_cursor}` vs lo que pdvlat esperaba, `{items, next_cursor}`), y mapear el array abierto de `presentaciones` a las 3 columnas fijas que ya tiene el POS de pdvlat (buscando por nombre "blister"/"caja", sin acentos ni mayúsculas). Ese trabajo SÍ correspondía a la sesión que lo hizo (era "la parte de PDV"), y quedó separado de este — no es parte de lo que hay que reconsiderar acá, pero sí depende de que el contrato que arma este endpoint no cambie de forma sin avisar del otro lado.
4. **Generalizar el POS de pdvlat a presentaciones dinámicas** (no solo blíster/caja fijos) quedó explícitamente fuera de alcance, decisión del dueño. Si algún tipo de presentación con nombre distinto a "blister"/"caja" se configura acá, pdvlat lo calcula y lo tiene disponible en `presentaciones`, pero hoy no tiene dónde mostrarlo en el POS.

## Cómo verificar la fórmula rápido, sin levantar nada

```js
node -e "
const redondear = p => Math.ceil(p / 0.5) * 0.5;
console.log(redondear(1.23)); // 1.5
console.log(redondear(1.51)); // 2
console.log(redondear(1.50)); // 1.5
"
```

## Archivos, de un vistazo

**Nuevos:**
- `supabase/migrations/20260919000000_calculadora_precios_presentacion.sql`
- `apps/admin/lib/calculadora-precios.ts`
- `apps/admin/app/(app)/configuracion/tipos-presentacion.tsx`

**Modificados:**
- `apps/admin/app/api/pdvlat/catalogo/route.ts`
- `apps/admin/app/(app)/configuracion/page.tsx`
- `apps/admin/app/(app)/productos/productos-abm.tsx`
- `packages/db/src/types/database.types.ts`
