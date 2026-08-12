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
