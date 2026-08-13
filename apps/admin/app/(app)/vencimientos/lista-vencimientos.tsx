interface LoteFila {
  id: string;
  lote: string | null;
  vencimiento: string;
  cantidad: number;
  sucursalNombre: string;
  bodegaNombre: string | null;
  productoNombre: string;
}

interface UmbralSemaforo {
  rojoDias: number;
  amarilloDias: number;
  verdeDias: number;
}

function diasRestantes(vencimiento: string): number {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fecha = new Date(vencimiento);
  return Math.round((fecha.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
}

function EstadoVencimiento({ dias, umbral }: { dias: number; umbral: UmbralSemaforo }) {
  if (dias < 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
        vencido
      </span>
    );
  }
  if (dias <= umbral.rojoDias) {
    return (
      <span className="inline-flex items-center gap-1.5 text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
        en {dias}d
      </span>
    );
  }
  if (dias <= umbral.amarilloDias) {
    return (
      <span className="inline-flex items-center gap-1.5 text-warn">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
        en {dias}d
      </span>
    );
  }
  if (dias <= umbral.verdeDias) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ok">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        en {dias}d
      </span>
    );
  }
  return <span className="text-muted">en {dias}d</span>;
}

export function ListaVencimientos({ lotes, umbral }: { lotes: LoteFila[]; umbral: UmbralSemaforo }) {
  if (lotes.length === 0) {
    return <p className="text-sm text-muted">Todavía no hay lotes con vencimiento registrado.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="px-4 py-2.5 font-medium">Producto</th>
            <th className="px-4 py-2.5 font-medium">Sucursal</th>
            <th className="px-4 py-2.5 font-medium">Bodega</th>
            <th className="px-4 py-2.5 font-medium">Lote</th>
            <th className="px-4 py-2.5 font-medium">Cantidad</th>
            <th className="px-4 py-2.5 font-medium">Vencimiento</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {lotes.map((l) => (
            <tr key={l.id} className="border-b border-line last:border-0 hover:bg-paper">
              <td className="px-4 py-2.5 text-ink">{l.productoNombre}</td>
              <td className="px-4 py-2.5 text-muted">{l.sucursalNombre}</td>
              <td className="px-4 py-2.5 text-muted">{l.bodegaNombre ?? "—"}</td>
              <td className="px-4 py-2.5 text-muted">{l.lote || "—"}</td>
              <td className="px-4 py-2.5 text-ink">{l.cantidad}</td>
              <td className="px-4 py-2.5 text-muted">{new Date(l.vencimiento).toLocaleDateString("es-BO")}</td>
              <td className="px-4 py-2.5">
                <EstadoVencimiento dias={diasRestantes(l.vencimiento)} umbral={umbral} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
