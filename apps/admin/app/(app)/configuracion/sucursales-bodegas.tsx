"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, CircleCheckBig, Pencil, Trash2 } from "lucide-react";
import { createBrowserClient, eliminarBodega, eliminarSucursal } from "@farmacia/db";

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

// Los tres botones de la columna de acciones son solo íconos: sin borde ni
// fondo, gris apagado, y el color recién aparece al pasar por encima —
// distinto por acción (neutro para editar, ok/warn según hacia dónde va el
// toggle, danger para eliminar). El `size={16}` y el `p-1` son los mismos
// que ya usan los botones de ícono de apps/conteo, para que no haya dos
// escalas distintas de lo mismo en el monorepo.
const CLASE_BOTON_ICONO = "p-1 transition-colors";
const CLASE_ICONO_EDITAR = `${CLASE_BOTON_ICONO} text-muted hover:text-ink`;
const CLASE_ICONO_DESACTIVAR = `${CLASE_BOTON_ICONO} text-muted hover:text-warn`;
const CLASE_ICONO_ACTIVAR = `${CLASE_BOTON_ICONO} text-muted hover:text-ok`;
const CLASE_ICONO_ELIMINAR = `${CLASE_BOTON_ICONO} text-muted hover:text-danger`;

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
  const [editando, setEditando] = useState<Sucursal | null>(null);
  const [nombre, setNombre] = useState("");
  const [direccion, setDireccion] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [eliminandoId, setEliminandoId] = useState<string | null>(null);
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

  // Borrado físico, vía RPC (20260927000000): nunca un .delete() directo
  // contra la tabla. El RPC es el que sabe si esta sucursal —o alguna de
  // sus bodegas— tiene historia colgando, y si la tiene tira una excepción
  // con un mensaje ya redactado para mostrar tal cual. Por eso el `catch`
  // prioriza `e.message` igual que crear(): ese texto ES la explicación.
  //
  // El window.confirm alcanza: la acción ya está protegida del otro lado
  // (no puede borrar nada con historia), así que esto es el "¿seguro?" de
  // un tirón, no un flujo de confirmación con su propio modal.
  async function eliminar(s: Sucursal) {
    if (!window.confirm(`¿Eliminar la sucursal «${s.nombre}»? Esta acción no se puede deshacer.`)) return;
    setEliminandoId(s.id);
    setError(null);
    try {
      await eliminarSucursal(supabase, s.id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo eliminar la sucursal.");
    } finally {
      setEliminandoId(null);
    }
  }

  // El update va directo contra la tabla igual que el alta: la policy
  // sucursales_update_propia_empresa (20260813000002) es por fila, no por
  // columna — ya autoriza a admin/gerente a tocar cualquier campo de una
  // sucursal de su empresa, así que nombre/dirección entran sin agregar
  // nada nuevo.
  async function guardarEdicion(s: Sucursal, cambios: { nombre: string; direccion: string | null }) {
    const { error: err } = await supabase
      .from("sucursales")
      .update({ nombre: cambios.nombre, direccion: cambios.direccion })
      .eq("id", s.id);
    if (err) throw err;
    setEditando(null);
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

      {/* El mismo `error` que usa el modal de alta, pero mostrado acá
          arriba cuando el modal está cerrado: el "Eliminar" se dispara
          desde una fila de la tabla, así que su mensaje (que es el que
          explica por qué NO se pudo borrar) no tiene dónde aparecer si
          vive solo adentro del modal. */}
      {error && !abierto && (
        <p className="mb-3 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

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
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => setEditando(s)}
                      aria-label={`Editar ${s.nombre}`}
                      title={`Editar ${s.nombre}`}
                      className={CLASE_ICONO_EDITAR}
                    >
                      <Pencil size={16} aria-hidden />
                    </button>
                    {/* Un solo botón para el toggle: el ícono dice en qué
                        estado está HOY (check = activa, prohibido =
                        inactiva) y tocarlo lo da vuelta. */}
                    <button
                      onClick={() => toggleActivo(s)}
                      aria-label={s.activo ? `Desactivar ${s.nombre}` : `Activar ${s.nombre}`}
                      title={s.activo ? `Desactivar ${s.nombre}` : `Activar ${s.nombre}`}
                      className={s.activo ? CLASE_ICONO_DESACTIVAR : CLASE_ICONO_ACTIVAR}
                    >
                      {s.activo ? <CircleCheckBig size={16} aria-hidden /> : <Ban size={16} aria-hidden />}
                    </button>
                    <button
                      onClick={() => eliminar(s)}
                      disabled={eliminandoId === s.id}
                      aria-label={`Eliminar ${s.nombre}`}
                      title={`Eliminar ${s.nombre}`}
                      className={`${CLASE_ICONO_ELIMINAR} disabled:opacity-50`}
                    >
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </div>
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

      {editando && (
        <ModalEditar
          key={editando.id}
          titulo="Editar sucursal"
          nombreInicial={editando.nombre}
          direccionInicial={editando.direccion ?? ""}
          conDireccion
          onGuardar={(cambios) => guardarEdicion(editando, cambios)}
          onCerrar={() => setEditando(null)}
        />
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
  const [editando, setEditando] = useState<Bodega | null>(null);
  const [sucursalId, setSucursalId] = useState(sucursales[0]?.id ?? "");
  const [nombre, setNombre] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [eliminandoId, setEliminandoId] = useState<string | null>(null);
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

  // Mismo criterio que el eliminar de sucursales: RPC (20260927000000),
  // nunca .delete() directo. Para bodegas las cuatro FKs que las apuntan
  // ya son `on delete restrict` —Postgres solo tampoco dejaría perder
  // nada—, pero el RPC chequea antes para que el mensaje sea una frase y
  // no un error de constraint.
  async function eliminar(b: Bodega) {
    if (!window.confirm(`¿Eliminar la bodega «${b.nombre}»? Esta acción no se puede deshacer.`)) return;
    setEliminandoId(b.id);
    setError(null);
    try {
      await eliminarBodega(supabase, b.id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo eliminar la bodega.");
    } finally {
      setEliminandoId(null);
    }
  }

  // Solo el nombre: la bodega no tiene dirección (cuelga de la sucursal),
  // y la sucursal a la que pertenece NO se edita acá a propósito —
  // moverla de sucursal arrastraría lotes/movimientos ya cargados, que es
  // otra operación, no un renombre. Cubierto por
  // bodegas_update_propia_empresa (20260813000002), que es por fila.
  async function guardarEdicion(b: Bodega, cambios: { nombre: string }) {
    const { error: err } = await supabase.from("bodegas").update({ nombre: cambios.nombre }).eq("id", b.id);
    if (err) throw err;
    setEditando(null);
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

      {/* Ver la nota equivalente en SeccionSucursales: el error del
          Eliminar necesita vivir fuera del modal de alta. */}
      {error && !abierto && (
        <p className="mb-3 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

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
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => setEditando(b)}
                      aria-label={`Editar ${b.nombre}`}
                      title={`Editar ${b.nombre}`}
                      className={CLASE_ICONO_EDITAR}
                    >
                      <Pencil size={16} aria-hidden />
                    </button>
                    <button
                      onClick={() => toggleActivo(b)}
                      aria-label={b.activo ? `Desactivar ${b.nombre}` : `Activar ${b.nombre}`}
                      title={b.activo ? `Desactivar ${b.nombre}` : `Activar ${b.nombre}`}
                      className={b.activo ? CLASE_ICONO_DESACTIVAR : CLASE_ICONO_ACTIVAR}
                    >
                      {b.activo ? <CircleCheckBig size={16} aria-hidden /> : <Ban size={16} aria-hidden />}
                    </button>
                    <button
                      onClick={() => eliminar(b)}
                      disabled={eliminandoId === b.id}
                      aria-label={`Eliminar ${b.nombre}`}
                      title={`Eliminar ${b.nombre}`}
                      className={`${CLASE_ICONO_ELIMINAR} disabled:opacity-50`}
                    >
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </div>
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

      {editando && (
        <ModalEditar
          key={editando.id}
          titulo="Editar bodega"
          nombreInicial={editando.nombre}
          onGuardar={(cambios) => guardarEdicion(editando, { nombre: cambios.nombre })}
          onCerrar={() => setEditando(null)}
        />
      )}
    </div>
  );
}

// Segundo modal, compartido por las dos secciones, con el MISMO chrome
// que los de alta (overlay ink/40, tarjeta max-w-sm, botón primario +
// "Cancelar" al lado) para que no parezca otra pantalla — mismo criterio
// que EditarOperario en empleados.tsx. Lo que cambia entre sucursal y
// bodega es solo si hay campo dirección, así que va por prop y no en dos
// componentes calcados.
//
// El update concreto lo arma cada sección y llega por `onGuardar`: la
// tabla queda literal en el `.from(...)` de cada una en vez de viajar
// como string, que es lo que mantiene tipado el update del cliente de
// Supabase.
//
// El borrado físico SÍ existe (el ícono de tacho de cada fila), pero no
// es un DELETE desde el cliente: va por los RPC eliminar_sucursal /
// eliminar_bodega (20260927000000_eliminar_sucursal_y_bodega.sql). El
// motivo es el cascade en cadena que estas dos tablas arrastran —
// movimientos_stock y lotes cuelgan de sucursales con ON DELETE CASCADE,
// así que un delete crudo borraría historia real sin avisar. El RPC
// chequea antes si hay conteos/movimientos/lotes/integración pdvlat (de
// la sucursal y también de sus bodegas) y se niega con un mensaje
// explicando qué encontró.
//
// En la práctica: Eliminar sirve para la fila que se creó mal o de más;
// en cuanto algo tenga historia real, el RPC la rechaza y lo correcto
// sigue siendo Desactivar.
function ModalEditar({
  titulo,
  nombreInicial,
  conDireccion = false,
  direccionInicial = "",
  onGuardar,
  onCerrar,
}: {
  titulo: string;
  nombreInicial: string;
  conDireccion?: boolean;
  direccionInicial?: string;
  onGuardar: (cambios: { nombre: string; direccion: string | null }) => Promise<void>;
  onCerrar: () => void;
}) {
  const [nombre, setNombre] = useState(nombreInicial);
  const [direccion, setDireccion] = useState(direccionInicial);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      await onGuardar({ nombre: nombre.trim(), direccion: direccion.trim() || null });
      // Si salió bien, el padre ya cerró el modal (setEditando(null)) y
      // refrescó: no tocamos más estado acá, este componente ya no está.
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron guardar los cambios.");
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/40 p-6">
      <div className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-ink">{titulo}</h2>

        {error && (
          <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <label className="mb-1.5 block text-sm font-medium text-ink">Nombre *</label>
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          className={conDireccion ? "input mb-3" : "input mb-5"}
          autoFocus
        />

        {conDireccion && (
          <>
            <label className="mb-1.5 block text-sm font-medium text-ink">Dirección</label>
            <input value={direccion} onChange={(e) => setDireccion(e.target.value)} className="input mb-5" />
          </>
        )}

        <div className="flex gap-3">
          <button
            onClick={guardar}
            disabled={guardando || !nombre.trim()}
            className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
          <button type="button" onClick={onCerrar} className="text-sm text-muted hover:text-ink">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
