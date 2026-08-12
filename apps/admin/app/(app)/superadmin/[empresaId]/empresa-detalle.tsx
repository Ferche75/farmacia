"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Rol } from "@farmacia/db";
import {
  actualizarEmpresa,
  actualizarConfigN8n,
  crearSucursal,
  actualizarSucursal,
  crearBodega,
  actualizarBodega,
  crearUsuario,
  actualizarUsuario,
} from "../actions";

interface Empresa {
  id: string;
  nombre: string;
  nit: string | null;
  pais: string | null;
  telefono: string | null;
  email: string | null;
  direccion: string | null;
  ciudad: string | null;
  contacto_emergencia_nombre: string | null;
  contacto_emergencia_telefono: string | null;
  activo: boolean;
  config: Record<string, unknown>;
}

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

interface Usuario {
  id: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
  email: string;
  sucursalIds: string[];
}

const ROLES: Rol[] = ["operario", "admin", "gerente", "superadmin"];

export function EmpresaDetalle({
  empresa,
  sucursales,
  bodegas,
  usuarios,
}: {
  empresa: Empresa;
  sucursales: Sucursal[];
  bodegas: Bodega[];
  usuarios: Usuario[];
}) {
  return (
    <div>
      <Link href="/superadmin" className="mb-4 inline-block text-sm text-muted hover:text-ink">
        ← Empresas
      </Link>

      <EncabezadoEmpresa empresa={empresa} />
      <ConfigN8n empresa={empresa} />

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <SeccionSucursales empresaId={empresa.id} sucursales={sucursales} />
        <SeccionUsuarios empresaId={empresa.id} usuarios={usuarios} sucursales={sucursales} />
        <SeccionBodegas empresaId={empresa.id} sucursales={sucursales} bodegas={bodegas} />
      </div>
    </div>
  );
}

const CAMPOS_EDITABLES_EMPRESA = [
  "nombre",
  "nit",
  "pais",
  "telefono",
  "email",
  "direccion",
  "ciudad",
  "contacto_emergencia_nombre",
  "contacto_emergencia_telefono",
] as const;

type CampoEditableEmpresa = (typeof CAMPOS_EDITABLES_EMPRESA)[number];

function EncabezadoEmpresa({ empresa }: { empresa: Empresa }) {
  const router = useRouter();
  const [editando, setEditando] = useState(false);
  const [valores, setValores] = useState<Record<CampoEditableEmpresa, string>>(() =>
    Object.fromEntries(CAMPOS_EDITABLES_EMPRESA.map((c) => [c, empresa[c] ?? ""])) as Record<
      CampoEditableEmpresa,
      string
    >
  );
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setCampo(campo: CampoEditableEmpresa, valor: string) {
    setValores((prev) => ({ ...prev, [campo]: valor }));
  }

  async function guardar() {
    setGuardando(true);
    setError(null);
    const cambios = Object.fromEntries(
      CAMPOS_EDITABLES_EMPRESA.map((c) => [c, c === "nombre" ? valores[c] : valores[c] || null])
    );
    const res = await actualizarEmpresa(empresa.id, cambios);
    setGuardando(false);
    if (res?.error) {
      setError(res.error);
      return;
    }
    setEditando(false);
    router.refresh();
  }

  async function toggleActivo() {
    await actualizarEmpresa(empresa.id, { activo: !empresa.activo });
    router.refresh();
  }

  if (editando) {
    return (
      <div className="rounded-lg border border-line bg-surface p-5">
        {error && (
          <p className="mb-3 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
        )}

        <div className="grid grid-cols-3 gap-3">
          <CampoInline label="Nombre" valor={valores.nombre} onChange={(v) => setCampo("nombre", v)} />
          <CampoInline label="NIT" valor={valores.nit} onChange={(v) => setCampo("nit", v)} />
          <CampoInline label="País" valor={valores.pais} onChange={(v) => setCampo("pais", v)} />
          <CampoInline label="Teléfono" valor={valores.telefono} onChange={(v) => setCampo("telefono", v)} />
          <CampoInline label="Email" valor={valores.email} onChange={(v) => setCampo("email", v)} />
          <CampoInline label="Ciudad" valor={valores.ciudad} onChange={(v) => setCampo("ciudad", v)} />
          <CampoInline
            label="Dirección"
            valor={valores.direccion}
            onChange={(v) => setCampo("direccion", v)}
            className="col-span-3"
          />
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <p className="mb-2 text-xs font-medium text-muted">Contacto de emergencia</p>
          <div className="grid grid-cols-2 gap-3">
            <CampoInline
              label="Nombre"
              valor={valores.contacto_emergencia_nombre}
              onChange={(v) => setCampo("contacto_emergencia_nombre", v)}
            />
            <CampoInline
              label="Teléfono"
              valor={valores.contacto_emergencia_telefono}
              onChange={(v) => setCampo("contacto_emergencia_telefono", v)}
            />
          </div>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            onClick={guardar}
            disabled={guardando}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
          <button onClick={() => setEditando(false)} className="text-sm text-muted hover:text-ink">
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{empresa.nombre}</h1>
          <p className="mt-1 text-sm text-muted">
            {empresa.nit || "sin NIT"} · {empresa.pais || "sin país"} ·{" "}
            {empresa.activo ? (
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
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setEditando(true)} className="text-sm font-medium text-brand hover:underline">
            Editar
          </button>
          <button onClick={toggleActivo} className="text-sm font-medium text-muted hover:text-ink">
            {empresa.activo ? "Desactivar" : "Activar"}
          </button>
        </div>
      </div>

      {(empresa.telefono ||
        empresa.email ||
        empresa.direccion ||
        empresa.ciudad ||
        empresa.contacto_emergencia_nombre) && (
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-line pt-4 text-sm sm:grid-cols-3">
          {empresa.telefono && <InfoDato label="Teléfono" valor={empresa.telefono} />}
          {empresa.email && <InfoDato label="Email" valor={empresa.email} />}
          {(empresa.direccion || empresa.ciudad) && (
            <InfoDato label="Dirección" valor={[empresa.direccion, empresa.ciudad].filter(Boolean).join(", ")} />
          )}
          {empresa.contacto_emergencia_nombre && (
            <InfoDato
              label="Contacto de emergencia"
              valor={[empresa.contacto_emergencia_nombre, empresa.contacto_emergencia_telefono]
                .filter(Boolean)
                .join(" · ")}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CampoInline({
  label,
  valor,
  onChange,
  className,
}: {
  label: string;
  valor: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input value={valor} onChange={(e) => onChange(e.target.value)} className="input" />
    </label>
  );
}

function InfoDato({ label, valor }: { label: string; valor: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-ink">{valor}</p>
    </div>
  );
}

function ConfigN8n({ empresa }: { empresa: Empresa }) {
  const router = useRouter();
  const configActual = empresa.config as { n8n_webhook_url?: string; n8n_webhook_secret?: string };
  const [url, setUrl] = useState(configActual.n8n_webhook_url ?? "");
  const [secret, setSecret] = useState(configActual.n8n_webhook_secret ?? "");
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function guardar() {
    setGuardando(true);
    setMensaje(null);
    const res = await actualizarConfigN8n(empresa.id, { n8n_webhook_url: url, n8n_webhook_secret: secret });
    setGuardando(false);
    setMensaje(res?.error ?? "Guardado.");
    if (!res?.error) router.refresh();
  }

  return (
    <div className="mt-4 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-medium text-ink">Identificación de desconocidos por IA (n8n)</h2>
      <p className="mt-1 text-xs text-muted">
        URL y secreto del webhook que dispara la identificación automática de códigos no catalogados. Dejalo vacío si
        esta empresa todavía no usa esa integración.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://tu-n8n.com/webhook/desconocidos"
          className="input"
        />
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Secreto compartido"
          className="input"
        />
      </div>
      {mensaje && <p className="mt-2 text-xs text-muted">{mensaje}</p>}
      <button
        onClick={guardar}
        disabled={guardando}
        className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-50"
      >
        {guardando ? "Guardando…" : "Guardar configuración"}
      </button>
    </div>
  );
}

function SeccionSucursales({ empresaId, sucursales }: { empresaId: string; sucursales: Sucursal[] }) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [state, action, pending] = useActionState(crearSucursal, undefined);

  // Cerrar el modal se puede resolver durante el render (es un setState
  // liso) pero router.refresh() NO — dispara una actualización en un
  // componente ajeno (el Router) mientras este todavía se está
  // renderizando, algo que React rechaza en runtime ("Cannot update a
  // component while rendering a different component"). Por eso va en un
  // efecto aparte, disparado por el mismo cambio de `state`.
  const [estadoVisto, setEstadoVisto] = useState(state);
  if (state !== estadoVisto) {
    setEstadoVisto(state);
    if (state?.success) setAbierto(false);
  }
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);

  async function toggleActivo(s: Sucursal) {
    await actualizarSucursal(empresaId, s.id, { activo: !s.activo });
    router.refresh();
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Sucursales</h2>
        <button onClick={() => setAbierto(true)} className="text-sm font-medium text-brand hover:underline">
          + Nueva
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <tbody>
            {sucursales.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 text-ink">{s.nombre}</td>
                <td className="px-4 py-2.5 text-muted">{s.direccion ?? "—"}</td>
                <td className="px-4 py-2.5">
                  {s.activo ? <span className="text-ok">activa</span> : <span className="text-muted">inactiva</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => toggleActivo(s)} className="font-medium text-brand hover:underline">
                    {s.activo ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
            {sucursales.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-muted">Todavía no hay sucursales.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {abierto && (
        <div className="fixed inset-0 flex items-center justify-center bg-ink/40 p-6">
          <form action={action} className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
            <input type="hidden" name="empresaId" value={empresaId} />
            <h2 className="mb-4 text-lg font-semibold text-ink">Nueva sucursal</h2>

            {state?.error && (
              <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
                {state.error}
              </p>
            )}

            <label className="mb-1.5 block text-sm font-medium text-ink">Nombre *</label>
            <input name="nombre" required className="input mb-3" autoFocus />

            <label className="mb-1.5 block text-sm font-medium text-ink">Dirección</label>
            <input name="direccion" className="input mb-5" />

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={pending}
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

function SeccionBodegas({
  empresaId,
  sucursales,
  bodegas,
}: {
  empresaId: string;
  sucursales: Sucursal[];
  bodegas: Bodega[];
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [state, action, pending] = useActionState(crearBodega, undefined);
  const [sucursalElegida, setSucursalElegida] = useState(sucursales[0]?.id ?? "");

  // Ver el comentario en SeccionSucursales: mismo motivo para separar el
  // cierre del modal (durante el render) de router.refresh() (en un efecto).
  const [estadoVisto, setEstadoVisto] = useState(state);
  if (state !== estadoVisto) {
    setEstadoVisto(state);
    if (state?.success) setAbierto(false);
  }
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);

  async function toggleActivo(b: Bodega) {
    await actualizarBodega(empresaId, b.id, { activo: !b.activo });
    router.refresh();
  }

  const nombreSucursal = (id: string) => sucursales.find((s) => s.id === id)?.nombre ?? "—";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Bodegas</h2>
        <button
          onClick={() => {
            setSucursalElegida(sucursales[0]?.id ?? "");
            setAbierto(true);
          }}
          className="text-sm font-medium text-brand hover:underline"
        >
          + Nueva
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <tbody>
            {bodegas.map((b) => (
              <tr key={b.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 text-ink">{b.nombre}</td>
                <td className="px-4 py-2.5 text-muted">{nombreSucursal(b.sucursal_id)}</td>
                <td className="px-4 py-2.5">
                  {b.activo ? <span className="text-ok">activa</span> : <span className="text-muted">inactiva</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => toggleActivo(b)} className="font-medium text-brand hover:underline">
                    {b.activo ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
            {bodegas.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-muted">Todavía no hay bodegas.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {abierto && (
        <div className="fixed inset-0 flex items-center justify-center bg-ink/40 p-6">
          <form action={action} className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
            <input type="hidden" name="empresaId" value={empresaId} />
            <h2 className="mb-4 text-lg font-semibold text-ink">Nueva bodega</h2>

            {state?.error && (
              <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
                {state.error}
              </p>
            )}

            {sucursales.length === 0 ? (
              <p className="mb-4 text-sm text-muted">Creá una sucursal primero.</p>
            ) : (
              <>
                <label className="mb-1.5 block text-sm font-medium text-ink">Sucursal *</label>
                <select
                  name="sucursalId"
                  value={sucursalElegida}
                  onChange={(e) => setSucursalElegida(e.target.value)}
                  className="input mb-3"
                >
                  {sucursales.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nombre}
                    </option>
                  ))}
                </select>

                <label className="mb-1.5 block text-sm font-medium text-ink">Nombre *</label>
                <input name="nombre" required className="input mb-5" autoFocus />
              </>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={pending || sucursales.length === 0}
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

function SeccionUsuarios({
  empresaId,
  usuarios,
  sucursales,
}: {
  empresaId: string;
  usuarios: Usuario[];
  sucursales: Sucursal[];
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<Usuario | null>(null);
  const [state, action, pending] = useActionState(crearUsuario, undefined);
  const [rolElegido, setRolElegido] = useState<Rol>("operario");

  // Ver el comentario en SeccionSucursales: mismo motivo para separar el
  // cierre del modal (durante el render) de router.refresh() (en un efecto).
  const [estadoVisto, setEstadoVisto] = useState(state);
  if (state !== estadoVisto) {
    setEstadoVisto(state);
    if (state?.success) setAbierto(false);
  }
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);

  async function toggleActivo(u: Usuario) {
    await actualizarUsuario(empresaId, u.id, { activo: !u.activo });
    router.refresh();
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Usuarios</h2>
        <button
          onClick={() => {
            setRolElegido("operario");
            setAbierto(true);
          }}
          className="text-sm font-medium text-brand hover:underline"
        >
          + Nuevo
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <tbody>
            {usuarios.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <p className="text-ink">{u.nombre}</p>
                  <p className="text-xs text-muted">{u.email}</p>
                </td>
                <td className="px-4 py-2.5 capitalize text-muted">{u.rol}</td>
                <td className="px-4 py-2.5">
                  {u.activo ? <span className="text-ok">activo</span> : <span className="text-muted">inactivo</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-3">
                    <button onClick={() => setEditando(u)} className="font-medium text-brand hover:underline">
                      Editar
                    </button>
                    <button onClick={() => toggleActivo(u)} className="font-medium text-muted hover:text-ink">
                      {u.activo ? "Desactivar" : "Activar"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {usuarios.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-muted">Todavía no hay usuarios.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {abierto && (
        <div className="fixed inset-0 flex items-center justify-center bg-ink/40 p-6">
          <form action={action} className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
            <input type="hidden" name="empresaId" value={empresaId} />
            <h2 className="mb-4 text-lg font-semibold text-ink">Nuevo usuario</h2>

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

            <label className="mb-1.5 block text-sm font-medium text-ink">Rol *</label>
            <select
              name="rol"
              value={rolElegido}
              onChange={(e) => setRolElegido(e.target.value as Rol)}
              className="input mb-3"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>

            {rolElegido === "operario" && (
              <div className="mb-5">
                <p className="mb-1.5 text-sm font-medium text-ink">Sucursales *</p>
                <div className="max-h-32 space-y-1 overflow-auto rounded-md border border-line p-2">
                  {sucursales.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm text-ink">
                      <input type="checkbox" name="sucursalIds" value={s.id} />
                      {s.nombre}
                    </label>
                  ))}
                  {sucursales.length === 0 && (
                    <p className="text-xs text-muted">Creá una sucursal primero.</p>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={pending}
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
        <EditarUsuario
          empresaId={empresaId}
          usuario={editando}
          sucursales={sucursales}
          onCerrar={() => setEditando(null)}
          onGuardado={() => {
            setEditando(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EditarUsuario({
  empresaId,
  usuario,
  sucursales,
  onCerrar,
  onGuardado,
}: {
  empresaId: string;
  usuario: Usuario;
  sucursales: Sucursal[];
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [nombre, setNombre] = useState(usuario.nombre);
  const [rol, setRol] = useState<Rol>(usuario.rol);
  const [sucursalIds, setSucursalIds] = useState<string[]>(usuario.sucursalIds);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleSucursal(id: string) {
    setSucursalIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function guardar() {
    setGuardando(true);
    setError(null);

    const res = await actualizarUsuario(empresaId, usuario.id, {
      nombre,
      rol,
      sucursalIds: rol === "operario" ? sucursalIds : undefined,
    });
    setGuardando(false);
    if (res?.error) {
      setError(res.error);
      return;
    }

    onGuardado();
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-ink/40 p-6">
      <div className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-ink">Editar usuario</h2>

        {error && (
          <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
        )}

        <p className="mb-3 text-xs text-muted">{usuario.email}</p>

        <label className="mb-1.5 block text-sm font-medium text-ink">Nombre</label>
        <input value={nombre} onChange={(e) => setNombre(e.target.value)} className="input mb-3" />

        <label className="mb-1.5 block text-sm font-medium text-ink">Rol</label>
        <select value={rol} onChange={(e) => setRol(e.target.value as Rol)} className="input mb-3">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        {rol === "operario" && (
          <div className="mb-5">
            <p className="mb-1.5 text-sm font-medium text-ink">Sucursales</p>
            <div className="max-h-32 space-y-1 overflow-auto rounded-md border border-line p-2">
              {sucursales.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={sucursalIds.includes(s.id)}
                    onChange={() => toggleSucursal(s.id)}
                  />
                  {s.nombre}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={guardar}
            disabled={guardando}
            className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
          <button onClick={onCerrar} className="text-sm text-muted hover:text-ink">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
