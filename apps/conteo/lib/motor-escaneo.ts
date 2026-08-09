import { normalizarCodigo } from "@farmacia/db";
import { db, type LineaLocal } from "./db";

// Desacoplado de React a propósito: así se puede medir rendimiento con
// fake-indexeddb en Node (ver scripts/medir-rendimiento-escaneo.ts) sin
// levantar un navegador, y la UI (app/(app)/conteo/*) solo lo consume.

export type ResultadoEscaneo =
  | { tipo: "encontrado"; linea: LineaLocal }
  | { tipo: "no_encontrado"; codigoRaw: string; codigoNorm: string | null }
  | { tipo: "duplicado"; codigoRaw: string }
  | { tipo: "codigo_invalido"; codigoRaw: string };

const DEBOUNCE_MS = 400;

// Estado del debounce: a propósito a nivel de módulo, no por-conteo — la
// pantalla de conteo es de un producto/conteo a la vez, nunca hay dos
// sesiones de escaneo simultáneas en la misma pestaña.
let ultimoCodigoDebounce: string | null = null;
let ultimoTimestampDebounce = 0;

export function dispositivoActual(): string {
  if (typeof navigator === "undefined") return "desconocido";
  return navigator.userAgent.slice(0, 120);
}

export function generarUuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback para entornos de test sin Web Crypto completo.
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatearPresentacion(p: {
  concentracion: string | null;
  forma: string | null;
  contenido: number | null;
  unidad: string | null;
}): string | null {
  const partes = [
    p.forma,
    p.concentracion,
    p.contenido ? `${p.contenido} ${p.unidad ?? ""}`.trim() : null,
  ].filter((x): x is string => Boolean(x));
  return partes.length ? partes.join(" · ") : null;
}

export interface ProcesarEscaneoParams {
  conteoId: string;
  codigoRaw: string;
  /** Default 1. Usar un valor > 1 para "cantidad manual" (cajas repetidas). */
  delta?: number;
  /** Saltear el debounce de 400ms — para carga manual, no lecturas del lector. */
  saltarDebounce?: boolean;
}

/** Normaliza → matchea contra el catálogo local → escribe línea + cola de
 * sync, todo en una transacción Dexie. Sin ningún `await` a red en el
 * camino: el presupuesto de <100ms del spec es alcanzable porque esto es
 * 100% IndexedDB local. */
export async function procesarEscaneo(params: ProcesarEscaneoParams): Promise<ResultadoEscaneo> {
  const { conteoId, codigoRaw, delta = 1, saltarDebounce = false } = params;
  const ahora = Date.now();

  const { codigoNorm, lote, vencimiento } = normalizarCodigo(codigoRaw);

  if (!codigoNorm) {
    return { tipo: "codigo_invalido", codigoRaw };
  }

  if (
    !saltarDebounce &&
    codigoNorm === ultimoCodigoDebounce &&
    ahora - ultimoTimestampDebounce < DEBOUNCE_MS
  ) {
    return { tipo: "duplicado", codigoRaw };
  }
  ultimoCodigoDebounce = codigoNorm;
  ultimoTimestampDebounce = ahora;

  const producto = await db.catalogo.get(codigoNorm);

  if (!producto) {
    return { tipo: "no_encontrado", codigoRaw, codigoNorm };
  }

  const lineaId = `${conteoId}:${producto.productoId}`;

  const linea = await db.transaction("rw", db.lineas, db.colaEscaneos, async () => {
    const existente = await db.lineas.get(lineaId);
    const nuevaCantidad = (existente?.cantidad ?? 0) + delta;

    const nuevaLinea: LineaLocal = {
      id: lineaId,
      conteoId,
      productoId: producto.productoId,
      codigoNorm,
      nombre: producto.nombre,
      laboratorio: producto.laboratorio,
      presentacion: formatearPresentacion(producto),
      cantidad: nuevaCantidad,
      ultimoEscaneoAt: ahora,
    };
    await db.lineas.put(nuevaLinea);

    await db.colaEscaneos.put({
      clientUuid: generarUuid(),
      conteoId,
      lineaId,
      codigoRaw,
      codigoNorm,
      delta,
      lote,
      vencimiento,
      dispositivo: dispositivoActual(),
      createdAt: ahora,
      sincronizado: 0,
    });

    return nuevaLinea;
  });

  return { tipo: "encontrado", linea };
}

/** Deshace el último escaneo del conteo (global, no por producto — "el
 * último" tal cual pide el spec). Si todavía no se sincronizó, se borra
 * de la cola sin más. Si ya se sincronizó, se registra un evento
 * compensatorio (delta negativo) — nunca se edita/borra un escaneo ya
 * mandado al servidor, mismo principio de inmutabilidad que CONTEXTO.md
 * regla 5 exige del lado del servidor. */
export async function deshacerUltimoEscaneo(conteoId: string): Promise<boolean> {
  return db.transaction("rw", db.lineas, db.colaEscaneos, async () => {
    const todos = await db.colaEscaneos.where("conteoId").equals(conteoId).toArray();
    if (todos.length === 0) return false;

    const ultimo = todos.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const linea = await db.lineas.get(ultimo.lineaId);
    if (!linea) return false;

    if (ultimo.sincronizado === 0) {
      await db.colaEscaneos.delete(ultimo.clientUuid);
    } else {
      await db.colaEscaneos.put({
        ...ultimo,
        clientUuid: generarUuid(),
        delta: -ultimo.delta,
        sincronizado: 0,
        createdAt: Date.now(),
      });
    }

    await db.lineas.put({
      ...linea,
      cantidad: linea.cantidad - ultimo.delta,
      ultimoEscaneoAt: Date.now(),
    });

    return true;
  });
}

/** Edición manual de la lista en vivo: fija la cantidad de una línea a un
 * valor exacto, registrando la diferencia como un evento más (nunca
 * pisa el número directamente — regla 5). */
export async function establecerCantidad(lineaId: string, nuevaCantidad: number): Promise<void> {
  await db.transaction("rw", db.lineas, db.colaEscaneos, async () => {
    const linea = await db.lineas.get(lineaId);
    if (!linea) return;

    const delta = nuevaCantidad - linea.cantidad;
    if (delta === 0) return;

    // codigoRaw = el código real del producto (no un texto libre): el
    // servidor solo sabe crear/encontrar la línea normalizando un
    // código de barras de verdad — ver registrar_escaneos_batch.
    await db.colaEscaneos.put({
      clientUuid: generarUuid(),
      conteoId: linea.conteoId,
      lineaId,
      codigoRaw: linea.codigoNorm,
      codigoNorm: linea.codigoNorm,
      delta,
      lote: null,
      vencimiento: null,
      dispositivo: dispositivoActual(),
      createdAt: Date.now(),
      sincronizado: 0,
    });

    await db.lineas.put({ ...linea, cantidad: nuevaCantidad, ultimoEscaneoAt: Date.now() });
  });
}
