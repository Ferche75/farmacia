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
export const CAMPOS_SISTEMA = [
  { campo: "codigoBarra", label: "Código de barras", requerido: false },
  { campo: "nombre", label: "Nombre", requerido: true },
  { campo: "concentracion", label: "Concentración", requerido: false },
  { campo: "contenido", label: "Contenido (número)", requerido: false },
  { campo: "unidad", label: "Unidad", requerido: false },
  { campo: "forma", label: "Forma", requerido: false },
  { campo: "principioActivo", label: "Principio activo", requerido: false },
  { campo: "categoria", label: "Categoría / línea", requerido: false },
  { campo: "codigoProveedor", label: "Código de proveedor", requerido: false },
  { campo: "laboratorio", label: "Laboratorio (si el archivo mezcla varios)", requerido: false },
  { campo: "costo", label: "Costo", requerido: false },
  { campo: "precio", label: "Precio", requerido: false },
] as const;

export type CampoSistema = (typeof CAMPOS_SISTEMA)[number]["campo"];

/** columna del archivo -> campo del sistema (o "" si no está mapeada) */
export type MapeoColumnas = Record<CampoSistema, string>;

export const MAPEO_VACIO: MapeoColumnas = {
  codigoBarra: "",
  nombre: "",
  concentracion: "",
  contenido: "",
  unidad: "",
  forma: "",
  principioActivo: "",
  categoria: "",
  codigoProveedor: "",
  laboratorio: "",
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
  nombre: ["itemname", "nombre", "producto", "nombreproducto", "articulo", "item"],
  principioActivo: ["principioactivo", "principio", "pa", "dci"],
  concentracion: ["concentracion", "concentration", "dosis"],
  contenido: ["contenido"],
  unidad: ["unidad"],
  forma: ["forma"],
  categoria: ["categoria", "linea", "grupo", "rubro"],
  costo: ["costo", "cost", "preciocosto", "precioproveedor"],
  precio: ["precio", "price", "precioventa", "pvp"],
};

const ORDEN_AUTOMAPEO: CampoSistema[] = [
  "codigoProveedor", "codigoBarra", "laboratorio", "nombre", "principioActivo",
  "concentracion", "contenido", "unidad", "forma", "categoria", "costo", "precio",
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
