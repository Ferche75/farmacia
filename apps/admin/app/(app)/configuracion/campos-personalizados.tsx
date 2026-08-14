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

  return (
    <div className="max-w-2xl space-y-4 rounded-lg border border-line bg-surface p-6">
      <div>
        <h2 className="text-sm font-semibold text-ink">Campos personalizados</h2>
        <p className="mt-1 text-xs text-muted">
          Definí tus propios campos — aparecen en la ficha de producto y como columna en la tabla. Por ahora se
          cargan a mano, todavía no se pueden mapear desde el importador masivo. Solo texto libre, no números ni
          fechas todavía.
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
      )}
      {guardado && !error && (
        <p className="rounded-md border border-ok/20 bg-ok-soft px-3 py-2 text-sm text-ok">Guardado.</p>
      )}

      {campos.length > 0 && (
        <ul className="space-y-1.5">
          {campos.map((c) => (
            <li
              key={c.clave}
              className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm"
            >
              <span className="text-ink">{c.etiqueta}</span>
              <button
                type="button"
                onClick={() => quitar(c.clave)}
                disabled={guardando}
                className="text-muted hover:text-danger disabled:opacity-50"
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
      {campos.length === 0 && <p className="text-sm text-muted">Todavía no definiste ninguno.</p>}

      <div className="flex gap-2">
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
          className="shrink-0 rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Agregar
        </button>
      </div>
    </div>
  );
}
