import { requirePerfilConteo } from "@/lib/dal";
import { listarSucursalesAccesibles } from "@/lib/sucursales";
import { ConteoApp } from "./conteo-app";

export default async function HomePage() {
  const perfil = await requirePerfilConteo();
  const sucursales = await listarSucursalesAccesibles(perfil);

  return (
    <ConteoApp
      perfilId={perfil.id}
      empresaId={perfil.empresaId}
      sucursales={sucursales}
    />
  );
}
