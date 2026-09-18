"use client";

import { useState } from "react";
import {
  createBrowserClient,
  actualizarCalculadoraPreciosEmpresa,
  type CalculadoraPreciosEmpresa,
  type OperacionCalculadora,
  type ReglaCalculadoraPrecios,
} from "@farmacia/db";
import { aplicarRegla, redondear } from "@/lib/calculadora-precios";

const OPERACIONES: { value: OperacionCalculadora; label: string; ayuda: string }[] = [
  { value: "suma", label: "Sumar un monto fijo", ayuda: "Ej: 1 → le suma Bs 1 a la fracción de caja." },
  { value: "multiplicador", label: "Multiplicar", ayuda: "Ej: 1.2 → la fracción de caja × 1,2." },
  { value: "porcentaje", label: "Cargar un %", ayuda: "Ej: 20 → la fracción de caja + 20% de margen." },
];

// Precio de muestra solo para la vista previa de la regla en esta
// pantalla — no tiene nada que ver con ningún producto real. El cálculo
// completo (con blísteres/unidades por caja de un producto puntual) vive
// en el formulario de /productos, que es donde la sugerencia se aplica
// de verdad.
const FRACCION_MUESTRA = 10;

interface FilaRegla {
  activa: boolean;
  operacion: OperacionCalculadora;
  valor: string;
}

function reglaAFila(regla: ReglaCalculadoraPrecios | null): FilaRegla {
  return regla
    ? { activa: true, operacion: regla.operacion, valor: String(regla.valor) }
    : { activa: false, operacion: "multiplicador", valor: "" };
}

function filaARegla(fila: FilaRegla): ReglaCalculadoraPrecios | null {
  if (!fila.activa) return null;
  const valor = Number(fila.valor);
  if (!fila.valor.trim() || !Number.isFinite(valor)) return null;
  return { operacion: fila.operacion, valor };
}

export function CalculadoraPrecios({ config }: { config: CalculadoraPreciosEmpresa }) {
  const [blister, setBlister] = useState<FilaRegla>(reglaAFila(config.blister));
  const [unidad, setUnidad] = useState<FilaRegla>(reglaAFila(config.unidad));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  async function guardar() {
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      if (blister.activa && (!blister.valor.trim() || !Number.isFinite(Number(blister.valor)))) {
        throw new Error("Completá el valor de la regla de blíster, o desactivala.");
      }
      if (unidad.activa && (!unidad.valor.trim() || !Number.isFinite(Number(unidad.valor)))) {
        throw new Error("Completá el valor de la regla de unidad, o desactivala.");
      }

      const supabase = createBrowserClient();
      await actualizarCalculadoraPreciosEmpresa(supabase, {
        blister: filaARegla(blister),
        unidad: filaARegla(unidad),
      });
      setGuardado(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div>
      <p className="text-xs leading-relaxed text-muted">
        Cuando cargás un producto fraccionable en /productos, esto sugiere un precio de blíster y de unidad a partir
        del precio de caja — el vendedor los ve como propuesta y los confirma o corrige antes de guardar. Los tres
        precios se siguen guardando por separado; esto solo ahorra la cuenta inicial.
      </p>

      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <FilaReglaEditor titulo="Regla para el blíster" fila={blister} onChange={setBlister} disabled={guardando} />
        <FilaReglaEditor titulo="Regla para la unidad" fila={unidad} onChange={setUnidad} disabled={guardando} />
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

function FilaReglaEditor({
  titulo,
  fila,
  onChange,
  disabled,
}: {
  titulo: string;
  fila: FilaRegla;
  onChange: (fila: FilaRegla) => void;
  disabled: boolean;
}) {
  const opcion = OPERACIONES.find((o) => o.value === fila.operacion);
  const valorNumerico = Number(fila.valor);
  const previa =
    fila.activa && fila.valor.trim() && Number.isFinite(valorNumerico)
      ? redondear(aplicarRegla(FRACCION_MUESTRA, { operacion: fila.operacion, valor: valorNumerico }))
      : null;

  return (
    <div className="rounded-md border border-line bg-paper p-4">
      <label className="flex items-center gap-2 text-sm font-medium text-ink">
        <input
          type="checkbox"
          className="accent-brand"
          checked={fila.activa}
          disabled={disabled}
          onChange={(e) => onChange({ ...fila, activa: e.target.checked })}
        />
        {titulo}
      </label>

      {fila.activa && (
        <>
          <div className="mt-3 flex gap-2">
            <select
              className="input"
              value={fila.operacion}
              disabled={disabled}
              onChange={(e) => onChange({ ...fila, operacion: e.target.value as OperacionCalculadora })}
            >
              {OPERACIONES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              className="input w-24 shrink-0"
              placeholder="valor"
              value={fila.valor}
              disabled={disabled}
              onChange={(e) => onChange({ ...fila, valor: e.target.value })}
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{opcion?.ayuda}</p>
          {previa !== null && (
            <p className="mt-2 text-xs text-ink">
              Ejemplo: una fracción de caja de Bs {FRACCION_MUESTRA.toFixed(2)} queda sugerida en{" "}
              <span className="font-semibold">Bs {previa.toFixed(2)}</span>.
            </p>
          )}
        </>
      )}
    </div>
  );
}
