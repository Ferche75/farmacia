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

  return (
    <div className="space-y-6 rounded-lg border border-line bg-surface p-6">
      <div>
        <h2 className="text-sm font-semibold text-ink">Configuración operativa</h2>
        <p className="mt-1 text-xs text-muted">Solo afecta a tu empresa — no cambia nada para las demás.</p>
      </div>

      {error && (
        <p className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
      )}
      {guardado && (
        <p className="rounded-md border border-ok/20 bg-ok-soft px-3 py-2 text-sm text-ok">Guardado.</p>
      )}

      <div>
        <h3 className="mb-1.5 text-sm font-medium text-ink">Semáforo de vencimiento</h3>
        <p className="mb-3 text-xs text-muted">
          Días restantes para cada color en /vencimientos y /productos. Default: 30 / 90 / 180 días (1 / 3 / 6
          meses).
        </p>
        <div className="grid max-w-md grid-cols-3 gap-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-danger">Rojo (días o menos)</span>
            <input
              type="number"
              min={1}
              className="input"
              value={rojoDias}
              onChange={(e) => setRojoDias(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-warn">Amarillo (días o menos)</span>
            <input
              type="number"
              min={1}
              className="input"
              value={amarilloDias}
              onChange={(e) => setAmarilloDias(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ok">Verde (días o menos)</span>
            <input
              type="number"
              min={1}
              className="input"
              value={verdeDias}
              onChange={(e) => setVerdeDias(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div>
        <h3 className="mb-1.5 text-sm font-medium text-ink">Campos obligatorios al importar</h3>
        <p className="mb-3 text-xs text-muted">
          &quot;Nombre&quot; siempre es obligatorio. Marcá qué más tiene que estar mapeado antes de dejar
          previsualizar una importación en tu empresa.
        </p>
        <div className="grid max-w-lg grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" checked disabled className="accent-brand" />
            Nombre
          </label>
          {CAMPOS_SISTEMA.filter((c) => c.campo !== "nombre").map((c) => (
            <label key={c.campo} className="flex items-center gap-2 text-ink">
              <input
                type="checkbox"
                className="accent-brand"
                checked={camposRequeridos.has(c.campo)}
                onChange={() => toggleCampo(c.campo)}
              />
              {c.label}
            </label>
          ))}
        </div>
      </div>

      <button
        onClick={guardar}
        disabled={guardando}
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {guardando ? "Guardando…" : "Guardar"}
      </button>
    </div>
  );
}
