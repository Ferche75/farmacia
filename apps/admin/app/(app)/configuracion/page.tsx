import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { ConfiguracionForm } from "./configuracion-form";

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

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Mi empresa</h1>
      <p className="mb-6 text-sm text-muted">
        Datos de contacto de tu empresa. Para NIT, país, sucursales o usuarios, pedile al superadmin.
      </p>
      <ConfiguracionForm empresa={empresa} />
    </div>
  );
}
