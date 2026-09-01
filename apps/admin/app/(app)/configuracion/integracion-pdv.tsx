"use client";

import { useState } from "react";
import {
  createBrowserClient,
  generarCodigoInvitacionPdv,
  type CodigoInvitacionPdv,
} from "@farmacia/db";

export interface EstadoIntegracionPdv {
  vinculado: boolean;
  tenantIdPdvlat: string | null;
  vinculadoAt: string | null;
  codigoInvitacion: string | null;
  codigoExpiraAt: string | null;
}

function formatearFecha(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  // DD/MM/AAAA HH:mm (CONTEXTO.md — formato de fecha del proyecto).
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** El código se guarda sin guiones; se muestra en grupos de 4 nada más
 * que para que sea dictable por teléfono sin perder la cuenta. */
function formatearCodigo(codigo: string): string {
  return codigo.replace(/(.{4})(?=.)/g, "$1-");
}

export function IntegracionPdv({ estado: estadoInicial }: { estado: EstadoIntegracionPdv }) {
  const [estado, setEstado] = useState(estadoInicial);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vencido =
    estado.codigoExpiraAt !== null && new Date(estado.codigoExpiraAt) <= new Date();
  const codigoVigente = estado.codigoInvitacion && !vencido ? estado.codigoInvitacion : null;

  async function generar() {
    setGenerando(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const resultado: CodigoInvitacionPdv = await generarCodigoInvitacionPdv(supabase);
      setEstado({
        vinculado: resultado.vinculado,
        tenantIdPdvlat: resultado.tenant_id_pdvlat,
        vinculadoAt: estado.vinculadoAt,
        codigoInvitacion: resultado.codigo_invitacion,
        codigoExpiraAt: resultado.codigo_expira_at,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo generar el código.");
    } finally {
      setGenerando(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Estado</h3>
      <p className="mt-3 text-sm text-ink">
        {estado.vinculado ? (
          <>
            Vinculado
            {estado.tenantIdPdvlat ? (
              <>
                {" "}
                con el punto de venta <span className="font-medium">{estado.tenantIdPdvlat}</span>
              </>
            ) : null}
            {estado.vinculadoAt ? ` desde el ${formatearFecha(estado.vinculadoAt)}` : ""}.
          </>
        ) : (
          "Todavía no hay ningún punto de venta vinculado."
        )}
      </p>

      {codigoVigente ? (
        <div className="mt-5 rounded-md border border-line bg-paper px-4 py-3">
          <p className="text-xs font-medium text-muted">Código de vinculación</p>
          <p className="mt-1 font-mono text-xl tracking-widest text-ink">
            {formatearCodigo(codigoVigente)}
          </p>
          <p className="mt-2 text-xs text-muted">
            Dictáselo a quien configura el punto de venta. Vence el{" "}
            {formatearFecha(estado.codigoExpiraAt)} y sirve una sola vez.
          </p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={generar}
        disabled={generando}
        className="mt-5 rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {generando
          ? "Generando…"
          : codigoVigente
            ? "Generar otro código"
            : "Generar código de vinculación"}
      </button>

      {error ? (
        <p className="mt-2.5 text-sm text-danger">{error}</p>
      ) : (
        <p className="mt-2.5 text-xs text-muted">
          Generar un código nuevo anula el anterior, pero no corta la integración que ya esté
          andando: eso recién pasa cuando alguien canjea el código nuevo.
        </p>
      )}
    </div>
  );
}
