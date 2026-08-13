import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { ConfiguracionForm } from "./configuracion-form";
import { SucursalesBodegas } from "./sucursales-bodegas";

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
    .select("nombre, telefono, email, direccion, ciudad, contacto_emergencia_nombre, contacto_emergencia_telefono")
    .eq("id", perfil.empresaId)
    .single();

  if (error) throw new Error(`No se pudo cargar la empresa: ${error.message}`);

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
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <ConfiguracionForm empresa={empresa} />
        <SucursalesBodegas empresaId={perfil.empresaId} sucursales={sucursales ?? []} bodegas={bodegas ?? []} />
      </div>
    </div>
  );
}
