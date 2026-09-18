"use client";

import { useState } from "react";
import {
  createBrowserClient,
  actualizarCalculadoraPreciosEmpresa,
  PRESENTACIONES_FRACCIONABLES,
  type CalculadoraPreciosEmpresa,
  type NivelesCalculadoraPrecios,
  type OperacionCalculadora,
  type ReglaCalculadoraPrecios,
} from "@farmacia/db";
import { aplicarRegla, redondear } from "@/lib/calculadora-precios";

const OPERACIONES: { value: OperacionCalculadora; label: string; ayuda: string }[] = [
  { value: "suma", label: "Sumar un monto fijo", ayuda: "Ej: 1 → le suma Bs 1 a la fracción de caja." },
  { value: "multiplicador", label: "Multiplicar", ayuda: "Ej: 1.2 → la fracción de caja × 1,2." },
  { value: "porcentaje", label: "Cargar un %", ayuda: "Ej: 20 → la fracción de caja + 20% de margen." },
];

// Solo para la vista previa de una regla en esta pantalla — no tiene nada
// que ver con ningún producto real. El cálculo completo (con
// blísteres/unidades por caja de un producto puntual) vive en
// /productos, que es donde la sugerencia se aplica de verdad.
const FRACCION_MUESTRA = 10;

interface FilaRegla {
  activa: boolean;
  operacion: OperacionCalculadora;
  valor: string;
}

const FILA_VACIA: FilaRegla = { activa: false, operacion: "multiplicador", valor: "" };

function reglaAFila(regla: ReglaCalculadoraPrecios | null | undefined): FilaRegla {
  return regla ? { activa: true, operacion: regla.operacion, valor: String(regla.valor) } : { ...FILA_VACIA };
}

function filaARegla(fila: FilaRegla): ReglaCalculadoraPrecios | null {
  if (!fila.activa) return null;
  const valor = Number(fila.valor);
  if (!fila.valor.trim() || !Number.isFinite(valor)) return null;
  return { operacion: fila.operacion, valor };
}

interface FilaNiveles {
  nivelIntermedio: FilaRegla;
  unidad: FilaRegla;
}

function nivelesAFila(niveles: NivelesCalculadoraPrecios | null | undefined): FilaNiveles {
  return {
    nivelIntermedio: reglaAFila(niveles?.nivelIntermedio),
    unidad: reglaAFila(niveles?.unidad),
  };
}

function filaANiveles(fila: FilaNiveles): NivelesCalculadoraPrecios | null {
  const nivelIntermedio = filaARegla(fila.nivelIntermedio);
  const unidad = filaARegla(fila.unidad);
  if (!nivelIntermedio && !unidad) return null;
  return { nivelIntermedio, unidad };
}

// null cuando la fila está tildada pero el valor todavía no es un número
// válido — mismo criterio en las dos reglas de una fila.
function filaInvalida(fila: FilaRegla): boolean {
  return fila.activa && (!fila.valor.trim() || !Number.isFinite(Number(fila.valor)));
}

const ETIQUETA_PRESENTACION: Record<string, string> = {
  comprimidos: "Comprimidos",
  capsulas: "Cápsulas",
  tabletas: "Tabletas",
  supositorios: "Supositorios",
  ovulos: "Óvulos",
  ampollas: "Ampollas",
  vial: "Vial",
};

export function CalculadoraPrecios({ config }: { config: CalculadoraPreciosEmpresa }) {
  const [porDefecto, setPorDefecto] = useState<FilaNiveles>(nivelesAFila(config.porDefecto));
  const [porPresentacion, setPorPresentacion] = useState<Record<string, FilaNiveles>>(() =>
    Object.fromEntries(Object.entries(config.porPresentacion).map(([p, n]) => [p, nivelesAFila(n)]))
  );
  const [nuevaPresentacion, setNuevaPresentacion] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  const disponibles = PRESENTACIONES_FRACCIONABLES.filter((p) => !(p in porPresentacion));

  function agregarPresentacion() {
    if (!nuevaPresentacion) return;
    setPorPresentacion((prev) => ({ ...prev, [nuevaPresentacion]: nivelesAFila(null) }));
    setNuevaPresentacion("");
  }

  function quitarPresentacion(presentacion: string) {
    setPorPresentacion((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => p !== presentacion)));
  }

  async function guardar() {
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      if (filaInvalida(porDefecto.nivelIntermedio) || filaInvalida(porDefecto.unidad)) {
        throw new Error("Completá el valor de la regla por defecto, o desactivala.");
      }
      for (const [presentacion, fila] of Object.entries(porPresentacion)) {
        if (filaInvalida(fila.nivelIntermedio) || filaInvalida(fila.unidad)) {
          throw new Error(
            `Completá el valor de la regla de ${ETIQUETA_PRESENTACION[presentacion] ?? presentacion}, o desactivala.`
          );
        }
      }

      const supabase = createBrowserClient();
      await actualizarCalculadoraPreciosEmpresa(supabase, {
        porDefecto: filaANiveles(porDefecto),
        porPresentacion: Object.fromEntries(
          Object.entries(porPresentacion).map(([p, fila]) => [p, filaANiveles(fila)])
        ),
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
        Cuando cargás un producto fraccionable en /productos, esto sugiere un precio de blíster/bandeja y de unidad
        a partir del precio de caja — el vendedor los ve como propuesta y los confirma o corrige antes de guardar.
        El margen no siempre es el mismo por presentación (una bandeja de ampollas no se marca igual que un blíster
        de comprimidos): definí una regla &quot;por defecto&quot; y, si hace falta, pisala para presentaciones
        puntuales.
      </p>

      <div className="mt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Por defecto</h3>
        <p className="mt-1 text-xs text-muted">Se usa para cualquier presentación fraccionable sin regla propia.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <NivelEditor
            titulo="Blíster / bandeja"
            fila={porDefecto.nivelIntermedio}
            onChange={(f) => setPorDefecto({ ...porDefecto, nivelIntermedio: f })}
            disabled={guardando}
          />
          <NivelEditor
            titulo="Unidad suelta"
            fila={porDefecto.unidad}
            onChange={(f) => setPorDefecto({ ...porDefecto, unidad: f })}
            disabled={guardando}
          />
        </div>
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Por presentación</h3>
        <p className="mt-1 text-xs text-muted">Pisa la regla por defecto solo para la presentación elegida.</p>

        {Object.keys(porPresentacion).length > 0 && (
          <div className="mt-3 space-y-4">
            {Object.entries(porPresentacion).map(([presentacion, fila]) => (
              <div key={presentacion} className="rounded-md border border-line bg-paper p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {ETIQUETA_PRESENTACION[presentacion] ?? presentacion}
                  </span>
                  <button
                    type="button"
                    onClick={() => quitarPresentacion(presentacion)}
                    disabled={guardando}
                    className="text-xs font-medium text-muted transition-colors hover:text-danger disabled:opacity-50"
                  >
                    Quitar
                  </button>
                </div>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <NivelEditor
                    titulo="Blíster / bandeja"
                    fila={fila.nivelIntermedio}
                    onChange={(f) =>
                      setPorPresentacion((prev) => ({ ...prev, [presentacion]: { ...fila, nivelIntermedio: f } }))
                    }
                    disabled={guardando}
                    compacto
                  />
                  <NivelEditor
                    titulo="Unidad suelta"
                    fila={fila.unidad}
                    onChange={(f) =>
                      setPorPresentacion((prev) => ({ ...prev, [presentacion]: { ...fila, unidad: f } }))
                    }
                    disabled={guardando}
                    compacto
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {disponibles.length > 0 && (
          <div className="mt-4 flex gap-2">
            <select
              className="input"
              value={nuevaPresentacion}
              disabled={guardando}
              onChange={(e) => setNuevaPresentacion(e.target.value)}
            >
              <option value="">Elegir presentación…</option>
              {disponibles.map((p) => (
                <option key={p} value={p}>
                  {ETIQUETA_PRESENTACION[p] ?? p}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={agregarPresentacion}
              disabled={guardando || !nuevaPresentacion}
              className="shrink-0 rounded-md border border-line px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-50"
            >
              Agregar regla
            </button>
          </div>
        )}
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

function NivelEditor({
  titulo,
  fila,
  onChange,
  disabled,
  compacto,
}: {
  titulo: string;
  fila: FilaRegla;
  onChange: (fila: FilaRegla) => void;
  disabled: boolean;
  compacto?: boolean;
}) {
  const opcion = OPERACIONES.find((o) => o.value === fila.operacion);
  const valorNumerico = Number(fila.valor);
  const previa =
    fila.activa && fila.valor.trim() && Number.isFinite(valorNumerico)
      ? redondear(aplicarRegla(FRACCION_MUESTRA, { operacion: fila.operacion, valor: valorNumerico }))
      : null;

  return (
    <div className={compacto ? "" : "rounded-md border border-line bg-paper p-4"}>
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
