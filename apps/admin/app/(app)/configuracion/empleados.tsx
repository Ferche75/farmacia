"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Rol } from "@farmacia/db";
import { crearOperario } from "./actions";

interface Sucursal {
  id: string;
  nombre: string;
  activo: boolean;
}

interface Empleado {
  id: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
  sucursalIds: string[];
}

// Alta de operarios vía Server Action y no cliente-directo (como sí hacen
// SucursalesBodegas o productos-abm): el primer paso del alta es crear la
// fila en auth.users con la service_role key, que no puede salir del
// servidor ni por asomo. Ver crearOperario en ./actions.ts.
export function Empleados({ empleados, sucursales }: { empleados: Empleado[]; sucursales: Sucursal[] }) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [state, action, pending] = useActionState(crearOperario, undefined);

  // Mismo desdoble que el panel de superadmin (ver SeccionSucursales en
  // superadmin/[empresaId]/empresa-detalle.tsx): cerrar el modal es un
  // setState liso y se puede resolver durante el render, pero
  // router.refresh() actualiza un componente ajeno (el Router) y React lo
  // rechaza en runtime si se dispara mientras este se renderiza — por eso
  // va en un efecto aparte, disparado por el mismo cambio de `state`.
  const [estadoVisto, setEstadoVisto] = useState(state);
  if (state !== estadoVisto) {
    setEstadoVisto(state);
    if (state?.success) setAbierto(false);
  }
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);

  // Solo se ofrecen las sucursales activas: asignarle a alguien una
  // sucursal dada de baja no le sirve para contar nada.
  const sucursalesActivas = sucursales.filter((s) => s.activo);
  const nombreSucursal = (id: string) => sucursales.find((s) => s.id === id)?.nombre ?? "—";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Equipo</h3>
        <button
          onClick={() => setAbierto(true)}
          className="shrink-0 whitespace-nowrap rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-paper"
        >
          + Nuevo operario
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="px-4 py-2.5 font-medium">Nombre</th>
              <th className="px-4 py-2.5 font-medium">Rol</th>
              <th className="px-4 py-2.5 font-medium">Sucursales</th>
              <th className="px-4 py-2.5 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {empleados.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0 hover:bg-paper">
                <td className="px-4 py-2.5 font-medium text-ink">{e.nombre}</td>
                <td className="px-4 py-2.5 capitalize text-muted">{e.rol}</td>
                <td className="px-4 py-2.5 text-muted">
                  {/* Las sucursales solo significan algo para un operario
                      (acotan qué puede contar). Un admin/gerente ve toda
                      la empresa, así que una celda vacía ahí sería
                      engañosa, no informativa. */}
                  {e.rol === "operario" ? (
                    e.sucursalIds.length > 0 ? (
                      e.sucursalIds.map(nombreSucursal).join(", ")
                    ) : (
                      <span className="text-danger">sin sucursal asignada</span>
                    )
                  ) : (
                    <span className="text-muted/70">toda la empresa</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {e.activo ? (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ok">
                      <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                      activo
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                      inactivo
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {empleados.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted">
                  Todavía no hay nadie cargado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {abierto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/40 p-6">
          <form action={action} className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
            <h2 className="mb-1 text-lg font-semibold text-ink">Nuevo operario</h2>
            <p className="mb-4 text-xs text-muted">
              Va a poder entrar a la app de conteo con este email y contraseña, solo en las sucursales que le marques.
            </p>

            {state?.error && (
              <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
                {state.error}
              </p>
            )}

            <label className="mb-1.5 block text-sm font-medium text-ink">Nombre *</label>
            <input name="nombre" required className="input mb-3" autoFocus />

            <label className="mb-1.5 block text-sm font-medium text-ink">Email *</label>
            <input name="email" type="email" required className="input mb-3" />

            <label className="mb-1.5 block text-sm font-medium text-ink">Contraseña *</label>
            <input name="password" type="password" required minLength={8} className="input mb-3" />

            <div className="mb-5">
              <p className="mb-1.5 text-sm font-medium text-ink">Sucursales *</p>
              <div className="max-h-32 space-y-1 overflow-auto rounded-md border border-line p-2">
                {sucursalesActivas.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" name="sucursalIds" value={s.id} />
                    {s.nombre}
                  </label>
                ))}
                {sucursalesActivas.length === 0 && (
                  <p className="text-xs text-muted">Creá una sucursal primero.</p>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={pending || sucursalesActivas.length === 0}
                className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending ? "Creando…" : "Crear"}
              </button>
              <button type="button" onClick={() => setAbierto(false)} className="text-sm text-muted hover:text-ink">
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
