import { requirePerfilAdmin } from "@/lib/dal";
import { Bandeja } from "./bandeja";

export const dynamic = "force-dynamic";

export default async function DesconocidosPage() {
  const perfil = await requirePerfilAdmin();

  return (
    <div className="flex h-[calc(100vh-11rem)] flex-col">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Bandeja de revisión</h1>
        <p className="text-sm text-muted">
          Códigos escaneados que no estaban en el catálogo. Vinculalos a un producto existente o creá uno nuevo.
        </p>
      </div>
      <Bandeja empresaId={perfil.empresaId} />
    </div>
  );
}
