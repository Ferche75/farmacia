"use client";

import { useState, type ReactNode } from "react";
import { createBrowserClient, actualizarDatosContactoEmpresa } from "@farmacia/db";

interface EmpresaContacto {
  nombre: string;
  telefono: string | null;
  email: string | null;
  direccion: string | null;
  ciudad: string | null;
  contacto_emergencia_nombre: string | null;
  contacto_emergencia_telefono: string | null;
}

export function ConfiguracionForm({ empresa }: { empresa: EmpresaContacto }) {
  const [nombre, setNombre] = useState(empresa.nombre);
  const [telefono, setTelefono] = useState(empresa.telefono ?? "");
  const [email, setEmail] = useState(empresa.email ?? "");
  const [direccion, setDireccion] = useState(empresa.direccion ?? "");
  const [ciudad, setCiudad] = useState(empresa.ciudad ?? "");
  const [contactoEmergenciaNombre, setContactoEmergenciaNombre] = useState(
    empresa.contacto_emergencia_nombre ?? ""
  );
  const [contactoEmergenciaTelefono, setContactoEmergenciaTelefono] = useState(
    empresa.contacto_emergencia_telefono ?? ""
  );
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  async function guardar() {
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      const supabase = createBrowserClient();
      await actualizarDatosContactoEmpresa(supabase, {
        nombre,
        telefono: telefono.trim() || null,
        email: email.trim() || null,
        direccion: direccion.trim() || null,
        ciudad: ciudad.trim() || null,
        contactoEmergenciaNombre: contactoEmergenciaNombre.trim() || null,
        contactoEmergenciaTelefono: contactoEmergenciaTelefono.trim() || null,
      });
      setGuardado(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div>
      {/* Dos bloques de campos, no uno solo: los datos de la empresa y el
          contacto de emergencia son cosas distintas y así el subtítulo
          reemplaza a las etiquetas largas tipo "Contacto de emergencia —
          nombre". A partir de 2xl van lado a lado (3fr/2fr), y cada grilla
          queda como un rectángulo exacto en todos los breakpoints — sin
          celdas colgando ni ancho muerto al costado. */}
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] 2xl:gap-10">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Empresa</h3>
          <div className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-2">
            <Campo label="Nombre *" className="sm:col-span-2">
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} required className="input" />
            </Campo>
            <Campo label="Teléfono">
              <input value={telefono} onChange={(e) => setTelefono(e.target.value)} className="input" />
            </Campo>
            <Campo label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
            </Campo>
            <Campo label="Dirección">
              <input value={direccion} onChange={(e) => setDireccion(e.target.value)} className="input" />
            </Campo>
            <Campo label="Ciudad">
              <input value={ciudad} onChange={(e) => setCiudad(e.target.value)} className="input" />
            </Campo>
          </div>
        </div>

        <div className="border-t border-line pt-6 2xl:border-l 2xl:border-t-0 2xl:pl-10 2xl:pt-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Contacto de emergencia</h3>
          <p className="mt-1 text-xs text-muted">A quién avisar si pasa algo fuera de horario.</p>
          <div className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2">
            <Campo label="Nombre">
              <input
                value={contactoEmergenciaNombre}
                onChange={(e) => setContactoEmergenciaNombre(e.target.value)}
                className="input"
              />
            </Campo>
            <Campo label="Teléfono">
              <input
                value={contactoEmergenciaTelefono}
                onChange={(e) => setContactoEmergenciaTelefono(e.target.value)}
                className="input"
              />
            </Campo>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5">
        <button
          onClick={guardar}
          disabled={guardando || !nombre.trim()}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {guardando ? "Guardando…" : "Guardar"}
        </button>
        {error && <span className="text-sm text-danger">{error}</span>}
        {guardado && !error && (
          <span className="inline-flex items-center gap-1.5 text-sm text-ok">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            Cambios guardados.
          </span>
        )}
      </div>
    </div>
  );
}

function Campo({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}
