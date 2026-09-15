import type { FilaRechazadaImportacion } from "@farmacia/db";

// La traducción a castellano de los `motivo` que devuelve
// confirmar_importacion_lote y que quedan guardados en importaciones.log.
//
// Vive acá y no adentro de importador.tsx porque hay DOS pantallas que
// leen exactamente el mismo arreglo: el popup de "Importación completa"
// (el log que devuelve el RPC en vivo) y /importar/historial (el mismo
// log leído de la base después). Si cada una tuviera su copia de esta
// tabla, tarde o temprano una se actualiza y la otra no, y el usuario ve
// dos explicaciones distintas para el mismo rechazo.
//
// El contrato de los 6 primeros códigos está documentado en
// supabase/migrations/20260909000000_importacion_log_en_respuesta.sql, y
// el séptimo ('error_inesperado') en
// supabase/migrations/20260916000000_importacion_fila_rota_no_tumba_el_lote.sql

// Los códigos traducidos a lo que tiene que HACER quien importó para
// arreglar la planilla. El texto asume cero contexto técnico: nada de "no
// encontrado por nombre", sí "revisá que el nombre esté escrito igual".
export const MOTIVOS_RECHAZO: Record<string, string> = {
  codigo_invalido: "La fila no tiene código de barras ni nombre, así que no hay forma de saber de qué producto se trata.",
  producto_no_encontrado_por_nombre:
    "Sin código de barras solo se pueden actualizar productos que ya existen, y ninguno se llama así. Revisá que el nombre esté escrito exactamente igual que en el sistema, o agregale el código de barras a la fila.",
  nombre_ambiguo:
    "Hay más de un producto con ese mismo nombre en el sistema, así que no se sabe a cuál de todos actualizar. Agregale el código de barras a la fila.",
  nombre_duplicado_en_archivo:
    "Ese producto ya venía en otra fila del archivo. Se usó la primera y esta se descartó: dejá una sola fila por producto.",
  codigo_duplicado_en_archivo:
    "Ese código de barras ya venía en otra fila del archivo. Se usó la primera y esta se descartó: dejá una sola fila por código.",
  ya_pertenece_a_otro_laboratorio:
    "Ese código de barras ya está cargado en el sistema bajo otro laboratorio. Para no pisar el producto de otro proveedor, revisá que el laboratorio de esta importación sea el correcto.",
  // El único de los 7 que no se detecta antes de escribir sino que salta
  // al guardar, y el único que trae `detalle`. En la práctica casi
  // siempre es un número imposible en costo, precio o contenido (una
  // fórmula rota de Excel, una coma decimal de más), así que el texto
  // manda directo a esos campos en vez de hablar de la base.
  error_inesperado:
    "Hubo un problema guardando esta fila que no se pudo identificar de antemano — probablemente un número con un formato raro (costo, precio o contenido). Revisá esos campos en la planilla.",
};

export function textoMotivo(motivo: string): string {
  return MOTIVOS_RECHAZO[motivo] ?? `No se pudo importar (${motivo}).`;
}

/** Lo que identifica la fila para quien mira su propia planilla: el
 * código de barras, o el nombre cuando la fila no traía código. */
export function identificadorFila(fila: FilaRechazadaImportacion): string {
  if (fila.codigo_barra) return fila.codigo_barra;
  if (fila.nombre) return `"${fila.nombre}"`;
  return "(fila sin código ni nombre)";
}

/** El renglón técnico opcional que acompaña al motivo: el error crudo de
 * Postgres que hoy solo trae 'error_inesperado'. Devuelve null cuando no
 * hay nada que mostrar, así las dos pantallas lo pintan con el mismo
 * `&&` y ninguna inventa su propia regla de cuándo aparece.
 *
 * Vive acá por lo mismo que textoMotivo/identificadorFila: el popup en
 * vivo y /importar/historial muestran el MISMO log y no pueden divergir. */
export function detalleTecnico(fila: FilaRechazadaImportacion): string | null {
  const detalle = fila.detalle?.trim();
  return detalle ? detalle : null;
}
