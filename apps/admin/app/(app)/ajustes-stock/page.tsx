import { requirePerfilAdmin } from "@/lib/dal";
import { AjustesStock } from "./ajustes-stock";

export const dynamic = "force-dynamic";

export default async function AjustesStockPage() {
  const perfil = await requirePerfilAdmin();
  return <AjustesStock empresaId={perfil.empresaId} />;
}
