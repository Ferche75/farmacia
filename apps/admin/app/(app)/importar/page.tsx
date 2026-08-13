import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { Importador } from "./importador";

export const dynamic = "force-dynamic";

export default async function ImportarPage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  const { data: sucursales, error } = await supabase
    .from("sucursales")
    .select("id, nombre")
    .eq("empresa_id", perfil.empresaId)
    .eq("activo", true)
    .order("nombre");

  if (error) throw new Error(`No se pudieron cargar las sucursales: ${error.message}`);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Importar catálogo</h1>
      <p className="mb-6 text-sm text-muted">
        Elegí la sucursal, subí el archivo, mapeá sus columnas y revisá el resumen antes de confirmar. Nada se escribe hasta que confirmás.
      </p>
      <Importador empresaId={perfil.empresaId} sucursales={sucursales ?? []} />
    </div>
  );
}
