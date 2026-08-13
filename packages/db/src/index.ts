// Entry point seguro para Client Components. NO reexportar nada de acá
// que importe el paquete "server-only" (createServerClient,
// getPerfilActual) — eso rompe el build apenas un Client Component
// importa este barrel, aunque no use ese export puntual. Ver ./server.ts.
export { createClient as createBrowserClient } from "./supabase/client";
export type { Database, Rol, Json } from "./types/database.types";
export { normalizarCodigo } from "./normalizar-codigo";
export type { CodigoNormalizado } from "./normalizar-codigo";
export {
  buscarProducto,
  registrarEscaneosBatch,
  resumenConteo,
  compararConteo,
  cerrarConteo,
  actualizarDatosContactoEmpresa,
  iniciarImportacion,
  previsualizarImportacion,
  confirmarImportacionLote,
  finalizarImportacion,
  TAMANO_LOTE_IMPORTACION,
  registrarEscaneoDesconocido,
  resolverDesconocido,
  subirFotoDesconocido,
} from "./rpc";
export type {
  ProductoEncontrado,
  EscaneoInput,
  ResultadoRegistrarEscaneos,
  ResumenConteo,
  ProductoValorInmovilizado,
  ProductividadOperario,
  ResumenConteoComparable,
  ResumenSucursalComparable,
  ResultadoComparativo,
  ResultadoCierreConteo,
  DatosContactoEmpresa,
  FilaImportacion,
  FilaClasificada,
  ResultadoPrevisualizacion,
  ResultadoConfirmarLote,
  ResultadoFinalizarImportacion,
  ResultadoEscaneoDesconocido,
  NuevoProductoDesdeIA,
} from "./rpc";
