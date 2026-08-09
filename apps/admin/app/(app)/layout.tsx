import { requirePerfilAdmin } from "@/lib/dal";
import { NavAdmin } from "@/components/nav-admin";

// Todo lo que cuelga de este layout depende de la sesión del usuario —
// nunca debe prerenderizarse estático ni cachearse entre usuarios.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const perfil = await requirePerfilAdmin();

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <NavAdmin rol={perfil.rol} nombre={perfil.nombre} />
      <main className="flex-1 px-10 py-8">{children}</main>
      <footer className="flex items-center justify-between border-t border-line px-10 py-4 text-xs text-muted">
        <span>© {new Date().getFullYear()} Farmacia Admin. Todos los derechos reservados.</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-bright" />
          Sistema operativo
        </span>
      </footer>
    </div>
  );
}
