import { requirePerfilAdmin } from "@/lib/dal";
import { ProductosAbm } from "./productos-abm";

export const dynamic = "force-dynamic";

export default async function ProductosPage() {
  const perfil = await requirePerfilAdmin();

  return <ProductosAbm empresaId={perfil.empresaId} />;
}
