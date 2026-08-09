import "server-only";

import { redirect } from "next/navigation";
import { getPerfilActual, type PerfilActual } from "@farmacia/db/server";

// Cualquier rol activo puede entrar a apps/conteo (operarios cuentan;
// admin/gerente también cuentan cuando están en el piso).
export async function requirePerfilConteo(): Promise<PerfilActual> {
  const perfil = await getPerfilActual();

  if (!perfil) {
    redirect("/login");
  }

  return perfil;
}
