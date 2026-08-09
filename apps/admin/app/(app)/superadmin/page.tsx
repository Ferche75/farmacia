import { requireSuperadmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { EmpresasAbm } from "./empresas-abm";

export const dynamic = "force-dynamic";

export default async function SuperadminPage() {
  await requireSuperadmin();
  const supabase = await createServerClient();

  const { data: empresas } = await supabase
    .from("empresas")
    .select("id, nombre, nit, pais, activo, created_at")
    .order("created_at", { ascending: false });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Superadmin</h1>
      <p className="mb-6 text-sm text-muted">
        Empresas del sistema. Entrá a una para gestionar sus sucursales y usuarios.
      </p>
      <EmpresasAbm empresas={empresas ?? []} />
    </div>
  );
}
