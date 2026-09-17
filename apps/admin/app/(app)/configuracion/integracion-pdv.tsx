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
  /** null solo en integraciones anteriores a 20260907000000. */
  sucursalId: string | null;
  bodegaId: string | null;
  /** Última vez que pdvlat autenticó una llamada real con esta credencial
   * (20260926000000) — no cuándo se canjeó el código. Null = el código se
   * canjeó pero todavía no llegó ninguna llamada real. Es la confirmación
   * CRUZADA de que la vinculación está viva de los dos lados, no solo un
   * flag que puso Farmacia una vez. */
  ultimaActividadAt: string | null;
}

interface SucursalOpcion {
  id: string;
  nombre: string;
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

export function IntegracionPdv({
  estado: estadoInicial,
  sucursales,
}: {
  estado: EstadoIntegracionPdv;
  sucursales: SucursalOpcion[];
}) {
  const [estado, setEstado] = useState(estadoInicial);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vencido =
    estado.codigoExpiraAt !== null && new Date(estado.codigoExpiraAt) <= new Date();
  const codigoVigente = estado.codigoInvitacion && !vencido ? estado.codigoInvitacion : null;

  // Pedido explícito del usuario: nada de elegir sucursal en esta pantalla,
  // ni "opciones avanzadas". El destino por defecto se resuelve solo,
  // puertas adentro, con la primera sucursal activa — la persona que
  // genera el código no lo ve ni lo elige. Quién vende contra qué sucursal
  // se reparte después, del lado de pdvlat (ver la descripción de la
  // sección). El RPC igual exige una sucursal (no hay a dónde descontar
  // stock sin ninguna), así que el botón ni se muestra si `sucursales` está
  // vacío — ver más abajo.
  async function generar() {
    const primeraSucursal = sucursales[0];
    if (!primeraSucursal) return;

    setGenerando(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const resultado: CodigoInvitacionPdv = await generarCodigoInvitacionPdv(supabase, {
        sucursalId: primeraSucursal.id,
        bodegaId: null,
      });
      setEstado({
        vinculado: resultado.vinculado,
        tenantIdPdvlat: resultado.tenant_id_pdvlat,
        vinculadoAt: estado.vinculadoAt,
        codigoInvitacion: resultado.codigo_invitacion,
        codigoExpiraAt: resultado.codigo_expira_at,
        sucursalId: resultado.sucursal_id,
        bodegaId: resultado.bodega_id,
        // El RPC de generar código no toca esto (solo autenticarPdv lo
        // hace, en una llamada real de pdvlat) — se preserva tal cual
        // estaba, igual que vinculadoAt.
        ultimaActividadAt: estado.ultimaActividadAt,
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

      {/* Confirmación CRUZADA (20260926000000): "Vinculado" de arriba solo
          dice que alguien canjeó un código alguna vez — esto dice si
          pdvlat está usando de verdad la credencial. Un punto verde con
          fecha reciente es la única prueba real de que los dos lados están
          hablando; sin actividad todavía es una señal legítima de que algo
          quedó mal configurado del otro lado. */}
      {estado.vinculado ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
          {estado.ultimaActividadAt ? (
            <>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
              pdvlat contactó por última vez el{" "}
              <span className="font-medium text-ink">{formatearFecha(estado.ultimaActividadAt)}</span>.
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" aria-hidden />
              Todavía no recibimos ninguna llamada de pdvlat con esta credencial.
            </>
          )}
        </p>
      ) : null}

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

      {sucursales.length === 0 ? (
        <p className="mt-5 text-sm text-muted">
          Creá una sucursal activa antes de conectar el punto de venta: sin ella no hay a dónde
          descontar el stock.
        </p>
      ) : (
        <button
          type="button"
          onClick={generar}
          disabled={generando}
          className="mt-5 rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {generando
            ? "Generando…"
            : codigoVigente
              ? "Generar otro código de vinculación con pdvlat"
              : "Generar código de vinculación con pdvlat"}
        </button>
      )}

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
