"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@farmacia/db";

interface Sucursal {
  id: string;
  nombre: string;
  direccion: string | null;
  activo: boolean;
}

interface Bodega {
  id: string;
  sucursal_id: string;
  nombre: string;
  activo: boolean;
}

// Alta/edición de sucursales y bodegas directo contra la tabla (sin
// Server Action): las policies nuevas de 20260813000002 ya autorizan a
// admin/gerente a escribir acá, acotado a su propia empresa — mismo
// patrón cliente-directo que ya usan seleccion-conteo.tsx/productos-abm.tsx,
// no el de Server Actions que usa el panel de superadmin (ese exige
// requireSuperadmin() adentro, por eso no se podía reusar tal cual).
export function SucursalesBodegas({
  empresaId,
  sucursales,
  bodegas,
}: {
  empresaId: string;
  sucursales: Sucursal[];
  bodegas: Bodega[];
}) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const router = useRouter();

  // Las dos tablas se apilan hasta 2xl y recién ahí van lado a lado. En
  // md/lg ponerlas en dos columnas les dejaba ~300px a cada una y se
  // rompían ("Casa matriz" en dos líneas, el botón de la última columna
  // cortado); a pantalla completa, en cambio, entran cómodas y evitan que
  // la tarjeta quede larguísima.
  return (
    <div className="grid gap-8 2xl:grid-cols-2 2xl:gap-8">
      <SeccionSucursales empresaId={empresaId} sucursales={sucursales} supabase={supabase} router={router} />
      <SeccionBodegas empresaId={empresaId} sucursales={sucursales} bodegas={bodegas} supabase={supabase} router={router} />
    </div>
  );
}

type SupabaseClient = ReturnType<typeof createBrowserClient>;
type Router = ReturnType<typeof useRouter>;

const CLASE_BOTON_AGREGAR =
  "shrink-0 whitespace-nowrap rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-paper";

function EstadoActivo({ activo }: { activo: boolean }) {
  return activo ? (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ok">
      <span className="h-1.5 w-1.5 rounded-full bg-ok" />
      activa
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-muted" />
      inactiva
    </span>
  );
}

function SeccionSucursales({
  empresaId,
  sucursales,
  supabase,
  router,
}: {
  empresaId: string;
  sucursales: Sucursal[];
  supabase: SupabaseClient;
  router: Router;
}) {
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState("");
  const [direccion, setDireccion] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function crear() {
    setGuardando(true);
    setError(null);
    try {
      const { error: err } = await supabase
        .from("sucursales")
        .insert({ empresa_id: empresaId, nombre: nombre.trim(), direccion: direccion.trim() || null });
      if (err) throw err;
      setAbierto(false);
      setNombre("");
      setDireccion("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la sucursal.");
    } finally {
      setGuardando(false);
    }
  }

  async function toggleActivo(s: Sucursal) {
    await supabase.from("sucursales").update({ activo: !s.activo }).eq("id", s.id);
    router.refresh();
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Sucursales</h3>
        <button
          onClick={() => {
            setError(null);
            setAbierto(true);
          }}
          className={CLASE_BOTON_AGREGAR}
        >
          + Nueva sucursal
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="px-4 py-2.5 font-medium">Nombre</th>
              <th className="px-4 py-2.5 font-medium">Dirección</th>
              <th className="px-4 py-2.5 font-medium">Estado</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {sucursales.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0 hover:bg-paper">
                <td className="px-4 py-2.5 font-medium text-ink">{s.nombre}</td>
                <td className="px-4 py-2.5 text-muted">{s.direccion ?? "—"}</td>
                <td className="px-4 py-2.5">
                  <EstadoActivo activo={s.activo} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => toggleActivo(s)}
                    className="whitespace-nowrap font-medium text-brand hover:underline"
                  >
                    {s.activo ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
            {sucursales.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted">
                  Todavía no hay sucursales.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {abierto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/40 p-6">
          <div className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-ink">Nueva sucursal</h2>

            {error && (
              <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}

            <label className="mb-1.5 block text-sm font-medium text-ink">Nombre *</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className="input mb-3"
              autoFocus
            />

            <label className="mb-1.5 block text-sm font-medium text-ink">Dirección</label>
            <input value={direccion} onChange={(e) => setDireccion(e.target.value)} className="input mb-5" />

            <div className="flex gap-3">
              <button
                onClick={crear}
                disabled={guardando || !nombre.trim()}
                className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {guardando ? "Creando…" : "Crear"}
              </button>
              <button
                type="button"
                onClick={() => setAbierto(false)}
                className="text-sm text-muted hover:text-ink"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SeccionBodegas({
  empresaId,
  sucursales,
  bodegas,
  supabase,
  router,
}: {
  empresaId: string;
  sucursales: Sucursal[];
  bodegas: Bodega[];
  supabase: SupabaseClient;
  router: Router;
}) {
  const [abierto, setAbierto] = useState(false);
  const [sucursalId, setSucursalId] = useState(sucursales[0]?.id ?? "");
  const [nombre, setNombre] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nombreSucursal = (id: string) => sucursales.find((s) => s.id === id)?.nombre ?? "—";

  async function crear() {
    setGuardando(true);
    setError(null);
    try {
      const { error: err } = await supabase
        .from("bodegas")
        .insert({ empresa_id: empresaId, sucursal_id: sucursalId, nombre: nombre.trim() });
      if (err) throw err;
      setAbierto(false);
      setNombre("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la bodega.");
    } finally {
      setGuardando(false);
    }
  }

  async function toggleActivo(b: Bodega) {
    await supabase.from("bodegas").update({ activo: !b.activo }).eq("id", b.id);
    router.refresh();
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Bodegas</h3>
        <button
          onClick={() => {
            setError(null);
            setSucursalId(sucursales[0]?.id ?? "");
            setAbierto(true);
          }}
          className={CLASE_BOTON_AGREGAR}
        >
          + Nueva bodega
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="px-4 py-2.5 font-medium">Nombre</th>
              <th className="px-4 py-2.5 font-medium">Sucursal</th>
              <th className="px-4 py-2.5 font-medium">Estado</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {bodegas.map((b) => (
              <tr key={b.id} className="border-b border-line last:border-0 hover:bg-paper">
                <td className="px-4 py-2.5 font-medium text-ink">{b.nombre}</td>
                <td className="px-4 py-2.5 text-muted">{nombreSucursal(b.sucursal_id)}</td>
                <td className="px-4 py-2.5">
                  <EstadoActivo activo={b.activo} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => toggleActivo(b)}
                    className="whitespace-nowrap font-medium text-brand hover:underline"
                  >
                    {b.activo ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
            {bodegas.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted">
                  Todavía no hay bodegas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {abierto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/40 p-6">
          <div className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-ink">Nueva bodega</h2>

            {error && (
              <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}

            {sucursales.length === 0 ? (
              <p className="mb-4 text-sm text-muted">Creá una sucursal primero.</p>
            ) : (
              <>
                <label className="mb-1.5 block text-sm font-medium text-ink">Sucursal *</label>
                <select
                  value={sucursalId}
                  onChange={(e) => setSucursalId(e.target.value)}
                  className="input mb-3"
                >
                  {sucursales.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nombre}
                    </option>
                  ))}
                </select>

                <label className="mb-1.5 block text-sm font-medium text-ink">Nombre *</label>
                <input value={nombre} onChange={(e) => setNombre(e.target.value)} className="input mb-5" autoFocus />
              </>
            )}

            <div className="flex gap-3">
              <button
                onClick={crear}
                disabled={guardando || sucursales.length === 0 || !nombre.trim()}
                className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {guardando ? "Creando…" : "Crear"}
              </button>
              <button
                type="button"
                onClick={() => setAbierto(false)}
                className="text-sm text-muted hover:text-ink"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
