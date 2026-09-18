// Campos del sistema a los que se puede mapear una columna del archivo
// (spec Fase 2). Decisión original: "laboratorio" quedaba afuera del
// mapeo porque el flujo asumía "un archivo = un laboratorio" (el
// laboratorio se elegía una sola vez para todo el archivo, arriba del
// wizard). Relajado en 20260812000001_importacion_multilab_y_sin_codigo.sql:
// ahora "laboratorio" también se puede mapear por columna para archivos
// que mezclan varios proveedores (ej. un export del sistema anterior) —
// si se mapea, manda por fila; si no, se sigue usando el laboratorio
// elegido arriba, igual que antes.
//
// "codigoBarra" pasó de requerido a opcional en el mismo cambio: una fila
// sin código de barra intenta actualizar un producto ya existente
// buscándolo por nombre exacto (nunca crea uno nuevo por ese camino) —
// para listas de precio que no traen código. "nombre" sigue requerido
// porque ese camino lo necesita siempre.
//
// SINCRONIZACIÓN MANUAL (no hay generación de código compartida entre SQL
// y TS en este proyecto). Agregar o sacar una entrada acá obliga a tocar
// a mano, en el mismo cambio:
//   1. MAPEO_VACIO, más abajo en este archivo.
//   2. FilaImportacion + filaImportacionAPayload (packages/db/src/rpc.ts)
//      y aplicarMapeo (apps/admin/lib/importacion.ts), si el campo se
//      tiene que poder importar de verdad y no solo mapear en pantalla.
//   3. El whitelist hardcodeado de `actualizar_config_operativa_empresa`
//      (versión viva:
//      supabase/migrations/20260924000000_envase_de_compra.sql), que
//      rechaza cualquier campo desconocido en la lista de obligatorios.
//   4. `confirmar_importacion_lote` (misma migración), en sus 3 caminos.
//   5. Si además el campo tiene que poder completarse desde apps/conteo:
//      CAMPOS_COMPLETABLES_CONTEO (apps/conteo/lib/campos-obligatorios.ts)
//      y su gemelo `v_campos_completables` en `completar_datos_producto` /
//      `datos_completitud_catalogo_conteo`. Ese subconjunto NUNCA puede
//      incluir `costo` — el precio de COMPRA al proveedor no entra en
//      apps/conteo por ninguna vía. `precio` (el de VENTA) SÍ entra desde
//      20260923000000_precio_obligatorio_y_visible_en_conteo.sql, por
//      pedido explícito del usuario: quien cuenta conoce los precios de
//      venta y puede cargarlos. No confundir los dos.
//
// DOS ENTRADAS DE ESTE ARRAY SON OBLIGATORIAS DEL SISTEMA, no de cada
// empresa: "nombre" (siempre lo fue) y "precio" (desde 20260923000000).
// Siguen figurando acá porque el mapeo de columnas del wizard las necesita,
// pero NO se muestran como checkboxes destildables en Configuración →
// "Campos obligatorios al importar" (config-operativa.tsx las filtra y
// pinta dos filas fijas), y el importador las trata como requeridas sin
// mirar la config de la empresa (importador.tsx, `esRequerido`).
export const CAMPOS_SISTEMA = [
  { campo: "codigoBarra", label: "Código de barras", requerido: false },
  { campo: "unidadesPorCodigo", label: "Unidades por código (caja/blíster)", requerido: false },
  { campo: "nombre", label: "Nombre", requerido: true },
  { campo: "concentracion", label: "Concentración", requerido: false },
  { campo: "contenido", label: "Contenido (número)", requerido: false },
  // Label "Presentación" (2026-09-30, pedido del usuario) — el `campo`
  // interno sigue siendo "unidad" (no se toca: es productos.unidad, y
  // renombrar la key obligaría a la sincronización manual de arriba en
  // TODOS los puntos). Es la MISMA columna que apps/conteo llama
  // "Presentación" en su wizard (UNIDADES_PRESENTACION,
  // packages/db/src/campos-producto.ts): comprimidos, jarabe, ampolla,
  // etc. — "unidades" es uno de los VALORES posibles de esta lista (junto
  // con "ml"/"g", el genérico de último recurso), no un campo aparte. Con
  // la etiqueta "Unidad" acá el usuario no la reconocía como el mismo
  // campo que ya usa apps/conteo.
  { campo: "unidad", label: "Presentación", requerido: false },
  { campo: "principioActivo", label: "Principio activo", requerido: false },
  // marca / accionTerapeutica / especialidad son columnas de `productos`
  // desde 20260918000001_fraccionamiento_marca_y_lotes_manuales.sql, que
  // dejó el cableado al importador y a este archivo explícitamente para
  // una tarea posterior. Esta es esa tarea: al entrar acá pasan a ser
  // (a) columnas mapeables en el wizard de importación y (b) checkboxes
  // de "Campos obligatorios al importar" (config-operativa.tsx itera este
  // array, no hay UI que tocar).
  { campo: "marca", label: "Marca", requerido: false },
  { campo: "accionTerapeutica", label: "Acción terapéutica", requerido: false },
  { campo: "especialidad", label: "Especialidad", requerido: false },
  { campo: "categoria", label: "Categoría / línea", requerido: false },
  { campo: "codigoProveedor", label: "Código de proveedor", requerido: false },
  { campo: "laboratorio", label: "Laboratorio (si el archivo mezcla varios)", requerido: false },
  { campo: "fabricante", label: "Fabricante", requerido: false },
  { campo: "distribuidor", label: "Distribuidor", requerido: false },
  // Columna de `productos_empresa` desde
  // 20260924000000_envase_de_compra.sql. Mismo trato que distribuidor /
  // loteCatalogo: mapeable en el wizard, opcionalmente obligatoria vía la
  // config de la empresa, nunca requerida por el sistema. NO entra al
  // subconjunto completable de apps/conteo (punto 5 de la lista de arriba)
  // a propósito: en qué envase vino la compra es una preocupación de
  // administración, no algo que un operario tenga que resolver con el
  // lector en la mano. Si una empresa lo tilda como obligatorio, lo exige
  // el importador y el popup de conteo lo ignora — igual que `costo`.
  { campo: "envaseCompra", label: "Envase de compra", requerido: false },
  { campo: "loteCatalogo", label: "Lote", requerido: false },
  { campo: "loteCatalogo2", label: "Lote 2", requerido: false },
  { campo: "costo", label: "Costo", requerido: false },
  { campo: "precio", label: "Precio", requerido: false },
] as const;

export type CampoSistema = (typeof CAMPOS_SISTEMA)[number]["campo"];

/** columna del archivo -> campo del sistema (o "" si no está mapeada) */
export type MapeoColumnas = Record<CampoSistema, string>;

export const MAPEO_VACIO: MapeoColumnas = {
  codigoBarra: "",
  unidadesPorCodigo: "",
  nombre: "",
  concentracion: "",
  contenido: "",
  unidad: "",
  principioActivo: "",
  marca: "",
  accionTerapeutica: "",
  especialidad: "",
  categoria: "",
  codigoProveedor: "",
  laboratorio: "",
  fabricante: "",
  distribuidor: "",
  envaseCompra: "",
  loteCatalogo: "",
  loteCatalogo2: "",
  costo: "",
  precio: "",
};

// Sinónimos de headers reales que ya se vieron en archivos de
// proveedores (ver docs/decisiones.md, "Campos nuevos..."). El orden de
// ORDEN_AUTOMAPEO importa: los campos más específicos van primero para
// quedarse con el header antes de que un campo más genérico lo reclame
// (ej. "ItemCode" tiene que caer en codigoProveedor, no en codigoBarra,
// aunque codigoBarra también acepte "codigo" como sinónimo genérico).
const SINONIMOS: Partial<Record<CampoSistema, string[]>> = {
  codigoProveedor: [
    "itemcode", "codproveedor", "codigoproveedor", "codprov", "codinterno",
    "codigointerno", "codsistema", "codigosistema", "referencia", "sku",
  ],
  codigoBarra: [
    "codebars", "codigobarra", "codigodebarra", "codigosbarra", "codbarra",
    "codbarras", "barcode", "ean", "ean13", "gtin", "codigo",
  ],
  laboratorio: ["laboratorio", "lab"],
  fabricante: ["fabricante", "manufacturer", "manufactura"],
  distribuidor: ["distribuidor", "distributor"],
  envaseCompra: ["envase", "envasecompra", "tipoenvase", "empaque"],
  loteCatalogo: ["lote"],
  loteCatalogo2: ["lote2", "lotedos", "loteb"],
  nombre: ["itemname", "nombre", "producto", "nombreproducto", "articulo", "item"],
  principioActivo: ["principioactivo", "principio", "pa", "dci"],
  marca: ["marca", "brand", "marcacomercial"],
  accionTerapeutica: ["accionterapeutica", "accion", "acciones", "terapeutica"],
  especialidad: ["especialidad", "especialidadmedica"],
  concentracion: ["concentracion", "concentration", "dosis"],
  contenido: ["contenido"],
  // "presentacion" sumado junto al "unidad" que ya estaba: un archivo de
  // proveedor puede traer cualquiera de los dos headers para lo mismo.
  unidad: ["unidad", "presentacion"],
  categoria: ["categoria", "linea", "grupo", "rubro"],
  costo: ["costo", "cost", "preciocosto", "precioproveedor"],
  precio: ["precio", "price", "precioventa", "pvp"],
};

const ORDEN_AUTOMAPEO: CampoSistema[] = [
  "codigoProveedor", "codigoBarra", "laboratorio", "fabricante", "distribuidor", "nombre",
  "principioActivo", "accionTerapeutica", "especialidad", "marca",
  "concentracion", "contenido", "unidad", "categoria",
  // envaseCompra va DESPUÉS de "unidad" y no pegado a "distribuidor",
  // aunque sean campos hermanos (los dos de productos_empresa): su
  // sinónimo genérico "envase" tiene 6 caracteres, o sea que matchea por
  // contención, y un header como "Unidad de envase" es presentación, no
  // envase de compra. Dejando que "unidad" reclame primero, el caso
  // ambiguo cae del lado correcto. Los headers inequívocos
  // ("Envase", "Tipo de envase", "Empaque") no contienen "unidad" y le
  // llegan igual.
  "envaseCompra",
  "loteCatalogo2", "loteCatalogo", "costo", "precio",
];

function normalizarHeader(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Adivina el mapeo columna → campo del sistema a partir de los headers
 * del archivo, por nombre. Deliberadamente conservador: solo mapea "a
 * ojo" (contención en vez de igualdad exacta) para sinónimos de 5+
 * caracteres — un sinónimo corto como "pa" solo matchea si el header
 * ENTERO es "pa", nunca como substring de un header más largo, para no
 * generar falsos positivos. Cada header se usa como mucho una vez;
 * "cantidad"/columnas combinadas (contenido+unidad en el mismo header,
 * ver aplicarMapeo) quedan afuera a propósito — mejor sin mapear que
 * adivinado mal en un caso ambiguo documentado. */
export function autoMapearColumnas(headers: string[]): Partial<MapeoColumnas> {
  const disponibles = [...headers];
  const sugerido: Partial<MapeoColumnas> = {};

  for (const campo of ORDEN_AUTOMAPEO) {
    const sinonimos = SINONIMOS[campo] ?? [];

    let elegido = disponibles.find((h) => sinonimos.includes(normalizarHeader(h)));

    if (!elegido) {
      elegido = disponibles.find((h) => {
        const hn = normalizarHeader(h);
        return sinonimos.some((s) => s.length >= 5 && (hn.includes(s) || s.includes(hn)));
      });
    }

    if (elegido) {
      sugerido[campo] = elegido;
      disponibles.splice(disponibles.indexOf(elegido), 1);
    }
  }

  return sugerido;
}
