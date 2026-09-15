"use client";

import { useActionState, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Rol } from "@farmacia/db";
import { actualizarEstadoOperario, actualizarSucursalesOperario, crearOperario } from "./actions";

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
  const [editando, setEditando] = useState<Empleado | null>(null);
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

  // Cerrar el panel de edición y refrescar es lo mismo pase lo que pase
  // (se haya guardado el estado o las sucursales), así que el hijo lo
  // avisa por acá. Va memoizado porque el hijo lo usa como dependencia
  // de un efecto.
  const cerrarEdicionYRefrescar = useCallback(() => {
    setEditando(null);
    router.refresh();
  }, [router]);

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
              <th className="px-4 py-2.5 font-medium">
                <span className="sr-only">Acciones</span>
              </th>
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
                <td className="px-4 py-2.5 text-right">
                  {/* Solo los operarios son editables desde acá — es el
                      mismo recorte que el alta y que las policies. En las
                      filas de admin/gerente/superadmin no va NADA (ni un
                      botón deshabilitado): un "Editar" apagado invita a
                      buscar cómo prenderlo, y desde esta pantalla no se
                      prende nunca. Para esas filas, superadmin. */}
                  {e.rol === "operario" && (
                    <button
                      onClick={() => setEditando(e)}
                      className="whitespace-nowrap font-medium text-brand hover:underline"
                    >
                      Editar
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {empleados.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
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

      {editando && (
        <EditarOperario
          key={editando.id}
          operario={editando}
          sucursales={sucursales}
          onCerrar={() => setEditando(null)}
          onGuardado={cerrarEdicionYRefrescar}
        />
      )}
    </div>
  );
}

// Segundo modal, con el mismo chrome que "Nuevo operario" (overlay
// ink/40, tarjeta max-w-sm, botón primario + "Cancelar" al lado) para que
// no parezca otra app. Adentro hay DOS formularios independientes y no
// uno solo con dos botones: son dos Server Actions distintas, con
// permisos y validaciones distintas (el estado no depende de las
// sucursales ni al revés), y cada una tiene su propio useActionState con
// su pending y su error. Meterlas en un form único obligaría a mandar
// siempre las dos cosas y a inventar un despachador, que es justo el tipo
// de indirección que este código evita.
//
// Lo que NO hay acá: rol. Un admin/gerente no puede cambiarle el rol a
// nadie — no está en la UI y el `with check` de la policy lo rebota
// igual si el request viniera tocado a mano.
function EditarOperario({
  operario,
  sucursales,
  onCerrar,
  onGuardado,
}: {
  operario: Empleado;
  sucursales: Sucursal[];
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [estadoState, estadoAction, estadoPending] = useActionState(actualizarEstadoOperario, undefined);
  const [sucursalesState, sucursalesAction, sucursalesPending] = useActionState(
    actualizarSucursalesOperario,
    undefined
  );
  const [sucursalIds, setSucursalIds] = useState<string[]>(operario.sucursalIds);

  // Cualquiera de las dos que salga bien cierra el modal y refresca. Va
  // en un efecto y no durante el render por el mismo motivo de siempre en
  // este archivo: onGuardado toca el estado del padre y dispara
  // router.refresh(), y React no admite actualizar otro componente
  // mientras este se renderiza.
  useEffect(() => {
    if (estadoState?.success || sucursalesState?.success) onGuardado();
  }, [estadoState, sucursalesState, onGuardado]);

  function toggleSucursal(id: string) {
    setSucursalIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Se ofrecen las activas (igual que en el alta) MÁS las inactivas que
  // esta persona ya tiene asignadas. Si se escondieran, el formulario
  // mandaría el conjunto sin ellas y se las borraría de callado a quien
  // solo quería tocar otra cosa.
  const sucursalesOfrecidas = sucursales.filter((s) => s.activo || operario.sucursalIds.includes(s.id));
  const error = estadoState?.error ?? sucursalesState?.error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/40 p-6">
      <div className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-ink">Editar operario</h2>
        <p className="mb-4 text-xs text-muted">
          {operario.nombre} — podés moverlo de sucursal o darlo de baja. El rol y el email los cambia el superadmin.
        </p>

        {error && (
          <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <form action={sucursalesAction}>
          <input type="hidden" name="perfilId" value={operario.id} />
          <p className="mb-1.5 text-sm font-medium text-ink">Sucursales *</p>
          <div className="mb-3 max-h-32 space-y-1 overflow-auto rounded-md border border-line p-2">
            {sucursalesOfrecidas.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  name="sucursalIds"
                  value={s.id}
                  checked={sucursalIds.includes(s.id)}
                  onChange={() => toggleSucursal(s.id)}
                />
                {s.nombre}
                {!s.activo && <span className="text-xs text-muted">(inactiva)</span>}
              </label>
            ))}
            {sucursalesOfrecidas.length === 0 && <p className="text-xs text-muted">No hay sucursales activas.</p>}
          </div>
          <button
            type="submit"
            disabled={sucursalesPending || sucursalIds.length === 0}
            className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {sucursalesPending ? "Guardando…" : "Guardar sucursales"}
          </button>
        </form>

        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-1.5 text-sm font-medium text-ink">Estado</p>
          <p className="mb-2 text-xs text-muted">
            {operario.activo
              ? "Al desactivarlo deja de poder entrar a la app de conteo. Los conteos que ya hizo quedan como están."
              : "Está inactivo: no puede entrar a la app de conteo."}
          </p>
          {/* Sin guarda de "es el único de su sucursal": que alguien se
              vaya y deje una sucursal sin operarios es una situación real,
              no un error que haya que impedir. */}
          <form action={estadoAction}>
            <input type="hidden" name="perfilId" value={operario.id} />
            <input type="hidden" name="activo" value={operario.activo ? "false" : "true"} />
            <button
              type="submit"
              disabled={estadoPending}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-50"
            >
              {estadoPending ? "Guardando…" : operario.activo ? "Desactivar" : "Activar"}
            </button>
          </form>
        </div>

        <div className="mt-5">
          <button onClick={onCerrar} className="text-sm text-muted hover:text-ink">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
