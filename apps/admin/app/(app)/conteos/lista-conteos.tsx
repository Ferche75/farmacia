"use client";

import Link from "next/link";

interface ConteoFila {
  id: string;
  nombre: string;
  estado: string;
  iniciadoAt: string;
  cerradoAt: string | null;
  sucursalNombre: string;
  bodegaNombre: string | null;
}

export function ListaConteos({ conteos }: { conteos: ConteoFila[] }) {
  if (conteos.length === 0) {
    return <p className="text-sm text-muted">Todavía no hay conteos.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="px-4 py-2.5 font-medium">Nombre</th>
            <th className="px-4 py-2.5 font-medium">Sucursal</th>
            <th className="px-4 py-2.5 font-medium">Bodega</th>
            <th className="px-4 py-2.5 font-medium">Estado</th>
            <th className="px-4 py-2.5 font-medium">Iniciado</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {conteos.map((c) => (
            <tr key={c.id} className="border-b border-line last:border-0 hover:bg-paper">
              <td className="px-4 py-2.5 text-ink">{c.nombre}</td>
              <td className="px-4 py-2.5 text-muted">{c.sucursalNombre}</td>
              <td className="px-4 py-2.5 text-muted">{c.bodegaNombre ?? "—"}</td>
              <td className="px-4 py-2.5">
                {c.estado === "abierto" ? (
                  <span className="inline-flex items-center gap-1.5 text-ok">
                    <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                    abierto
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                    cerrado
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-muted">
                {new Date(c.iniciadoAt).toLocaleDateString("es-BO")}
              </td>
              <td className="px-4 py-2.5">
                <Link href={`/conteos/${c.id}`} className="font-medium text-brand hover:underline">
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
