import { requirePerfilAdmin } from "@/lib/dal";
import { Importador } from "./importador";

export const dynamic = "force-dynamic";

export default async function ImportarPage() {
  const perfil = await requirePerfilAdmin();

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Importar catálogo</h1>
      <p className="mb-6 text-sm text-muted">
        Subí el archivo de un laboratorio, mapeá sus columnas y revisá el resumen antes de confirmar. Nada se escribe hasta que confirmás.
      </p>
      <Importador empresaId={perfil.empresaId} />
    </div>
  );
}
