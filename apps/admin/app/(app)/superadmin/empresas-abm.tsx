"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { crearEmpresa, actualizarEmpresa } from "./actions";

interface Empresa {
  id: string;
  nombre: string;
  nit: string | null;
  pais: string | null;
  activo: boolean;
  created_at: string;
}

export function EmpresasAbm({ empresas }: { empresas: Empresa[] }) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [state, action, pending] = useActionState(crearEmpresa, undefined);

  // Cerrar el panel al crear con éxito — comparado contra la referencia
  // anterior de `state` (no solo `state.success`) para que no se vuelva a
  // disparar si el usuario lo reabre después de un alta exitosa, cuando
  // `state` sigue siendo el mismo objeto de la vez anterior.
  const [estadoVisto, setEstadoVisto] = useState(state);
  if (state !== estadoVisto) {
    setEstadoVisto(state);
    if (state?.success) setAbierto(false);
  }

  async function toggleActivo(empresa: Empresa) {
    await actualizarEmpresa(empresa.id, { activo: !empresa.activo });
    router.refresh();
  }

  return (
    <div className={`grid gap-6 ${abierto ? "grid-cols-[1fr_440px]" : "grid-cols-1"}`}>
      <div>
        <div className="mb-4 flex justify-end">
          <button
            onClick={() => setAbierto(true)}
            className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90"
          >
            + Nueva empresa
          </button>
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-2.5 font-medium">Nombre</th>
                <th className="px-4 py-2.5 font-medium">NIT</th>
                <th className="px-4 py-2.5 font-medium">País</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {empresas.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-4 py-2.5">
                    <Link href={`/superadmin/${e.id}`} className="font-medium text-ink hover:text-brand">
                      {e.nombre}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{e.nit ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{e.pais ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {e.activo ? (
                      <span className="inline-flex items-center gap-1.5 text-ok">
                        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                        activa
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                        inactiva
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => toggleActivo(e)} className="font-medium text-brand hover:underline">
                      {e.activo ? "Desactivar" : "Activar"}
                    </button>
                  </td>
                </tr>
              ))}
              {empresas.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-muted">
                    Todavía no hay empresas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {abierto && (
        <div className="h-fit rounded-lg border border-line bg-surface p-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Nueva empresa</h2>
            <button
              onClick={() => setAbierto(false)}
              aria-label="Cerrar"
              className="text-muted transition-colors hover:text-ink"
            >
              <IconX className="h-5 w-5" />
            </button>
          </div>

          {state?.error && (
            <p className="mt-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          )}

          <form action={action} className="mt-5 space-y-4">
            <Campo label="Nombre *">
              <input name="nombre" required className="input" autoFocus />
            </Campo>

            <div className="grid grid-cols-2 gap-4">
              <Campo label="NIT">
                <input name="nit" className="input" />
              </Campo>
              <Campo label="País">
                <input name="pais" className="input" />
              </Campo>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Campo label="Teléfono">
                <input name="telefono" type="tel" className="input" />
              </Campo>
              <Campo label="Email">
                <input name="email" type="email" className="input" />
              </Campo>
            </div>

            <Campo label="Dirección">
              <input name="direccion" className="input" />
            </Campo>
            <Campo label="Ciudad">
              <input name="ciudad" className="input" />
            </Campo>

            <div className="flex items-center gap-1.5 border-t border-line pt-4 text-xs font-medium text-muted">
              <IconAlerta className="h-3.5 w-3.5" />
              Contacto de emergencia
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Campo label="Nombre">
                <input name="contacto_emergencia_nombre" className="input" />
              </Campo>
              <Campo label="Teléfono">
                <input name="contacto_emergencia_telefono" type="tel" className="input" />
              </Campo>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
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

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function IconX({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconAlerta({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3 2 20h20L12 3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 9v5M12 17h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
