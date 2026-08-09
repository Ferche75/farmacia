// Campos del sistema a los que se puede mapear una columna del archivo
// (spec Fase 2). "laboratorio" queda afuera del mapeo por columna a
// propósito: el flujo real es "un archivo = un laboratorio" (así es como
// están diseñados los RPC de importación — ver docs/decisiones.md), así
// que el laboratorio se elige una sola vez para todo el archivo, no por
// fila.
export const CAMPOS_SISTEMA = [
  { campo: "codigoBarra", label: "Código de barras", requerido: true },
  { campo: "nombre", label: "Nombre", requerido: true },
  { campo: "concentracion", label: "Concentración", requerido: false },
  { campo: "contenido", label: "Contenido (número)", requerido: false },
  { campo: "unidad", label: "Unidad", requerido: false },
  { campo: "forma", label: "Forma", requerido: false },
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
  costo: "",
  precio: "",
};
