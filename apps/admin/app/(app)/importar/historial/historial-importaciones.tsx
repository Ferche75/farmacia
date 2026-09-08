"use client";

import { Fragment, useState } from "react";
import type { FilaRechazadaImportacion } from "@farmacia/db";
// Las MISMAS funciones que usa el popup de importador.tsx: sobre el mismo
// log tienen que decir exactamente lo mismo, en vivo o meses después.
import { textoMotivo, identificadorFila } from "@/lib/motivos-rechazo-importacion";

export interface ImportacionFila {
  id: string;
  archivo: string;
  filasOk: number;
  filasError: number;
  estado: string;
  createdAt: string;
  autorNombre: string | null;
  /** Ya normalizado a arreglo por la page (jsonb puede venir null). */
  log: FilaRechazadaImportacion[];
}

export function HistorialImportaciones({ importaciones }: { importaciones: ImportacionFila[] }) {
  // Cuáles filas tienen el detalle abierto. Varias a la vez: comparar dos
  // importaciones del mismo archivo es justo el caso de uso.
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());

  function alternar(id: string) {
    setAbiertas((prev) => {
      const nuevo = new Set(prev);
      if (nuevo.has(id)) nuevo.delete(id);
      else nuevo.add(id);
      return nuevo;
    });
  }

  if (importaciones.length === 0) {
    return <p className="text-sm text-muted">Todavía no se importó ningún archivo.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="px-4 py-2.5 font-medium">Fecha</th>
            <th className="px-4 py-2.5 font-medium">Archivo</th>
            <th className="px-4 py-2.5 font-medium">Quién</th>
            <th className="px-4 py-2.5 font-medium">Importadas</th>
            <th className="px-4 py-2.5 font-medium">Rechazadas</th>
            <th className="px-4 py-2.5 font-medium">Estado</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {importaciones.map((i) => {
            const abierta = abiertas.has(i.id);
            return (
              // La fila de detalle es un <tr> hermano, no un div adentro
              // de la celda: así las columnas de arriba no se desalinean
              // al abrirlo.
              <Fragment key={i.id}>
                <tr className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-4 py-2.5 text-muted">
                    {new Date(i.createdAt).toLocaleString("es-BO")}
                  </td>
                  <td className="px-4 py-2.5 text-ink">{i.archivo}</td>
                  <td className="px-4 py-2.5 text-muted">{i.autorNombre ?? "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-muted">{i.filasOk}</td>
                  <td
                    className={`px-4 py-2.5 font-mono ${i.filasError > 0 ? "font-semibold text-danger" : "text-muted"}`}
                  >
                    {i.filasError}
                  </td>
                  <td className="px-4 py-2.5">
                    {i.estado === "completado" ? (
                      <span className="inline-flex items-center gap-1.5 text-ok">
                        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                        completado
                      </span>
                    ) : i.estado === "error" ? (
                      <span className="inline-flex items-center gap-1.5 text-danger">
                        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                        {i.estado}
                      </span>
                    ) : (
                      // "pendiente"/"procesando": la importación se cortó a
                      // mitad de camino (se cerró la pestaña, se cayó la
                      // conexión). Lo que ya se había escrito quedó escrito.
                      <span className="inline-flex items-center gap-1.5 text-warn">
                        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                        {i.estado}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {/* Solo cuando hay algo que mirar: una importación sin
                        rechazos no ofrece un detalle vacío. */}
                    {i.filasError > 0 && (
                      <button
                        type="button"
                        onClick={() => alternar(i.id)}
                        className="font-medium text-brand hover:underline"
                      >
                        {abierta ? "Ocultar detalle" : "Ver detalle"}
                      </button>
                    )}
                  </td>
                </tr>
                {abierta && (
                  <tr className="border-b border-line last:border-0 bg-paper">
                    <td colSpan={7} className="px-4 py-3">
                      <p className="mb-2 text-sm font-medium text-ink">
                        Filas que no se importaron ({i.log.length})
                      </p>
                      {i.log.length === 0 ? (
                        // Defensivo. En teoría no pasa: importaciones.log se
                        // viene escribiendo lote a lote desde la primera
                        // versión del RPC (20260806000004), así que toda
                        // importación con filas_error > 0 tiene su detalle.
                        <p className="text-xs text-muted">
                          Esta importación no guardó el detalle de sus rechazos.
                        </p>
                      ) : (
                        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line bg-surface">
                          {i.log.map((f, idx) => (
                            <li key={`${f.motivo}-${identificadorFila(f)}-${idx}`} className="px-3 py-2">
                              <p className="font-mono text-sm text-ink">{identificadorFila(f)}</p>
                              <p className="mt-0.5 text-xs text-muted">{textoMotivo(f.motivo)}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-xs text-muted">
                        El resto del archivo sí se importó. Corregí estas filas y volvé a importar solo ellas.
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
