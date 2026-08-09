import {
  createBrowserClient,
  registrarEscaneosBatch,
  registrarEscaneoDesconocido,
  subirFotoDesconocido,
} from "@farmacia/db";
import { db } from "./db";

const INTERVALO_MS = 10_000;
const TAMANO_LOTE = 200;

let intervalId: ReturnType<typeof setInterval> | null = null;
let sincronizando = false;

export interface ResultadoSync {
  enviados: number;
  error?: string;
}

/** Manda TODO lo pendiente del conteo, en lotes, vía
 * registrar_escaneos_batch (idempotente por client_uuid — un reintento
 * después de un corte de red no duplica nada, ver Fase 1). Los
 * "duplicados" que devuelve el RPC también se marcan como sincronizados
 * acá: significa que el servidor ya los tenía, no hay que reintentarlos. */
export async function sincronizarPendientes(conteoId: string): Promise<ResultadoSync> {
  if (sincronizando) return { enviados: 0 };
  if (typeof navigator !== "undefined" && !navigator.onLine) return { enviados: 0 };

  sincronizando = true;
  try {
    const pendientes = await db.colaEscaneos
      .where("conteoId")
      .equals(conteoId)
      .filter((e) => e.sincronizado === 0)
      .toArray();

    if (pendientes.length === 0) return { enviados: 0 };

    const supabase = createBrowserClient();
    let enviados = 0;

    for (let i = 0; i < pendientes.length; i += TAMANO_LOTE) {
      const lote = pendientes.slice(i, i + TAMANO_LOTE);

      const resultado = await registrarEscaneosBatch(
        supabase,
        conteoId,
        lote.map((e) => ({
          clientUuid: e.clientUuid,
          codigoRaw: e.codigoRaw,
          dispositivo: e.dispositivo,
          delta: e.delta,
        }))
      );

      await db.colaEscaneos.bulkUpdate(
        lote.map((e) => ({ key: e.clientUuid, changes: { sincronizado: 1 as const } }))
      );

      enviados += resultado.procesados;
    }

    return { enviados };
  } catch (e) {
    return { enviados: 0, error: e instanceof Error ? e.message : "Error de sincronización" };
  } finally {
    sincronizando = false;
  }
}

/** Uno por uno (no en lote): cada entrada puede necesitar subir una foto
 * antes de llamar al RPC, así que agruparlas no ahorra nada acá. Si
 * falla una (por ejemplo, se cortó la red a mitad de la subida), queda
 * pendiente para el próximo intento — no aborta las demás. */
export async function sincronizarDesconocidosPendientes(
  empresaId: string,
  conteoId: string
): Promise<ResultadoSync> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return { enviados: 0 };

  const pendientes = await db.colaDesconocidos
    .where("conteoId")
    .equals(conteoId)
    .filter((e) => e.sincronizado === 0)
    .toArray();

  if (pendientes.length === 0) return { enviados: 0 };

  const supabase = createBrowserClient();
  let enviados = 0;

  for (const item of pendientes) {
    try {
      let fotoPath: string | null = null;
      if (item.fotoBlob) {
        fotoPath = await subirFotoDesconocido(supabase, {
          empresaId,
          conteoId,
          codigoNorm: item.codigoNorm,
          blob: item.fotoBlob,
        });
      }

      const resultado = await registrarEscaneoDesconocido(supabase, {
        conteoId,
        codigoRaw: item.codigoRaw,
        clientUuid: item.clientUuid,
        fotoPath,
        dispositivo: item.dispositivo,
      });

      await db.colaDesconocidos.update(item.clientUuid, { sincronizado: 1 });
      enviados++;

      if (!resultado.desconocido_id) continue;

      const local = await db.desconocidos.get(item.codigoNorm);
      if (local && local.desconocidoId === null) {
        await db.desconocidos.update(item.codigoNorm, { desconocidoId: resultado.desconocido_id });
      }

      // Solo se dispara la IA la primera vez que se crea el desconocido
      // (no en cada re-escaneo) — fire-and-forget, no bloquea el sync.
      if (resultado.es_nuevo) {
        fetch("/api/desconocidos/disparar-ia", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ desconocidoId: resultado.desconocido_id }),
        }).catch(() => {
          // Si falla, el desconocido queda en pendiente_ia — se resuelve
          // a mano en la bandeja de revisión (Fase 5). No es un error
          // que deba frenar la sincronización del conteo.
        });
      }
    } catch (e) {
      console.error("Error sincronizando desconocido", item.clientUuid, e);
      // sigue con el resto de la cola — un fallo puntual no bloquea a
      // los demás.
    }
  }

  return { enviados };
}

/** Arranca el timer de 10s + el listener de reconexión, para escaneos
 * normales y desconocidos juntos. Devuelve una función para desmontar
 * todo (llamar desde el cleanup de un useEffect). */
export function iniciarSyncAutomatico(
  empresaId: string,
  conteoId: string,
  onResultado?: (r: ResultadoSync) => void
): () => void {
  detenerSyncAutomatico();

  const ejecutar = async () => {
    const r1 = await sincronizarPendientes(conteoId);
    const r2 = await sincronizarDesconocidosPendientes(empresaId, conteoId);
    onResultado?.({
      enviados: r1.enviados + r2.enviados,
      error: r1.error ?? r2.error,
    });
  };

  intervalId = setInterval(ejecutar, INTERVALO_MS);
  window.addEventListener("online", ejecutar);

  return () => {
    detenerSyncAutomatico();
    window.removeEventListener("online", ejecutar);
  };
}

export function detenerSyncAutomatico() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export async function contarPendientes(conteoId: string): Promise<number> {
  const normales = await db.colaEscaneos
    .where("conteoId")
    .equals(conteoId)
    .filter((e) => e.sincronizado === 0)
    .count();
  const desconocidos = await db.colaDesconocidos
    .where("conteoId")
    .equals(conteoId)
    .filter((e) => e.sincronizado === 0)
    .count();
  return normales + desconocidos;
}
