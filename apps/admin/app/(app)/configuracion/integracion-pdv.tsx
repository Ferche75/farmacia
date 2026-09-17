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
}

interface SucursalOpcion {
  id: string;
  nombre: string;
}

interface BodegaOpcion {
  id: string;
  sucursal_id: string;
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
  bodegas,
}: {
  estado: EstadoIntegracionPdv;
  sucursales: SucursalOpcion[];
  bodegas: BodegaOpcion[];
}) {
  const [estado, setEstado] = useState(estadoInicial);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nombreSucursal = (id: string | null) =>
    sucursales.find((s) => s.id === id)?.nombre ?? null;
  const nombreBodega = (id: string | null) => bodegas.find((b) => b.id === id)?.nombre ?? null;

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

      {estado.vinculado && nombreSucursal(estado.sucursalId) ? (
        <p className="mt-1.5 text-sm text-muted">
          Descuenta stock de <span className="font-medium text-ink">{nombreSucursal(estado.sucursalId)}</span>
          {nombreBodega(estado.bodegaId) ? (
            <>
              , bodega <span className="font-medium text-ink">{nombreBodega(estado.bodegaId)}</span>
            </>
          ) : null}
          .
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
