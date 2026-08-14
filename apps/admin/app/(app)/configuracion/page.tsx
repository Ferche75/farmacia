import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { VENCIMIENTO_SEMAFORO_DEFAULT, type ConfigOperativaEmpresa, type CampoPersonalizado } from "@farmacia/db";
import { ConfiguracionForm } from "./configuracion-form";
import { SucursalesBodegas } from "./sucursales-bodegas";
import { ConfigOperativa } from "./config-operativa";
import { CamposPersonalizados } from "./campos-personalizados";

export const dynamic = "force-dynamic";

export default async function ConfiguracionPage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  // Mismo criterio que las demás páginas de esta app: desestructurar
  // también `error` y tirar si existe, en vez de tratar cualquier falla
  // como si la fila no existiera (ver docs/decisiones.md, auditoría
  // 2026-08-09).
  const { data: empresa, error } = await supabase
    .from("empresas")
    .select(
      "nombre, telefono, email, direccion, ciudad, contacto_emergencia_nombre, contacto_emergencia_telefono, config"
    )
    .eq("id", perfil.empresaId)
    .single();

  if (error) throw new Error(`No se pudo cargar la empresa: ${error.message}`);

  // `config` es jsonb libre — las claves que nos importan pueden no
  // existir todavía (empresa que nunca guardó esta sección), de ahí los
  // fallbacks. Ver actualizar_config_operativa_empresa (RPC) para el
  // shape que se guarda.
  const configRaw = (empresa.config ?? {}) as Record<string, unknown>;
  const semaforoRaw = configRaw.vencimiento_semaforo as
    | { rojo_dias?: number; amarillo_dias?: number; verde_dias?: number }
    | undefined;
  const configOperativa: ConfigOperativaEmpresa = {
    camposRequeridosImportacion: Array.isArray(configRaw.campos_requeridos_importacion)
      ? (configRaw.campos_requeridos_importacion as string[])
      : [],
    vencimientoSemaforo: {
      rojoDias: semaforoRaw?.rojo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.rojoDias,
      amarilloDias: semaforoRaw?.amarillo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.amarilloDias,
      verdeDias: semaforoRaw?.verde_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.verdeDias,
    },
  };
  const camposPersonalizados: CampoPersonalizado[] = Array.isArray(configRaw.campos_personalizados)
    ? (configRaw.campos_personalizados as CampoPersonalizado[])
    : [];

  const { data: sucursales, error: errorSucursales } = await supabase
    .from("sucursales")
    .select("id, nombre, direccion, activo")
    .eq("empresa_id", perfil.empresaId)
    .order("nombre");

  if (errorSucursales) throw new Error(`No se pudieron cargar las sucursales: ${errorSucursales.message}`);

  const { data: bodegas, error: errorBodegas } = await supabase
    .from("bodegas")
    .select("id, sucursal_id, nombre, activo")
    .eq("empresa_id", perfil.empresaId)
    .order("nombre");

  if (errorBodegas) throw new Error(`No se pudieron cargar las bodegas: ${errorBodegas.message}`);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Mi empresa</h1>
      <p className="mb-6 text-sm text-muted">
        Datos de contacto, sucursales y bodegas de tu empresa. Para NIT, país o usuarios, pedile al superadmin.
      </p>
      <div className="max-w-3xl space-y-8">
        <ConfiguracionForm empresa={empresa} />
        <SucursalesBodegas empresaId={perfil.empresaId} sucursales={sucursales ?? []} bodegas={bodegas ?? []} />
        <ConfigOperativa config={configOperativa} />
        <CamposPersonalizados campos={camposPersonalizados} />
      </div>
    </div>
  );
}
