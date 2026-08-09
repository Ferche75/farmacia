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
  concentracion: string;
  forma: string;
  contenido: string;
  unidad: string;
}

const inputClase =
  "w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand";

function formVacio(ia: RespuestaIA | null): FormEdicion {
  return {
    nombre: ia?.nombre ?? "",
    laboratorio: ia?.laboratorio ?? "",
    concentracion: ia?.concentracion ?? "",
    forma: "",
    contenido: ia?.contenido ? String(ia.contenido) : "",
    unidad: ia?.unidad ?? "",
  };
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
      const { productoId } = await resolverDesconocido(supabase, actual.id, {
        nuevoProducto: {
          nombre: datos.nombre,
          concentracion: datos.concentracion || null,
          forma: datos.forma || null,
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
        concentracion: datos.concentracion || null,
        forma: datos.forma || null,
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
      {noReconocido ? (
        <div>
          <p className="text-sm text-paper">
            La IA no pudo identificar el código{" "}
            <span className="font-mono text-muted">{actual.codigoNorm}</span>.
          </p>
          <button onClick={descartar} className="mt-2 text-xs font-medium text-brand">
            OK, queda para revisar después
          </button>
        </div>
      ) : editando ? (
        <div className="space-y-2">
          <input
            className={inputClase}
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            placeholder="Nombre"
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
              value={form.concentracion}
              onChange={(e) => setForm({ ...form, concentracion: e.target.value })}
              placeholder="Concentración"
            />
            <input
              className={inputClase}
              value={form.forma}
              onChange={(e) => setForm({ ...form, forma: e.target.value })}
              placeholder="Forma"
            />
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
