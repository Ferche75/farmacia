import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { ListaVencimientos } from "./lista-vencimientos";

export const dynamic = "force-dynamic";

export default async function VencimientosPage() {
  await requirePerfilAdmin();
  const supabase = await createServerClient();

  // Se alimenta al cerrar un conteo (cerrar_conteo persiste acá los
  // escaneos que trajeron vencimiento) — ver
  // supabase/migrations/20260812000003_lotes_vencimiento.sql. Filas con
  // cantidad 0 son lotes que se contaron en 0 la última vez, no aportan
  // nada a esta vista.
  const { data: lotes } = await supabase
    .from("lotes")
    .select("id, lote, vencimiento, cantidad, sucursales(nombre), productos(nombre)")
    .gt("cantidad", 0)
    .order("vencimiento", { ascending: true });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Vencimientos</h1>
      <p className="mb-6 text-sm text-muted">
        Stock por lote con fecha de vencimiento conocida, según el último conteo que lo relevó.
      </p>
      <ListaVencimientos
        lotes={(lotes ?? []).map((l) => ({
          id: l.id,
          lote: l.lote,
          vencimiento: l.vencimiento,
          cantidad: l.cantidad,
          sucursalNombre: (l.sucursales as unknown as { nombre: string } | null)?.nombre ?? "—",
          productoNombre: (l.productos as unknown as { nombre: string } | null)?.nombre ?? "—",
        }))}
      />
    </div>
  );
}
