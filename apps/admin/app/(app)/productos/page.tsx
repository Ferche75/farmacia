import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { VENCIMIENTO_SEMAFORO_DEFAULT } from "@farmacia/db";
import { calculadoraPreciosDesdeConfig } from "@/lib/calculadora-precios";
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
  const configRaw = (empresaConfig?.config as Record<string, unknown> | null) ?? {};
  const semaforoRaw = configRaw.vencimiento_semaforo as
    | { rojo_dias?: number; amarillo_dias?: number; verde_dias?: number }
    | undefined;
  const umbral = {
    rojoDias: semaforoRaw?.rojo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.rojoDias,
    amarilloDias: semaforoRaw?.amarillo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.amarilloDias,
    verdeDias: semaforoRaw?.verde_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.verdeDias,
  };

  // Reglas de sugerencia de precio_blister/precio_unidad, por
  // presentación — ver /configuracion (CalculadoraPrecios) y
  // apps/admin/lib/calculadora-precios.ts.
  const calculadoraPrecios = calculadoraPreciosDesdeConfig(configRaw);

  return (
    <ProductosAbm
      empresaId={perfil.empresaId}
      umbralVencimiento={umbral}
      calculadoraPrecios={calculadoraPrecios}
    />
  );
}
