import { Package } from "lucide-react";
import { requirePerfilConteo } from "@/lib/dal";

// Igual que el resto de (app): depende de sesión, nunca estático.
export const dynamic = "force-dynamic";

// Placeholder a propósito. El catálogo ya está en IndexedDB (db.catalogo)
// así que la versión real de esta pantalla se puede armar 100% offline,
// pero eso es trabajo aparte — acá va solo el lugar donde va a vivir.
export default async function ProductosPage() {
  await requirePerfilConteo();

  return (
    <div className="flex flex-1 flex-col bg-surface-2 p-4 text-strong">
      <h1 className="text-xl font-bold tracking-tight">Productos</h1>
      <p className="mt-1 text-sm text-soft">Catálogo de la sucursal</p>

      <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-line-light bg-surface px-6 py-12 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-surface-mint text-brand">
          <Package size={26} aria-hidden />
        </span>
        <p className="text-base font-semibold">Próximamente</p>
        <p className="max-w-xs text-sm text-soft">
          Acá vas a poder buscar cualquier producto del catálogo y ver qué se contó de cada uno.
          Todavía está en construcción.
        </p>
      </div>
    </div>
  );
}
