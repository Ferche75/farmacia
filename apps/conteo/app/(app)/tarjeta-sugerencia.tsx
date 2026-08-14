"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient, resolverDesconocido, type Database } from "@farmacia/db";
import { migrarDesconocidoAProductoLocal } from "@/lib/motor-desconocidos";

type FilaDesconocido = Database["public"]["Tables"]["desconocidos"]["Row"];

interface RespuestaIA {
  reconocido: boolean;
  nombre: string;
  laboratorio: string;
  concentracion: string;
  contenido: number;
  unidad: string;
  confianza: number;
}

interface Sugerencia {
  id: string;
  codigoNorm: string;
  estado: string;
  iaRespuesta: RespuestaIA | null;
}

interface FormEdicion {
  nombre: string;
  laboratorio: string;
  concentracionValor: string;
  concentracionUnidad: string;
  contenido: string;
  unidad: string;
}

const inputClase =
  "w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand";
const selectClase = inputClase;

// Mismo vocabulario que el prompt de Gemini en n8n/flujo-desconocidos-ia.json
// (sección "unidad: uno de comprimidos|capsulas|ml|g|unidades|sobres|ampollas")
// — así lo que sugiere la IA cae siempre en una opción real del selector.
const UNIDADES_PRESENTACION = ["comprimidos", "capsulas", "ml", "g", "unidades", "sobres", "ampollas"];
const UNIDADES_CONCENTRACION = ["mg", "ml", "mcg", "%"];

// Parseo best-effort de lo que devuelve la IA (ej. "400 mg") a
// valor+unidad separados para los 2 inputs. Notaciones compuestas tipo
// "500 mg/5 ml" no entran enteras en un numérico — se recorta a la
// primera cantidad+unidad reconocida y el resto se pierde; es una
// simplificación a propósito (la mayoría de los productos son
// concentración simple), corregible a mano si hace falta más precisión.
function parseConcentracion(texto: string | undefined): { valor: string; unidad: string } {
  const match = texto?.match(/(\d+(?:[.,]\d+)?)\s*(mg|ml|mcg|%)/i);
  if (!match) return { valor: "", unidad: "mg" };
  return { valor: match[1].replace(",", "."), unidad: match[2].toLowerCase() };
}

function formVacio(ia: RespuestaIA | null): FormEdicion {
  const { valor, unidad } = parseConcentracion(ia?.concentracion);
  return {
    nombre: ia?.nombre ?? "",
    laboratorio: ia?.laboratorio ?? "",
    concentracionValor: valor,
    concentracionUnidad: unidad,
    contenido: ia?.contenido ? String(ia.contenido) : "",
    unidad: ia?.unidad ?? "",
  };
}

// laboratorios solo lo puede escribir admin/gerente/superadmin (RLS) —
// que es exactamente a quién ya restringe resolver_desconocido más abajo,
// así que un insert directo del cliente es seguro acá (mismo patrón que
// productos-abm.tsx: upsert por nombre, sin pantalla de elegir/crear).
async function resolverLaboratorioId(
  supabase: ReturnType<typeof createBrowserClient>,
  nombre: string
): Promise<string | null> {
  const limpio = nombre.trim();
  if (!limpio) return null;
  const { data, error } = await supabase
    .from("laboratorios")
    .upsert({ nombre: limpio }, { onConflict: "nombre" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** Tarjeta no invasiva arriba de la pantalla de conteo — CONTEXTO.md /
 * Fase 4: cuando llega la respuesta de la IA por Realtime, se ofrece
 * Aceptar / Corregir / Descartar. Si el operario la ignora (navega a
 * otra cosa sin tocarla), no pasa nada acá — queda pendiente para la
 * bandeja de revisión de Fase 5, tal cual pide el spec. */
export function TarjetaSugerencia({
  conteoId,
  onResuelto,
}: {
  conteoId: string;
  onResuelto: () => void;
}) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [cola, setCola] = useState<Sugerencia[]>([]);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState<FormEdicion>(formVacio(null));
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    const canal = supabase
      .channel("desconocidos-sugerencias")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "desconocidos" },
        (payload) => {
          const fila = payload.new as FilaDesconocido;
          if (fila.estado === "sugerido" || fila.estado === "no_reconocido") {
            setCola((prev) =>
              prev.some((s) => s.id === fila.id)
                ? prev
                : [
                    ...prev,
                    {
                      id: fila.id,
                      codigoNorm: fila.codigo_norm,
                      estado: fila.estado,
                      iaRespuesta: fila.ia_respuesta as unknown as RespuestaIA | null,
                    },
                  ]
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(canal);
    };
  }, [supabase]);

  const actual = cola[0];

  // Reset del form cuando cambia el item de la cola — a propósito NO es
  // un useEffect (ver "Adjusting state when a prop changes" en la doc de
  // React): comparar y setState acá, durante el render, evita el
  // render-en-cascada que el lint react-hooks/set-state-in-effect marca.
  const [formParaId, setFormParaId] = useState<string | null>(null);
  if (actual && actual.id !== formParaId) {
    setForm(formVacio(actual.iaRespuesta));
    setEditando(false);
    setFormParaId(actual.id);
  }

  if (!actual) return null;

  async function resolver(datos: FormEdicion) {
    setGuardando(true);
    try {
      const laboratorioId = await resolverLaboratorioId(supabase, datos.laboratorio);
      const concentracion = datos.concentracionValor.trim()
        ? `${datos.concentracionValor.trim()} ${datos.concentracionUnidad}`
        : null;

      const { productoId } = await resolverDesconocido(supabase, actual.id, {
        nuevoProducto: {
          nombre: datos.nombre,
          laboratorio_id: laboratorioId,
          concentracion,
          contenido: datos.contenido ? Number(datos.contenido) : null,
          unidad: datos.unidad || null,
          origen: "ia",
        },
      });

      await migrarDesconocidoAProductoLocal({
        conteoId,
        codigoNorm: actual.codigoNorm,
        productoId,
        nombre: datos.nombre,
        laboratorio: datos.laboratorio || null,
        concentracion,
        forma: null,
        contenido: datos.contenido ? Number(datos.contenido) : null,
        unidad: datos.unidad || null,
      });

      setCola((prev) => prev.slice(1));
      onResuelto();
    } catch (e) {
      alert(e instanceof Error ? e.message : "No se pudo resolver el desconocido.");
    } finally {
      setGuardando(false);
    }
  }

  function descartar() {
    setCola((prev) => prev.slice(1));
  }

  const noReconocido = actual.estado === "no_reconocido" || !actual.iaRespuesta;

  return (
    <div className="mb-5 rounded-lg border border-brand/30 bg-brand-dim/20 p-3.5">
      {noReconocido && !editando ? (
        <div>
          <p className="text-sm text-paper">
            La IA no pudo identificar el código{" "}
            <span className="font-mono text-muted">{actual.codigoNorm}</span>. Sin código de barras para
            leer, hay datos que nunca va a poder adivinar solo por la foto — completalos a mano si los
            tenés a la vista.
          </p>
          <div className="mt-2 flex gap-3">
            <button onClick={() => setEditando(true)} className="text-xs font-medium text-brand">
              Completar a mano
            </button>
            <button onClick={descartar} className="text-xs font-medium text-muted">
              Dejar para revisar después
            </button>
          </div>
        </div>
      ) : editando ? (
        <div className="space-y-2">
          <input
            className={inputClase}
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            placeholder="Nombre"
            autoFocus
          />
          <input
            className={inputClase}
            value={form.laboratorio}
            onChange={(e) => setForm({ ...form, laboratorio: e.target.value })}
            placeholder="Laboratorio"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              className={inputClase}
              type="number"
              value={form.concentracionValor}
              onChange={(e) => setForm({ ...form, concentracionValor: e.target.value })}
              placeholder="Concentración"
            />
            <select
              className={selectClase}
              value={form.concentracionUnidad}
              onChange={(e) => setForm({ ...form, concentracionUnidad: e.target.value })}
            >
              {UNIDADES_CONCENTRACION.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className={inputClase}
              type="number"
              value={form.contenido}
              onChange={(e) => setForm({ ...form, contenido: e.target.value })}
              placeholder="Contenido"
            />
            <select
              className={selectClase}
              value={form.unidad}
              onChange={(e) => setForm({ ...form, unidad: e.target.value })}
            >
              <option value="">Presentación…</option>
              {UNIDADES_PRESENTACION.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => resolver(form)}
              disabled={guardando || !form.nombre.trim()}
              className="flex-1 rounded-md bg-brand px-3 py-2 text-sm font-medium text-ink disabled:opacity-50"
            >
              {guardando ? "Guardando…" : "Guardar y aceptar"}
            </button>
            <button onClick={() => setEditando(false)} className="text-sm text-muted">
              Volver
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-brand">
            Sugerencia de IA · {actual.codigoNorm}
          </p>
          <p className="mt-1 text-base font-semibold text-paper">{actual.iaRespuesta?.nombre}</p>
          <p className="text-xs text-muted">
            {actual.iaRespuesta?.laboratorio}
            {actual.iaRespuesta?.confianza != null &&
              ` · confianza ${Math.round(actual.iaRespuesta.confianza * 100)}%`}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => resolver(form)}
              disabled={guardando}
              className="flex-1 rounded-md bg-brand px-3 py-2 text-sm font-medium text-ink disabled:opacity-50"
            >
              Aceptar
            </button>
            <button
              onClick={() => setEditando(true)}
              className="flex-1 rounded-md border border-brand/40 px-3 py-2 text-sm font-medium text-paper"
            >
              Corregir
            </button>
            <button
              onClick={descartar}
              className="flex-1 rounded-md border border-line px-3 py-2 text-sm text-muted"
            >
              Descartar
            </button>
          </div>
        </>
      )}
    </div>
  );
}
