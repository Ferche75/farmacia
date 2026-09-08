import Link from "next/link";
import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import type { FilaRechazadaImportacion } from "@farmacia/db";
import { HistorialImportaciones } from "./historial-importaciones";

export const dynamic = "force-dynamic";

// El popup de "Importación completa" muestra el detalle de los rechazos
// una sola vez: se cierra y no vuelve. Peor todavía, si el que importó no
// era el que iba a corregir la planilla, nadie llegó a verlo. Esta
// pantalla lee el mismo detalle de importaciones.log, que la base viene
// guardando desde siempre — no hay dato nuevo acá, solo una forma de
// volver a mirarlo.

export default async function HistorialImportacionesPage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from("importaciones")
    .select("id, archivo, filas_ok, filas_error, estado, log, created_at, creado_por, perfiles(nombre)")
    .eq("empresa_id", perfil.empresaId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`No se pudo cargar el historial de importaciones: ${error.message}`);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Historial de importaciones</h1>
      <p className="mb-6 text-sm text-muted">
        Cada archivo que se importó, quién lo subió y qué filas quedaron afuera.{" "}
        <Link href="/importar" className="font-medium text-brand hover:underline">
          Volver a importar
        </Link>
      </p>

      <HistorialImportaciones
        importaciones={(data ?? []).map((i) => ({
          id: i.id,
          archivo: i.archivo,
          filasOk: i.filas_ok,
          filasError: i.filas_error,
          estado: i.estado,
          createdAt: i.created_at,
          autorNombre: (i.perfiles as unknown as { nombre: string } | null)?.nombre ?? null,
          // `log` es jsonb: puede venir null (importación que nunca
          // rechazó nada) o un arreglo. Se normaliza acá para que el
          // cliente no tenga que defenderse de la forma cruda.
          log: Array.isArray(i.log) ? (i.log as unknown as FilaRechazadaImportacion[]) : [],
        }))}
      />
    </div>
  );
}
