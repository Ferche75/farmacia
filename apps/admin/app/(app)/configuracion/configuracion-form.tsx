"use client";

import { useState } from "react";
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
    <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-6">
      {error && (
        <p className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
      )}
      {guardado && (
        <p className="rounded-md border border-ok/20 bg-ok-soft px-3 py-2 text-sm text-ok">Guardado.</p>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-ink">Nombre *</label>
        <input value={nombre} onChange={(e) => setNombre(e.target.value)} required className="input" />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-ink">Teléfono</label>
        <input value={telefono} onChange={(e) => setTelefono(e.target.value)} className="input" />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-ink">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-ink">Dirección</label>
        <input value={direccion} onChange={(e) => setDireccion(e.target.value)} className="input" />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-ink">Ciudad</label>
        <input value={ciudad} onChange={(e) => setCiudad(e.target.value)} className="input" />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-ink">Contacto de emergencia — nombre</label>
        <input
          value={contactoEmergenciaNombre}
          onChange={(e) => setContactoEmergenciaNombre(e.target.value)}
          className="input"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-ink">Contacto de emergencia — teléfono</label>
        <input
          value={contactoEmergenciaTelefono}
          onChange={(e) => setContactoEmergenciaTelefono(e.target.value)}
          className="input"
        />
      </div>

      <button
        onClick={guardar}
        disabled={guardando || !nombre.trim()}
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {guardando ? "Guardando…" : "Guardar"}
      </button>
    </div>
  );
}
