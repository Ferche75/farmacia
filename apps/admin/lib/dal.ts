import "server-only";

import { redirect } from "next/navigation";
import {
  createServerClient,
  getPerfilActual,
  type PerfilActual,
} from "@farmacia/db/server";

// Defensa en profundidad: el login ya rechaza a los operarios antes de
// crear sesión en esta app, pero cualquier página protegida vuelve a
// verificar acá por si en el futuro las apps comparten cookie de sesión
// (mismo dominio raíz en producción).
export async function requirePerfilAdmin(): Promise<PerfilActual> {
  const perfil = await getPerfilActual();

  if (!perfil) {
    redirect("/login");
  }

  if (perfil.rol === "operario") {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    redirect("/login?error=rol_operario");
  }

  return perfil;
}

// El panel de superadmin (Fase 7) es el único rincón de la app que
// necesita más que "no ser operario" — acá si hace falta el rol exacto.
export async function requireSuperadmin(): Promise<PerfilActual> {
  const perfil = await requirePerfilAdmin();

  if (perfil.rol !== "superadmin") {
    redirect("/");
  }

  return perfil;
}
