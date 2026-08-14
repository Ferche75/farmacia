import Dexie, { type EntityTable } from "dexie";

// IndexedDB local. CONTEXTO.md regla 1: el catálogo NUNCA incluye
// costo/precio acá — ni siquiera existe la columna, así que no hay riesgo
// de que se filtre por accidente.

export interface ProductoLocal {
  codigoNorm: string; // primary key
  productoId: string;
  nombre: string;
  laboratorio: string | null;
  concentracion: string | null;
  forma: string | null;
  contenido: number | null;
  unidad: string | null;
  /** Cuántas unidades vale ESTE código en particular (ej. código de caja
   * de 10 vs. código de la unidad suelta, que vale 1) — ver
   * codigos_barra.unidades_por_codigo. Default 1. */
  unidadesPorCodigo: number;
}

export interface LineaLocal {
  id: string; // `${conteoId}:${productoId}`
  conteoId: string;
  productoId: string;
  codigoNorm: string; // código representativo del producto — lo necesita
  // establecerCantidad() para poder mandar un ajuste manual al servidor
  // sin un escaneo real de por medio (ver lib/motor-escaneo.ts).
  nombre: string;
  laboratorio: string | null;
  presentacion: string | null;
  cantidad: number;
  ultimoEscaneoAt: number; // epoch ms, para ordenar "por último escaneo"
}

export interface EscaneoCola {
  clientUuid: string; // primary key
  conteoId: string;
  lineaId: string;
  codigoRaw: string;
  codigoNorm: string;
  delta: number;
  lote: string | null;
  vencimiento: string | null;
  dispositivo: string;
  createdAt: number; // epoch ms
  sincronizado: 0 | 1; // Dexie no indexa booleanos de forma útil; 0/1
  /** Cuántas veces se intentó mandar al servidor y falló (no cuenta los
   * intentos que no se hicieron por estar offline). Sin esto, un escaneo
   * que el servidor rechaza en loop (ej. conteo cerrado, error de
   * validación) se ve exactamente igual que uno que solo está esperando
   * conexión — "N sin sincronizar" para siempre, sin ninguna pista de que
   * en realidad nunca va a entrar solo. */
  intentos: number;
  ultimoError: string | null;
}

export interface MetaConteo {
  id: "actual";
  conteoId: string;
  sucursalId: string;
  nombre: string;
  catalogoListo: boolean;
  catalogoDescargadoAt: number | null;
  catalogoTotal: number;
}

// ═══════════════════════════════════════════════════════════════
// Fase 4: desconocidos
// ═══════════════════════════════════════════════════════════════

/** Metadata de desconocidos YA EXISTENTES en el servidor (bajada al
 * arrancar el conteo, igual que el catálogo) + los que este mismo
 * dispositivo crea en la sesión. `fotoBlob` solo está presente cuando
 * ESTE dispositivo sacó/cacheó la foto — si el desconocido lo creó otro
 * dispositivo, se conoce el código pero no la miniatura sin conexión
 * (ver docs/decisiones.md, límite documentado a propósito). */
export interface DesconocidoLocal {
  codigoNorm: string; // primary key
  desconocidoId: string | null; // null hasta que la primera escritura sincroniza
  fotoBlob: Blob | null;
}

export interface LineaDesconocidoLocal {
  id: string; // `${conteoId}:${codigoNorm}`
  conteoId: string;
  codigoNorm: string;
  cantidad: number;
  ultimoEscaneoAt: number;
}

export interface EscaneoDesconocidoCola {
  clientUuid: string; // primary key
  conteoId: string;
  codigoRaw: string;
  codigoNorm: string;
  /** Blob a subir a Storage recién al sincronizar — null si esta entrada
   * es un re-escaneo de un código que ya se conocía (no hace falta
   * volver a subir nada, solo sumar 1). */
  fotoBlob: Blob | null;
  dispositivo: string;
  createdAt: number;
  sincronizado: 0 | 1;
  intentos: number;
  ultimoError: string | null;
}

export const db = new Dexie("farmacia-conteo") as Dexie & {
  catalogo: EntityTable<ProductoLocal, "codigoNorm">;
  lineas: EntityTable<LineaLocal, "id">;
  colaEscaneos: EntityTable<EscaneoCola, "clientUuid">;
  meta: EntityTable<MetaConteo, "id">;
  desconocidos: EntityTable<DesconocidoLocal, "codigoNorm">;
  lineasDesconocidos: EntityTable<LineaDesconocidoLocal, "id">;
  colaDesconocidos: EntityTable<EscaneoDesconocidoCola, "clientUuid">;
};

db.version(1).stores({
  catalogo: "codigoNorm, productoId",
  lineas: "id, conteoId, ultimoEscaneoAt",
  colaEscaneos: "clientUuid, conteoId, sincronizado, createdAt",
  meta: "id",
});

db.version(2).stores({
  desconocidos: "codigoNorm",
  lineasDesconocidos: "id, conteoId, ultimoEscaneoAt",
  colaDesconocidos: "clientUuid, conteoId, sincronizado, createdAt",
});
