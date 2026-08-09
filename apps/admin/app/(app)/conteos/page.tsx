import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { ListaConteos } from "./lista-conteos";

export const dynamic = "force-dynamic";

export default async function ConteosPage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  const { data: conteos } = await supabase
    .from("conteos")
    .select("id, nombre, estado, iniciado_at, cerrado_at, sucursal_id, sucursales(nombre)")
    .order("iniciado_at", { ascending: false });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Conteos</h1>
      <p className="mb-6 text-sm text-muted">
        Cerrar un conteo lo deja de solo lectura.
        {perfil.rol !== "admin" && " El resumen gerencial está adentro de cada uno."}
      </p>
      <ListaConteos
        conteos={(conteos ?? []).map((c) => ({
          id: c.id,
          nombre: c.nombre,
          estado: c.estado,
          iniciadoAt: c.iniciado_at,
          cerradoAt: c.cerrado_at,
          sucursalNombre: (c.sucursales as unknown as { nombre: string } | null)?.nombre ?? "—",
        }))}
      />
    </div>
  );
}
