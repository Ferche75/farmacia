// Entry point seguro para Client Components. NO reexportar nada de acá
// que importe el paquete "server-only" (createServerClient,
// getPerfilActual) — eso rompe el build apenas un Client Component
// importa este barrel, aunque no use ese export puntual. Ver ./server.ts.
export { createClient as createBrowserClient } from "./supabase/client";
export type { Database, Rol, Json } from "./types/database.types";
export { normalizarCodigo } from "./normalizar-codigo";
export type { CodigoNormalizado } from "./normalizar-codigo";
// Vocabulario de presentación/concentración — una sola definición para
// apps/admin y apps/conteo (antes era un array copiado a mano en cada
// app, que se desincronizó). Ver ./campos-producto.ts.
export {
  UNIDADES_PRESENTACION,
  UNIDADES_CONCENTRACION,
  CAMPOS_POR_PRESENTACION,
  camposDePresentacion,
  esUnidadPersonalizada,
} from "./campos-producto";
export type { CamposPresentacion } from "./campos-producto";
export {
  buscarProducto,
  registrarEscaneosBatch,
  resumenConteo,
  compararConteo,
  cerrarConteo,
  actualizarDatosContactoEmpresa,
  actualizarConfigOperativaEmpresa,
  actualizarCamposPersonalizadosEmpresa,
  VENCIMIENTO_SEMAFORO_DEFAULT,
  iniciarImportacion,
  previsualizarImportacion,
  confirmarImportacionLote,
  finalizarImportacion,
  TAMANO_LOTE_IMPORTACION,
  registrarEscaneoDesconocido,
  resolverDesconocido,
  crearProductoYContar,
  datosCompletitudCatalogo,
  completarDatosProducto,
  subirFotoDesconocido,
  subirFotoAltaManual,
  generarCodigoInvitacionPdv,
  ajustarStock,
  reportarEstadoDispositivo,
  eliminarSucursal,
  eliminarBodega,
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
  VencimientoSemaforo,
  ConfigOperativaEmpresa,
  CampoPersonalizado,
  FilaImportacion,
  FilaClasificada,
  ResultadoPrevisualizacion,
  FilaRechazadaImportacion,
  ResultadoConfirmarLote,
  ResultadoFinalizarImportacion,
  ResultadoEscaneoDesconocido,
  NuevoProductoDesdeIA,
  NuevoProductoManual,
  DatosCompletablesProducto,
  OverlayEmpresaProducto,
  DatosCompletitudCatalogo,
  CodigoInvitacionPdv,
  ResultadoAjusteStock,
  ResultadoEliminarSucursal,
  ResultadoEliminarBodega,
} from "./rpc";
