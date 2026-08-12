import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/dal";
import { createServerClient, createServiceRoleClient } from "@farmacia/db/server";
import { EmpresaDetalle } from "./empresa-detalle";

export const dynamic = "force-dynamic";

export default async function SuperadminEmpresaPage({
  params,
}: {
  params: Promise<{ empresaId: string }>;
}) {
  const { empresaId } = await params;
  await requireSuperadmin();
  const supabase = await createServerClient();

  const { data: empresa, error: errorEmpresa } = await supabase
    .from("empresas")
    .select(
      "id, nombre, nit, pais, telefono, email, direccion, ciudad, contacto_emergencia_nombre, contacto_emergencia_telefono, activo, config"
    )
    .eq("id", empresaId)
    .maybeSingle();

  // No confundir "no existe esta empresa" (404, esperable si alguien pega
  // un id viejo) con "la consulta falló" (columna faltante, RLS mal
  // configurado, etc.) — antes se tragaban los dos casos igual y una
  // migración sin aplicar se veía como un simple 404, sin pista de la
  // causa real.
  if (errorEmpresa) throw new Error(`No se pudo cargar la empresa: ${errorEmpresa.message}`);
  if (!empresa) notFound();

  const [{ data: sucursales }, { data: perfiles }, { data: bodegas }] = await Promise.all([
    supabase.from("sucursales").select("id, nombre, direccion, activo").eq("empresa_id", empresaId).order("nombre"),
    supabase.from("perfiles").select("id, nombre, rol, activo").eq("empresa_id", empresaId).order("nombre"),
    supabase.from("bodegas").select("id, sucursal_id, nombre, activo").eq("empresa_id", empresaId).order("nombre"),
  ]);

  const perfilIds = (perfiles ?? []).map((p) => p.id);
  const { data: perfilesSucursal } = perfilIds.length
    ? await supabase.from("perfiles_sucursal").select("perfil_id, sucursal_id").in("perfil_id", perfilIds)
    : { data: [] };

  // El email vive en auth.users, no en perfiles — solo accesible con la
  // service_role key (Admin API), nunca vía PostgREST/RLS. Se pide acá,
  // ya del lado del servidor, después de confirmar que quien mira esta
  // pantalla es superadmin.
  const admin = createServiceRoleClient();
  const emailPorId = new Map<string, string>();
  await Promise.all(
    (perfiles ?? []).map(async (p) => {
      const { data } = await admin.auth.admin.getUserById(p.id);
      if (data.user?.email) emailPorId.set(p.id, data.user.email);
    })
  );

  const sucursalIdsPorPerfil = new Map<string, string[]>();
  for (const ps of perfilesSucursal ?? []) {
    const arr = sucursalIdsPorPerfil.get(ps.perfil_id) ?? [];
    arr.push(ps.sucursal_id);
    sucursalIdsPorPerfil.set(ps.perfil_id, arr);
  }

  return (
    <EmpresaDetalle
      empresa={empresa}
      sucursales={sucursales ?? []}
      bodegas={bodegas ?? []}
      usuarios={(perfiles ?? []).map((p) => ({
        ...p,
        email: emailPorId.get(p.id) ?? "—",
        sucursalIds: sucursalIdsPorPerfil.get(p.id) ?? [],
      }))}
    />
  );
}
