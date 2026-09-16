import { Settings, User } from "lucide-react";
import { requirePerfilConteo } from "@/lib/dal";

// Igual que el resto de (app): depende de sesión, nunca estático.
export const dynamic = "force-dynamic";

// Placeholder a propósito, igual que /productos. Lo único real que muestra
// hoy es quién está logueado; "Cerrar conteo" se quedó en la pantalla de
// conteo (abajo de "Confirmar y seguir"), no se movió acá.
export default async function ConfiguracionPage() {
  const perfil = await requirePerfilConteo();

  return (
    <div className="flex flex-1 flex-col gap-4 bg-surface-2 p-4 text-strong">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Configuración</h1>
        <p className="mt-1 text-sm text-soft">Ajustes de la app y de la sesión</p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-line-light bg-surface p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-mint text-brand">
          <User size={18} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-soft">Sesión</p>
          <p className="truncate text-sm font-semibold">{perfil.nombre}</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 rounded-lg border border-line-light bg-surface px-6 py-12 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-surface-mint text-brand">
          <Settings size={26} aria-hidden />
        </span>
        <p className="text-base font-semibold">Próximamente</p>
        <p className="max-w-xs text-sm text-soft">
          Acá van a ir las preferencias del lector, los sonidos y el manejo del catálogo offline.
          Todavía está en construcción.
        </p>
      </div>
    </div>
  );
}
