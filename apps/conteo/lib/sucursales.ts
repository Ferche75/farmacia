import "server-only";

import { createServerClient, type PerfilActual } from "@farmacia/db/server";

export interface SucursalOpcion {
  id: string;
  nombre: string;
}

/** Para operario: solo las sucursales asignadas en perfiles_sucursal. Para
 * el resto (admin/gerente/superadmin cuando cuentan en el piso): todas las
 * de la empresa — tengo_acceso_sucursal() en la base ya les da acceso a
 * todas, esto solo refleja lo mismo en la lista que se muestra. */
export async function listarSucursalesAccesibles(perfil: PerfilActual): Promise<SucursalOpcion[]> {
  const supabase = await createServerClient();

  if (perfil.rol === "operario") {
    const { data } = await supabase
      .from("perfiles_sucursal")
      .select("sucursales(id, nombre)")
      .eq("perfil_id", perfil.id);

    return ((data ?? []) as unknown as { sucursales: SucursalOpcion | null }[])
      .map((r) => r.sucursales)
      .filter((s): s is SucursalOpcion => s !== null);
  }

  const { data } = await supabase.from("sucursales").select("id, nombre").eq("activo", true);
  return (data ?? []) as SucursalOpcion[];
}
