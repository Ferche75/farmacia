"use client";

import { useState } from "react";
import {
  createBrowserClient,
  actualizarCamposPersonalizadosEmpresa,
  type CampoPersonalizado,
} from "@farmacia/db";

// clave = identificador interno (key dentro de productos_empresa.campos_extra),
// derivado de la etiqueta que escribe el usuario — nunca se le pide que
// invente un identificador técnico él mismo.
function slugificar(etiqueta: string): string {
  return etiqueta
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function CamposPersonalizados({ campos: camposIniciales }: { campos: CampoPersonalizado[] }) {
  const [campos, setCampos] = useState(camposIniciales);
  const [nuevaEtiqueta, setNuevaEtiqueta] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  async function guardar(nuevaLista: CampoPersonalizado[]) {
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      const supabase = createBrowserClient();
      await actualizarCamposPersonalizadosEmpresa(supabase, nuevaLista);
      setCampos(nuevaLista);
      setGuardado(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  function agregar() {
    const etiqueta = nuevaEtiqueta.trim();
    if (!etiqueta) return;
    const clave = slugificar(etiqueta);
    if (!clave) {
      setError("Ese nombre no sirve como campo — probá con letras o números.");
      return;
    }
    if (campos.some((c) => c.clave === clave)) {
      setError("Ya existe un campo con ese nombre.");
      return;
    }
    setNuevaEtiqueta("");
    guardar([...campos, { clave, etiqueta }]);
  }

  function quitar(clave: string) {
    guardar(campos.filter((c) => c.clave !== clave));
  }

  // La lista de campos es lo que crece, así que se lleva el ancho (grilla
  // de hasta 3 columnas) y el alta queda en una columna angosta al costado
  // a partir de 2xl. Apilado, el alta se limita a max-w-md: un input de
  // 1400px para escribir "Vencimiento del proveedor" no tiene sentido.
  return (
    <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)] 2xl:gap-10">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Definidos {campos.length > 0 && <span className="tabular-nums">({campos.length})</span>}
        </h3>
        {campos.length > 0 ? (
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {campos.map((c) => (
              <li
                key={c.clave}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-ink" title={c.etiqueta}>
                  {c.etiqueta}
                </span>
                <button
                  type="button"
                  onClick={() => quitar(c.clave)}
                  disabled={guardando}
                  className="shrink-0 text-xs font-medium text-muted transition-colors hover:text-danger disabled:opacity-50"
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
            Todavía no definiste ninguno.
          </p>
        )}
      </div>

      <div className="border-t border-line pt-6 2xl:border-l 2xl:border-t-0 2xl:pl-10 2xl:pt-0">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Agregar campo</h3>
        <div className="mt-4 flex max-w-md gap-2 2xl:max-w-none 2xl:flex-col">
          <input
            className="input"
            placeholder="Ej: Vencimiento del proveedor"
            value={nuevaEtiqueta}
            onChange={(e) => setNuevaEtiqueta(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && agregar()}
          />
          <button
            onClick={agregar}
            disabled={guardando || !nuevaEtiqueta.trim()}
            className="shrink-0 rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50 2xl:w-full"
          >
            Agregar
          </button>
        </div>
        {error ? (
          <p className="mt-2.5 text-sm text-danger">{error}</p>
        ) : guardado ? (
          <p className="mt-2.5 inline-flex items-center gap-1.5 text-sm text-ok">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            Cambios guardados.
          </p>
        ) : (
          <p className="mt-2.5 text-xs text-muted">Se guarda solo, apenas agregás o quitás uno.</p>
        )}
      </div>
    </div>
  );
}
