"use client";

import { useState } from "react";
import { createBrowserClient, cerrarConteo, type Rol } from "@farmacia/db";
import { ResumenGerencial } from "./resumen-gerencial";
import { EstadoDispositivos } from "./estado-dispositivos";

export function DetalleConteo({
  conteoId,
  nombre,
  estado: estadoInicial,
  sucursalNombre,
  bodegaNombre,
  rol,
}: {
  conteoId: string;
  nombre: string;
  estado: string;
  sucursalNombre: string;
  bodegaNombre: string | null;
  rol: Rol;
}) {
  const [estado, setEstado] = useState(estadoInicial);
  const [confirmando, setConfirmando] = useState(false);
  const [pendientesDesconocidos, setPendientesDesconocidos] = useState<number | null>(null);
  const [cerrando, setCerrando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const puedeGestionar = rol === "admin" || rol === "gerente" || rol === "superadmin";
  // Bug real en producción (2026-09-08): esto excluía a 'admin', que
  // CONTEXTO.md dice explícitamente que tiene que poder ver el resumen
  // gerencial. Sin esto, un admin entraba al detalle de un conteo y no
  // veía nada abajo del encabezado — ni el resumen ni ningún error, la
  // sección entera no se pedía. Ver 20260911000000_resumen_conteo_admin.sql
  // para el mismo fix del lado del RPC (que además lo hubiera rechazado).
  const puedeVerResumen = rol === "admin" || rol === "gerente" || rol === "superadmin";

  async function abrirConfirmacion() {
    setError(null);
    const supabase = createBrowserClient();
    const { count } = await supabase
      .from("conteo_lineas")
      .select("id", { count: "exact", head: true })
      .eq("conteo_id", conteoId)
      .not("desconocido_id", "is", null);
    setPendientesDesconocidos(count ?? 0);
    setConfirmando(true);
  }

  async function confirmarCierre() {
    setCerrando(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      await cerrarConteo(supabase, conteoId);
      setEstado("cerrado");
      setConfirmando(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cerrar el conteo.");
    } finally {
      setCerrando(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{nombre}</h1>
          <p className="mt-1 text-sm text-muted">
            {sucursalNombre}
            {bodegaNombre && ` · ${bodegaNombre}`} ·{" "}
            {estado === "abierto" ? (
              <span className="inline-flex items-center gap-1.5 text-ok">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                abierto
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                cerrado
              </span>
            )}
          </p>
        </div>

        {estado === "abierto" && puedeGestionar && (
          <button
            onClick={abrirConfirmacion}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90"
          >
            Cerrar conteo
          </button>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
      )}

      {confirmando && (
        <div className="mb-6 rounded-lg border border-warn/30 bg-warn-soft p-4">
          <p className="mb-2 text-sm font-medium text-warn">
            ¿Cerrar &quot;{nombre}&quot;? Una vez cerrado queda de solo lectura.
          </p>
          <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-warn/90">
            <li>
              {pendientesDesconocidos === 0
                ? "No quedan desconocidos sin identificar en este conteo."
                : `Quedan ${pendientesDesconocidos} código(s) sin identificar en este conteo — se pueden resolver después desde la bandeja de revisión.`}
            </li>
            <li>
              Antes de confirmar, mirá &quot;Dispositivos&quot; más abajo: ahí está lo que
              cada celular reportó que le quedó sin subir. Ojo con la columna
              &quot;Visto&quot; — si es vieja, ese dato también lo es (el celular está sin
              red) y puede haber más pendientes de los que figuran.
            </li>
          </ul>
          <div className="flex gap-3">
            <button
              onClick={confirmarCierre}
              disabled={cerrando}
              className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {cerrando ? "Cerrando…" : "Sí, cerrar"}
            </button>
            <button onClick={() => setConfirmando(false)} className="text-sm text-muted hover:text-ink">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Mismo booleano que el resumen a propósito: el bug que se acaba de
          arreglar arriba fue exactamente tener dos chequeos de rol
          separados para lo mismo, que se fueron desincronizando. */}
      {puedeVerResumen && <EstadoDispositivos conteoId={conteoId} />}

      {puedeVerResumen && <ResumenGerencial conteoId={conteoId} nombreConteo={nombre} />}
    </div>
  );
}
