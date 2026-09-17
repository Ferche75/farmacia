import Dexie, { type EntityTable } from "dexie";

// IndexedDB local. El catálogo NUNCA incluye `costo` (el precio de COMPRA
// al proveedor): ni siquiera existe el campo en ProductoLocal, así que no
// hay riesgo de que se filtre por accidente. `precio` (el de VENTA) sí
// está, desde
// supabase/migrations/20260923000000_precio_obligatorio_y_visible_en_conteo.sql
// — decisión explícita del usuario, ver lib/campos-obligatorios.ts.

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

  // ── Campos que solo existen para el chequeo de completitud ──
  // (ver lib/campos-obligatorios.ts). Todos OPCIONALES a propósito, mismo
  // motivo que unidadesSueltas/esSuelto: las filas que quedaron en
  // IndexedDB de una versión anterior no los tienen, y no hace falta
  // migrar el store porque ninguno es un índice — la próxima descarga
  // completa del catálogo (que pasa al empezar cualquier conteo nuevo) los
  // rellena sola.
  //
  // NO HAY, NI PUEDE HABER, `costo` acá. Los campos "de empresa" de abajo
  // son los ÚNICOS 5 de productos_empresa que bajan al dispositivo, y
  // llegan por un RPC que selecciona esas 5 columnas a mano
  // (datos_completitud_catalogo_conteo) — el costo no está entre ellas y
  // la policy de la tabla sigue tapando la fila entera para un operario.

  /** De `productos` (global). */
  principioActivo?: string | null;
  categoria?: string | null;
  marca?: string | null;
  accionTerapeutica?: string | null;
  especialidad?: string | null;
  fabricante?: string | null;

  /** De `productos_empresa` (de ESTA empresa). */
  codigoProveedor?: string | null;
  distribuidor?: string | null;
  loteCatalogo?: string | null;
  loteCatalogo2?: string | null;
  /** Precio de VENTA al público de ESTA empresa. El único campo de precio
   * que baja al dispositivo, y baja a propósito desde 20260923000000: el
   * usuario pidió que los operarios lo vean y lo puedan cargar. `costo`
   * sigue sin bajar. Numérico, a diferencia de los otros cuatro de este
   * grupo. */
  precio?: number | null;

  /** Derivado, calculado al sincronizar el catálogo (descarga inicial,
   * realtime y después de completar el popup) — NO al leer. El camino
   * caliente del escaneo tiene un presupuesto de <100ms y lee esto como
   * un booleano y nada más; recalcularlo por escaneo sería recorrer la
   * lista de campos obligatorios en cada lectura del lector.
   *
   * `undefined` en filas viejas: tratarlo como `true` (no frenar un
   * escaneo por un dato que este dispositivo todavía no bajó). */
  datosCompletos?: boolean;
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
  /** Envases cerrados contados (1 escaneo = 1 envase). */
  cantidad: number;
  /** "Picado": unidades individuales sueltas de una caja ya abierta, que
   * no tienen código de barras que escanear y se cargan con el botón
   * PICADO (ver sumarUnidadesSueltas en lib/motor-escaneo.ts). Espejo
   * local de conteo_lineas.unidades_sueltas. NO se suma a `cantidad`: son
   * unidades distintas (comprimidos vs. cajas).
   *
   * Opcional a propósito: las líneas que ya estaban en IndexedDB antes de
   * esta versión no tienen el campo (no hace falta migrar el store, no es
   * un índice) y las que crea motor-desconocidos nacen sin picado. Leer
   * siempre con `?? 0`. */
  unidadesSueltas?: number;
  ultimoEscaneoAt: number; // epoch ms, para ordenar "por último escaneo"
}

export interface EscaneoCola {
  clientUuid: string; // primary key
  conteoId: string;
  lineaId: string;
  codigoRaw: string;
  codigoNorm: string;
  delta: number;
  /** El delta de esta entrada son unidades SUELTAS (picado), no envases —
   * viaja como `es_suelto` a registrar_escaneos_batch. Opcional: las
   * entradas encoladas por una versión anterior no lo tienen y valen
   * false, que es lo que siempre significaron. */
  esSuelto?: boolean;
  /** Solo presente en un evento COMPENSATORIO (creado por deshacerUltimoEscaneo
   * sobre un evento ya sincronizado): el clientUuid del evento que este
   * anula. Sirve para que un segundo "Deshacer" no vuelva a elegir el
   * compensatorio recién creado como "lo último" — sin esto, dos clicks
   * seguidos (antes de que el primer compensatorio sincronice) se anulan
   * entre sí en vez de seguir yendo hacia atrás. Ausente/null en un evento
   * normal (escaneo, picado, edición manual). */
  compensaClientUuid?: string | null;
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
  /** Los campos que ESTA empresa declaró obligatorios (Configuración →
   * "Campos obligatorios al importar"), ya filtrados por el servidor al
   * subconjunto que se puede completar desde acá — sin `costo`, nunca
   * (`precio` sí entra desde 20260923000000). Se baja una vez junto con el
   * catálogo.
   *
   * Opcional: un meta escrito por una versión anterior no lo tiene, y en
   * ese caso no hay nada obligatorio que chequear (mismo efecto que una
   * lista vacía). Leer siempre con `?? []`. */
  camposRequeridosImportacion?: string[];
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
