import { requirePerfilConteo } from "@/lib/dal";
import { logout } from "@/lib/auth-actions";
import { BarraNavegacion } from "./barra-navegacion";

// Ver la misma nota en apps/admin/app/(app)/layout.tsx: depende de sesión,
// nunca estático.
export const dynamic = "force-dynamic";

// Layout mínimo: arriba una barra chica con quién está logueado y salir,
// abajo los tabs (Conteo / Productos / Configuración). La barra de abajo
// solo aparece cuando hay un conteo en curso — ver barra-navegacion.tsx,
// que explica por qué decide eso sola en vez de recibirlo por prop.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const perfil = await requirePerfilConteo();

  return (
    <>
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5 text-sm">
        <span className="font-medium text-muted">{perfil.nombre}</span>
        <form action={logout}>
          <button className="text-muted transition-colors hover:text-paper" type="submit">
            Salir
          </button>
        </form>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
      <BarraNavegacion />
    </>
  );
}
