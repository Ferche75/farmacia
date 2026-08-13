"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@farmacia/db";
import type { MetaConteo } from "@/lib/db";
import type { SucursalOpcion } from "./conteo-app";

interface ConteoAbierto {
  id: string;
  nombre: string;
  bodegaNombre: string | null;
}

interface BodegaOpcion {
  id: string;
  nombre: string;
}

export function SeleccionConteo({
  perfilId,
  empresaId,
  sucursales,
  onElegido,
}: {
  perfilId: string;
  empresaId: string;
  sucursales: SucursalOpcion[];
  onElegido: (meta: MetaConteo) => void;
}) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [sucursalId, setSucursalId] = useState(sucursales[0]?.id ?? "");
  const [abiertos, setAbiertos] = useState<ConteoAbierto[]>([]);
  const [bodegas, setBodegas] = useState<BodegaOpcion[]>([]);
  const [bodegaId, setBodegaId] = useState("");
  const [nombreNuevo, setNombreNuevo] = useState("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sucursalId) return;
    supabase
      .from("conteos")
      .select("id, nombre, bodegas(nombre)")
      .eq("sucursal_id", sucursalId)
      .eq("estado", "abierto")
      .order("iniciado_at", { ascending: false })
      .then(({ data }) => {
        setAbiertos(
          (data ?? []).map((c) => ({
            id: c.id,
            nombre: c.nombre,
            bodegaNombre: (c.bodegas as unknown as { nombre: string } | null)?.nombre ?? null,
          }))
        );
      });
  }, [sucursalId, supabase]);

  // Bodega es una subdivisión OPCIONAL de la sucursal — la mayoría de las
  // empresas no tiene ninguna cargada, así que este selector solo aparece
  // cuando `bodegas` trae algo (ver el render más abajo).
  useEffect(() => {
    if (!sucursalId) return;
    supabase
      .from("bodegas")
      .select("id, nombre")
      .eq("sucursal_id", sucursalId)
      .eq("activo", true)
      .order("nombre")
      .then(({ data }) => setBodegas(data ?? []));
  }, [sucursalId, supabase]);

  // Resetear la bodega elegida al cambiar de sucursal es un ajuste de
  // estado derivado de un cambio de prop/estado, no una sincronización
  // con un sistema externo — se hace durante el render, no en un efecto
  // (mismo patrón que ya usa el panel de superadmin para separar esto de
  // un setState asincrónico real).
  const [sucursalVista, setSucursalVista] = useState(sucursalId);
  if (sucursalId !== sucursalVista) {
    setSucursalVista(sucursalId);
    setBodegaId("");
  }

  function metaBase(conteoId: string, nombre: string): MetaConteo {
    return {
      id: "actual",
      conteoId,
      sucursalId,
      nombre,
      catalogoListo: false,
      catalogoDescargadoAt: null,
      catalogoTotal: 0,
    };
  }

  async function abrirNuevo() {
    setCargando(true);
    setError(null);
    try {
      const nombre = nombreNuevo.trim() || `Conteo ${new Date().toLocaleDateString("es-BO")}`;
      const { data, error: err } = await supabase
        .from("conteos")
        .insert({
          empresa_id: empresaId,
          sucursal_id: sucursalId,
          bodega_id: bodegaId || null,
          nombre,
          iniciado_por: perfilId,
        })
        .select("id, nombre")
        .single();
      if (err) throw err;
      onElegido(metaBase(data.id, data.nombre));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo abrir el conteo.");
    } finally {
      setCargando(false);
    }
  }

  if (sucursales.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-muted">
        No tenés ninguna sucursal asignada. Pedile a tu administrador que te asigne una.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col p-6">
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-paper">Empezar a contar</h1>
      <p className="mb-6 text-sm text-muted">Elegí la sucursal y retomá o abrí un conteo.</p>

      {error && (
        <p className="mb-4 rounded-md border border-notfound/30 bg-notfound-bg px-3.5 py-2.5 text-sm text-notfound">
          {error}
        </p>
      )}

      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">
        Sucursal
      </label>
      {sucursales.length === 1 ? (
        <div className="mb-7 rounded-md border border-line bg-ink-2 px-4 py-3.5 text-base text-paper">
          {sucursales[0].nombre}
        </div>
      ) : (
        <select
          value={sucursalId}
          onChange={(e) => setSucursalId(e.target.value)}
          className="mb-7 w-full rounded-md border border-line bg-ink-2 px-4 py-3.5 text-base text-paper outline-none focus:border-brand"
        >
          {sucursales.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nombre}
            </option>
          ))}
        </select>
      )}

      {bodegas.length > 0 && (
        <>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">
            Bodega
          </label>
          <select
            value={bodegaId}
            onChange={(e) => setBodegaId(e.target.value)}
            className="mb-7 w-full rounded-md border border-line bg-ink-2 px-4 py-3.5 text-base text-paper outline-none focus:border-brand"
          >
            <option value="">— Toda la sucursal —</option>
            {bodegas.map((b) => (
              <option key={b.id} value={b.id}>
                {b.nombre}
              </option>
            ))}
          </select>
        </>
      )}

      {abiertos.length > 0 && (
        <div className="mb-7">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Conteos abiertos acá
          </p>
          <div className="space-y-2">
            {abiertos.map((c) => (
              <button
                key={c.id}
                onClick={() => onElegido(metaBase(c.id, c.nombre))}
                className="flex w-full items-center justify-between rounded-md border border-line bg-ink-2 px-4 py-3.5 text-left text-base text-paper transition-colors hover:border-brand"
              >
                <span className="flex items-center gap-2.5">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-found" />
                  {c.nombre}
                  {c.bodegaNombre && <span className="text-muted">· {c.bodegaNombre}</span>}
                </span>
                <span className="text-muted">→</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          O abrir uno nuevo
        </p>
        <input
          type="text"
          value={nombreNuevo}
          onChange={(e) => setNombreNuevo(e.target.value)}
          placeholder={`Conteo ${new Date().toLocaleDateString("es-BO")}`}
          className="mb-3 w-full rounded-md border border-line bg-ink-2 px-4 py-3.5 text-base text-paper outline-none focus:border-brand"
        />
        <button
          onClick={abrirNuevo}
          disabled={cargando || !sucursalId}
          className="w-full rounded-md bg-brand px-4 py-3.5 text-base font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {cargando ? "Abriendo…" : "Abrir conteo nuevo"}
        </button>
      </div>
    </div>
  );
}
