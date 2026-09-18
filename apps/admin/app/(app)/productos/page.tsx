import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { VENCIMIENTO_SEMAFORO_DEFAULT, type CalculadoraPreciosEmpresa, type ReglaCalculadoraPrecios } from "@farmacia/db";
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

  // Reglas de sugerencia de precio_blister/precio_unidad — ver
  // /configuracion (CalculadoraPrecios) y apps/admin/lib/calculadora-precios.ts.
  // Cada nivel es independiente y opcional (null = sin regla configurada).
  const calculadoraRaw = configRaw.calculadora_precios as
    | { blister?: ReglaCalculadoraPrecios | null; unidad?: ReglaCalculadoraPrecios | null }
    | undefined;
  const calculadoraPrecios: CalculadoraPreciosEmpresa = {
    blister: calculadoraRaw?.blister ?? null,
    unidad: calculadoraRaw?.unidad ?? null,
  };

  return (
    <ProductosAbm
      empresaId={perfil.empresaId}
      umbralVencimiento={umbral}
      calculadoraPrecios={calculadoraPrecios}
    />
  );
}
