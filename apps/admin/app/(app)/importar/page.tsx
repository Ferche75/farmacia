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

  // Campos obligatorios configurables por empresa, ver /configuracion —
  // "nombre" siempre es obligatorio aparte de esto (Importador lo suma).
  const { data: empresaConfig } = await supabase
    .from("empresas")
    .select("config")
    .eq("id", perfil.empresaId)
    .single();
  const configRaw = (empresaConfig?.config ?? {}) as Record<string, unknown>;
  const camposRequeridos = Array.isArray(configRaw.campos_requeridos_importacion)
    ? (configRaw.campos_requeridos_importacion as string[])
    : [];

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Importar catálogo</h1>
      <p className="mb-6 text-sm text-muted">
        Elegí la sucursal, subí el archivo, mapeá sus columnas y revisá el resumen antes de confirmar. Nada se escribe hasta que confirmás.
      </p>
      <Importador empresaId={perfil.empresaId} sucursales={sucursales ?? []} camposRequeridos={camposRequeridos} />
    </div>
  );
}
