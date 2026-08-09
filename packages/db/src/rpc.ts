// Wrappers tipados de las funciones RPC de Supabase (sección 4 del spec,
// implementadas en supabase/migrations/20260806000002_funciones_rpc.sql).
//
// normalizar_codigo() a propósito NO tiene wrapper acá: es un building
// block server-side usado por buscar_producto/registrar_escaneos_batch,
// no algo para llamar por red desde la app. apps/conteo necesita la MISMA
// lógica de normalización pero corriendo 100% local/offline (CONTEXTO.md
// regla 1) — eso es un port a TS que se hace en Fase 3, no una llamada a
// este RPC.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "./types/database.types";

export interface ProductoEncontrado {
  id: string;
  nombre: string;
  laboratorio_id: string | null;
  principio_activo: string | null;
  concentracion: string | null;
  forma: string | null;
  contenido: number | null;
  unidad: string | null;
  requiere_receta: boolean;
  controlado: boolean;
  codigo_norm: string;
  // Solo presentes si el rol de quien llama no es operario (ver
  // buscar_producto en la migración — el filtrado es server-side, no
  // algo que el cliente deba confiar en ocultar).
  costo?: number;
  precio?: number;
  stock_minimo?: number | null;
}

export interface EscaneoInput {
  clientUuid: string;
  codigoRaw: string;
  dispositivo?: string;
  /** Default 1 si no se manda. */
  delta?: number;
}

export interface ResultadoRegistrarEscaneos {
  procesados: number;
  duplicados: number;
  no_encontrados: { codigo_raw: string; client_uuid: string }[];
}

export interface ProductoValorInmovilizado {
  producto_id: string;
  nombre: string;
  cantidad: number;
  valor_costo: number;
}

export interface ProductividadOperario {
  usuario_id: string;
  escaneos: number;
  escaneos_por_hora: number;
}

// Fase 6 extendió esta respuesta (CREATE OR REPLACE de la misma función
// de Fase 1) — ver supabase/migrations/20260806000007_cierre_resumen.sql
// para por qué el desglose de desconocidos es a nivel empresa y no
// filtrado a este conteo puntual.
export interface ResumenConteo {
  conteo_id: string;
  estado: string;
  unidades_totales: number;
  skus_distintos: number;
  valor_costo: number;
  valor_precio: number;
  margen_teorico: number;
  skus_catalogo_no_encontrados: number;
  top_20_valor_inmovilizado: ProductoValorInmovilizado[];
  desconocidos_pendientes_este_conteo: number;
  /** Precisos, no aproximados — desde que existe conteo_deteccion_id
   * (ver supabase/migrations/20260806000008_desconocidos_conteo_origen.sql).
   * Desconocidos detectados ANTES de esa migración quedan fuera de estos
   * 3 campos (conteo_deteccion_id null), pero sí siguen contando en los
   * campos "_empresa_" de abajo. */
  desconocidos_detectados_este_conteo: number;
  desconocidos_resueltos_ia_este_conteo: number;
  desconocidos_resueltos_manual_este_conteo: number;
  desconocidos_empresa_total: number;
  desconocidos_empresa_resueltos_ia: number;
  desconocidos_empresa_resueltos_manual: number;
  desconocidos_empresa_pendientes: number;
  productividad_por_operario: ProductividadOperario[];
  tiene_vencimientos: boolean;
  vencimientos_menos_90_dias: number;
  vencimientos_menos_180_dias: number;
}

export interface ResumenConteoComparable {
  conteo_id: string;
  nombre: string;
  iniciado_at: string;
  unidades_totales: number;
  valor_precio: number;
}

export interface ResumenSucursalComparable extends ResumenConteoComparable {
  sucursal_id: string;
  sucursal_nombre: string;
  conteo_nombre: string;
}

export interface ResultadoComparativo {
  anterior_misma_sucursal: ResumenConteoComparable | null;
  otras_sucursales: ResumenSucursalComparable[];
}

export interface ResultadoCierreConteo {
  id: string;
  desconocidos_pendientes: number;
}

export async function buscarProducto(
  supabase: SupabaseClient<Database>,
  empresaId: string,
  codigo: string
): Promise<ProductoEncontrado | null> {
  const { data, error } = await supabase.rpc("buscar_producto", {
    p_empresa: empresaId,
    p_codigo: codigo,
  });

  if (error) throw error;
  return (data as ProductoEncontrado | null) ?? null;
}

export async function registrarEscaneosBatch(
  supabase: SupabaseClient<Database>,
  conteoId: string,
  escaneos: EscaneoInput[]
): Promise<ResultadoRegistrarEscaneos> {
  const payload: Json = escaneos.map((e) => ({
    client_uuid: e.clientUuid,
    codigo_raw: e.codigoRaw,
    dispositivo: e.dispositivo ?? null,
    delta: e.delta ?? 1,
  }));

  const { data, error } = await supabase.rpc("registrar_escaneos_batch", {
    p_conteo: conteoId,
    p_escaneos: payload,
  });

  if (error) throw error;
  return data as unknown as ResultadoRegistrarEscaneos;
}

export async function resumenConteo(
  supabase: SupabaseClient<Database>,
  conteoId: string
): Promise<ResumenConteo> {
  const { data, error } = await supabase.rpc("resumen_conteo", {
    p_conteo: conteoId,
  });

  if (error) throw error;
  return data as unknown as ResumenConteo;
}

export async function compararConteo(
  supabase: SupabaseClient<Database>,
  conteoId: string
): Promise<ResultadoComparativo> {
  const { data, error } = await supabase.rpc("comparar_conteo", {
    p_conteo_id: conteoId,
  });

  if (error) throw error;
  return data as unknown as ResultadoComparativo;
}

/** Valida (cuenta desconocidos pendientes), cierra y deja el conteo de
 * solo lectura — registrar_escaneos_batch y registrar_escaneo_desconocido
 * ya rechazan cualquier escritura sobre un conteo con estado <> 'abierto'. */
export async function cerrarConteo(
  supabase: SupabaseClient<Database>,
  conteoId: string
): Promise<ResultadoCierreConteo> {
  const { data, error } = await supabase.rpc("cerrar_conteo", {
    p_conteo_id: conteoId,
  });

  if (error) throw error;
  return data as unknown as ResultadoCierreConteo;
}

// ═══════════════════════════════════════════════════════════════
// Importación de catálogo (Fase 2)
// ═══════════════════════════════════════════════════════════════

/** Tamaño de lote fijado por el spec — "procesá en lotes de 500 filas". */
export const TAMANO_LOTE_IMPORTACION = 500;

/** Una fila ya mapeada a los campos del sistema (después del mapeador
 * visual de columnas), lista para mandar a previsualizar/confirmar. */
export interface FilaImportacion {
  codigoBarra: string;
  nombre?: string;
  concentracion?: string;
  contenido?: string | number;
  unidad?: string;
  forma?: string;
  costo?: string | number;
  precio?: string | number;
}

export interface FilaClasificada {
  fila_index: number;
  codigo_barra: string;
  accion: "crear" | "actualizar" | "rechazar";
  motivo: string | null;
}

export interface ResultadoPrevisualizacion {
  total: number;
  crear: number;
  actualizar: number;
  rechazar: number;
  filas: FilaClasificada[];
}

export interface ResultadoConfirmarLote {
  creados: number;
  actualizados: number;
  rechazados: number;
}

export interface ResultadoFinalizarImportacion {
  id: string;
  estado: string;
  filas_ok: number;
  filas_error: number;
}

function filaImportacionAPayload(f: FilaImportacion): Json {
  return {
    codigo_barra: f.codigoBarra,
    nombre: f.nombre ?? null,
    concentracion: f.concentracion ?? null,
    contenido: f.contenido ?? null,
    unidad: f.unidad ?? null,
    forma: f.forma ?? null,
    costo: f.costo ?? null,
    precio: f.precio ?? null,
  };
}

export async function iniciarImportacion(
  supabase: SupabaseClient<Database>,
  archivo: string,
  mapeo: Json
): Promise<string> {
  const { data, error } = await supabase.rpc("iniciar_importacion", {
    p_archivo: archivo,
    p_mapeo: mapeo,
  });

  if (error) throw error;
  return data as string;
}

/** Clasifica TODAS las filas (crear/actualizar/rechazar) sin escribir
 * nada — para la vista previa + el resumen antes de confirmar. */
export async function previsualizarImportacion(
  supabase: SupabaseClient<Database>,
  laboratorio: string,
  filas: FilaImportacion[]
): Promise<ResultadoPrevisualizacion> {
  const { data, error } = await supabase.rpc("previsualizar_importacion", {
    p_laboratorio: laboratorio,
    p_filas: filas.map(filaImportacionAPayload) as Json,
  });

  if (error) throw error;
  return data as unknown as ResultadoPrevisualizacion;
}

/** Escribe de verdad. Llamar una vez por lote de TAMANO_LOTE_IMPORTACION
 * filas — quien llama es responsable de trocear el archivo completo. */
export async function confirmarImportacionLote(
  supabase: SupabaseClient<Database>,
  importacionId: string,
  laboratorio: string,
  filas: FilaImportacion[]
): Promise<ResultadoConfirmarLote> {
  const { data, error } = await supabase.rpc("confirmar_importacion_lote", {
    p_importacion_id: importacionId,
    p_laboratorio: laboratorio,
    p_filas: filas.map(filaImportacionAPayload) as Json,
  });

  if (error) throw error;
  return data as unknown as ResultadoConfirmarLote;
}

export async function finalizarImportacion(
  supabase: SupabaseClient<Database>,
  importacionId: string
): Promise<ResultadoFinalizarImportacion> {
  const { data, error } = await supabase.rpc("finalizar_importacion", {
    p_importacion_id: importacionId,
  });

  if (error) throw error;
  return data as unknown as ResultadoFinalizarImportacion;
}

// ═══════════════════════════════════════════════════════════════
// Desconocidos (Fase 4)
// ═══════════════════════════════════════════════════════════════

export interface ResultadoEscaneoDesconocido {
  desconocido_id: string;
  es_nuevo: boolean;
  linea_id: string;
  duplicado?: boolean;
}

export async function registrarEscaneoDesconocido(
  supabase: SupabaseClient<Database>,
  params: {
    conteoId: string;
    codigoRaw: string;
    clientUuid: string;
    fotoPath?: string | null;
    dispositivo?: string;
  }
): Promise<ResultadoEscaneoDesconocido> {
  const { data, error } = await supabase.rpc("registrar_escaneo_desconocido", {
    p_conteo: params.conteoId,
    p_codigo_raw: params.codigoRaw,
    p_client_uuid: params.clientUuid,
    p_foto_path: params.fotoPath ?? null,
    p_dispositivo: params.dispositivo ?? null,
  });

  if (error) throw error;
  return data as unknown as ResultadoEscaneoDesconocido;
}

export interface NuevoProductoDesdeIA {
  nombre: string;
  laboratorio_id?: string | null;
  principio_activo?: string | null;
  concentracion?: string | null;
  forma?: string | null;
  contenido?: number | null;
  unidad?: string | null;
  origen?: "manual" | "ia";
}

/** Uno de los dos: vincular a un producto que ya existe, o crear uno
 * nuevo (lo que usan los botones Aceptar/Corregir de Fase 4 — con la
 * sugerencia de la IA tal cual o editada). */
export async function resolverDesconocido(
  supabase: SupabaseClient<Database>,
  desconocidoId: string,
  destino: { productoId: string } | { nuevoProducto: NuevoProductoDesdeIA }
): Promise<{ productoId: string }> {
  const { data, error } = await supabase.rpc("resolver_desconocido", {
    p_desconocido_id: desconocidoId,
    p_producto_id: "productoId" in destino ? destino.productoId : null,
    p_nuevo_producto: "nuevoProducto" in destino ? (destino.nuevoProducto as unknown as Json) : null,
  });

  if (error) throw error;
  return { productoId: (data as { producto_id: string }).producto_id };
}

/** Ruta del archivo: empresa_id/conteo_id/archivo.jpg (spec Fase 4) —
 * las policies de Storage dependen de este formato exacto, no cambiarlo
 * sin actualizar supabase/migrations/20260806000006_desconocidos_storage.sql. */
export async function subirFotoDesconocido(
  supabase: SupabaseClient<Database>,
  params: { empresaId: string; conteoId: string; codigoNorm: string; blob: Blob }
): Promise<string> {
  const nombreArchivo = `${params.codigoNorm}-${Date.now()}.jpg`;
  const path = `${params.empresaId}/${params.conteoId}/${nombreArchivo}`;

  const { error } = await supabase.storage.from("desconocidos").upload(path, params.blob, {
    contentType: "image/jpeg",
    upsert: false,
  });

  if (error) throw error;
  return path;
}
