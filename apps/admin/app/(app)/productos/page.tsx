import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { VENCIMIENTO_SEMAFORO_DEFAULT } from "@farmacia/db";
import { ProductosAbm } from "./productos-abm";

export const dynamic = "force-dynamic";

export default async function ProductosPage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  // Umbrales editables por empresa, ver /configuracion — mismo default
  // que usa /vencimientos si todavía no guardaron nada.
  const { data: empresaConfig } = await supabase
    .from("empresas")
    .select("config")
    .eq("id", perfil.empresaId)
    .single();
  const semaforoRaw = (empresaConfig?.config as Record<string, unknown> | null)?.vencimiento_semaforo as
    | { rojo_dias?: number; amarillo_dias?: number; verde_dias?: number }
    | undefined;
  const umbral = {
    rojoDias: semaforoRaw?.rojo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.rojoDias,
    amarilloDias: semaforoRaw?.amarillo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.amarilloDias,
    verdeDias: semaforoRaw?.verde_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.verdeDias,
  };

  return <ProductosAbm empresaId={perfil.empresaId} umbralVencimiento={umbral} />;
}
