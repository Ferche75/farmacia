import { normalizarCodigo } from "@farmacia/db";
import { db, type LineaLocal } from "./db";

// Desacoplado de React a propósito: así se puede medir rendimiento con
// fake-indexeddb en Node (ver scripts/medir-rendimiento-escaneo.ts) sin
// levantar un navegador, y la UI (app/(app)/conteo/*) solo lo consume.

export type ResultadoEscaneo =
  | { tipo: "encontrado"; linea: LineaLocal; unidadesPorCodigo: number }
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

// Dígito verificador EAN-13 estándar: posiciones impares (1ª, 3ª...) ×1,
// pares ×3, contando desde la izquierda sobre los primeros 12 dígitos.
function digitoVerificadorEan13(doceDigitos: string): number {
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    suma += Number(doceDigitos[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (suma % 10)) % 10;
}

// Código para productos sin código de barras propio ("Producto sin código
// de barras" en pantalla-conteo.tsx). Prefijo 20-29: GS1 lo reserva para
// uso interno/en tienda, así que nunca coincide con el código real de
// fábrica de ningún producto — es seguro asignarlo acá sin consultar al
// servidor. 12 dígitos (prefijo + timestamp + random) + 1 verificador = 13,
// mismo largo que un EAN-13 real, por si se termina imprimiendo en una
// etiqueta.
export function generarCodigoInterno(): string {
  const cuerpo = "20" + Date.now().toString().slice(-9) + Math.floor(Math.random() * 10);
  return cuerpo + digitoVerificadorEan13(cuerpo);
}

export function formatearPresentacion(p: {
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
  // Un código de caja/blister vale más de 1 unidad (unidades_por_codigo) —
  // el delta que se aplica y el que se sincroniza al servidor ya tiene que
  // ser la cantidad REAL de unidades, no la cantidad de escaneos: el
  // servidor solo suma escaneos.delta tal cual (recalcular_cantidad_linea),
  // nunca lo multiplica.
  const unidadesPorCodigo = producto.unidadesPorCodigo || 1;
  const deltaReal = delta * unidadesPorCodigo;

  const linea = await db.transaction("rw", db.lineas, db.colaEscaneos, async () => {
    const existente = await db.lineas.get(lineaId);
    const nuevaCantidad = (existente?.cantidad ?? 0) + deltaReal;

    const nuevaLinea: LineaLocal = {
      id: lineaId,
      conteoId,
      productoId: producto.productoId,
      codigoNorm,
      nombre: producto.nombre,
      laboratorio: producto.laboratorio,
      presentacion: formatearPresentacion(producto),
      cantidad: nuevaCantidad,
      // put() reemplaza la fila entera, así que el picado ya cargado hay
      // que arrastrarlo explícitamente — si no, el próximo escaneo normal
      // del mismo producto lo borraría de la vista (el servidor lo
      // seguiría teniendo, que es lo peor de los dos mundos).
      unidadesSueltas: existente?.unidadesSueltas ?? 0,
      ultimoEscaneoAt: ahora,
    };
    await db.lineas.put(nuevaLinea);

    await db.colaEscaneos.put({
      clientUuid: generarUuid(),
      conteoId,
      lineaId,
      codigoRaw,
      codigoNorm,
      delta: deltaReal,
      lote,
      vencimiento,
      dispositivo: dispositivoActual(),
      createdAt: ahora,
      sincronizado: 0,
      intentos: 0,
      ultimoError: null,
    });

    return nuevaLinea;
  });

  return { tipo: "encontrado", linea, unidadesPorCodigo };
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

    // El evento deshecho puede ser un picado: en ese caso lo que hay que
    // descontar es el contador de sueltas, no el de envases — el evento
    // compensatorio de arriba conserva esSuelto, así que el servidor va a
    // restarlo de unidades_sueltas y las dos puntas tienen que coincidir.
    await db.lineas.put(
      ultimo.esSuelto
        ? {
            ...linea,
            unidadesSueltas: (linea.unidadesSueltas ?? 0) - ultimo.delta,
            ultimoEscaneoAt: Date.now(),
          }
        : {
            ...linea,
            cantidad: linea.cantidad - ultimo.delta,
            ultimoEscaneoAt: Date.now(),
          }
    );

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
      intentos: 0,
      ultimoError: null,
    });

    await db.lineas.put({ ...linea, cantidad: nuevaCantidad, ultimoEscaneoAt: Date.now() });
  });
}

/** "PICADO": suma unidades SUELTAS a una línea ya contada — los
 * comprimidos/ml que quedaron flojos de una caja abierta y que, al no
 * tener código de barras propio, no hay forma de escanear.
 *
 * Es ADITIVA, no un "fijar el total": el operario toca PICADO y tipea lo
 * que está viendo en el cajón en ese momento; si vuelve a tocarlo, suma
 * otra vez. Por eso no calcula ningún delta compensatorio como
 * establecerCantidad — la cantidad YA es el delta.
 *
 * El evento se marca esSuelto: el servidor lo suma a
 * conteo_lineas.unidades_sueltas y no a `cantidad` (que está en envases),
 * vía el mismo trigger de siempre. Camino idéntico al de cualquier
 * escaneo: cola Dexie local → motor-sync → registrar_escaneos_batch, así
 * que funciona sin conexión igual que todo lo demás. */
export async function sumarUnidadesSueltas(lineaId: string, cantidad: number): Promise<void> {
  if (!Number.isFinite(cantidad) || cantidad === 0) return;

  await db.transaction("rw", db.lineas, db.colaEscaneos, async () => {
    const linea = await db.lineas.get(lineaId);
    if (!linea) return;

    // codigoRaw = el código real del producto, igual que en
    // establecerCantidad: el servidor solo sabe encontrar/crear la línea
    // normalizando un código de barras de verdad (registrar_escaneos_batch).
    // El código es el de la CAJA; lo que dice "esto son sueltas, no una
    // caja más" es esSuelto, no el código.
    await db.colaEscaneos.put({
      clientUuid: generarUuid(),
      conteoId: linea.conteoId,
      lineaId,
      codigoRaw: linea.codigoNorm,
      codigoNorm: linea.codigoNorm,
      delta: cantidad,
      esSuelto: true,
      // Sin lote/vencimiento a propósito: un picado son unidades flojas
      // sin fecha propia, y cerrar_conteo solo arma `lotes` con los
      // escaneos que SÍ traen vencimiento.
      lote: null,
      vencimiento: null,
      dispositivo: dispositivoActual(),
      createdAt: Date.now(),
      sincronizado: 0,
      intentos: 0,
      ultimoError: null,
    });

    await db.lineas.put({
      ...linea,
      unidadesSueltas: (linea.unidadesSueltas ?? 0) + cantidad,
      ultimoEscaneoAt: Date.now(),
    });
  });
}
