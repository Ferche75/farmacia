import { notFound } from "next/navigation";
import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { DetalleConteo } from "./detalle-conteo";

export const dynamic = "force-dynamic";

export default async function ConteoDetallePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  const { data: conteo, error: errorConteo } = await supabase
    .from("conteos")
    .select("id, nombre, estado, iniciado_at, cerrado_at, sucursales(nombre)")
    .eq("id", id)
    .maybeSingle();

  // Distinguir "no existe" (404 real) de "la consulta falló" — ver el
  // mismo fix en superadmin/[empresaId]/page.tsx para el porqué.
  if (errorConteo) throw new Error(`No se pudo cargar el conteo: ${errorConteo.message}`);
  if (!conteo) notFound();

  return (
    <DetalleConteo
      conteoId={conteo.id}
      nombre={conteo.nombre}
      estado={conteo.estado}
      sucursalNombre={(conteo.sucursales as unknown as { nombre: string } | null)?.nombre ?? "—"}
      rol={perfil.rol}
    />
  );
}
