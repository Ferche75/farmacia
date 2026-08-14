"use client";

import { useState } from "react";
import { createBrowserClient, actualizarConfigOperativaEmpresa, type ConfigOperativaEmpresa } from "@farmacia/db";
import { CAMPOS_SISTEMA } from "@/lib/campos-sistema";

// Comparten un solo RPC (actualizar_config_operativa_empresa) porque
// viven en la misma pantalla y en empresas.config — separarlos en dos
// llamadas solo agregaría round-trips sin ganar nada.
export function ConfigOperativa({ config }: { config: ConfigOperativaEmpresa }) {
  const [camposRequeridos, setCamposRequeridos] = useState<Set<string>>(
    new Set(config.camposRequeridosImportacion)
  );
  const [rojoDias, setRojoDias] = useState(String(config.vencimientoSemaforo.rojoDias));
  const [amarilloDias, setAmarilloDias] = useState(String(config.vencimientoSemaforo.amarilloDias));
  const [verdeDias, setVerdeDias] = useState(String(config.vencimientoSemaforo.verdeDias));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  function toggleCampo(campo: string) {
    setCamposRequeridos((prev) => {
      const nuevo = new Set(prev);
      if (nuevo.has(campo)) nuevo.delete(campo);
      else nuevo.add(campo);
      return nuevo;
    });
  }

  async function guardar() {
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      const rojo = Number(rojoDias);
      const amarillo = Number(amarilloDias);
      const verde = Number(verdeDias);
      if (!rojo || !amarillo || !verde) {
        throw new Error("Completá los 3 umbrales.");
      }
      if (!(rojo < amarillo && amarillo < verde)) {
        throw new Error("Tienen que ser crecientes: rojo < amarillo < verde.");
      }

      const supabase = createBrowserClient();
      await actualizarConfigOperativaEmpresa(supabase, {
        camposRequeridosImportacion: [...camposRequeridos],
        vencimientoSemaforo: { rojoDias: rojo, amarilloDias: amarillo, verdeDias: verde },
      });
      setGuardado(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  // El semáforo son 3 números cortos y los campos obligatorios son 16
  // checkboxes: puestos uno debajo del otro, el semáforo dejaba una franja
  // vacía enorme a la derecha. Van lado a lado a partir de 2xl (semáforo
  // en columna angosta fija, checkboxes ocupando el resto) y apilados más
  // abajo, donde el semáforo pasa a 3 fichas en fila y también llena.
  const umbrales = [
    { id: "rojo", titulo: "Rojo", texto: "text-danger", punto: "bg-danger", valor: rojoDias, set: setRojoDias },
    { id: "amarillo", titulo: "Amarillo", texto: "text-warn", punto: "bg-warn", valor: amarilloDias, set: setAmarilloDias },
    { id: "verde", titulo: "Verde", texto: "text-ok", punto: "bg-ok", valor: verdeDias, set: setVerdeDias },
  ];

  return (
    <div>
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)] 2xl:gap-10">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Semáforo de vencimiento</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Días restantes para cada color en Vencimientos y Productos. Default: 30 / 90 / 180 (1 / 3 / 6 meses).
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3 2xl:grid-cols-1">
            {umbrales.map((u) => (
              <label key={u.id} className="block rounded-md border border-line bg-paper p-3">
                <span className={`flex items-center gap-1.5 text-xs font-semibold ${u.texto}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${u.punto}`} />
                  {u.titulo}
                </span>
                <span className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    className="input w-20"
                    value={u.valor}
                    onChange={(e) => u.set(e.target.value)}
                  />
                  <span className="text-xs text-muted">días o menos</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="border-t border-line pt-6 2xl:border-l 2xl:border-t-0 2xl:pl-10 2xl:pt-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Campos obligatorios al importar</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            &quot;Nombre&quot; siempre es obligatorio. Marcá qué más tiene que estar mapeado antes de dejar
            previsualizar una importación en tu empresa.
          </p>
          <div className="mt-4 grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2 xl:grid-cols-3">
            <label className="flex items-start gap-2 text-muted">
              <input type="checkbox" checked disabled className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
              <span>Nombre (siempre)</span>
            </label>
            {CAMPOS_SISTEMA.filter((c) => c.campo !== "nombre").map((c) => (
              <label key={c.campo} className="flex items-start gap-2 text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
                  checked={camposRequeridos.has(c.campo)}
                  onChange={() => toggleCampo(c.campo)}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5">
        <button
          onClick={guardar}
          disabled={guardando}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {guardando ? "Guardando…" : "Guardar"}
        </button>
        {error && <span className="text-sm text-danger">{error}</span>}
        {guardado && !error && (
          <span className="inline-flex items-center gap-1.5 text-sm text-ok">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            Cambios guardados.
          </span>
        )}
      </div>
    </div>
  );
}
