import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { ListaConteos } from "./lista-conteos";

export const dynamic = "force-dynamic";

export default async function ConteosPage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  const { data: conteos } = await supabase
    .from("conteos")
    .select("id, nombre, estado, iniciado_at, cerrado_at, sucursal_id, sucursales(nombre), bodegas(nombre)")
    .order("iniciado_at", { ascending: false });

  // Esta lista es la puerta de entrada: el admin tiene que poder ver de un
  // vistazo cuál conteo tiene un celular con cosas trabadas, sin abrir uno
  // por uno. UNA sola consulta agregada para toda la tabla, no una por
  // fila. Solo trae los dispositivos que tienen algo trabado — los que
  // están al día no aportan nada acá.
  const idsConteos = (conteos ?? []).map((c) => c.id);
  const { data: dispositivosTrabados } = idsConteos.length
    ? await supabase
        .from("conteo_dispositivos_estado")
        .select("conteo_id")
        .in("conteo_id", idsConteos)
        .or("pendientes.gt.0,fallados.gt.0")
    : { data: [] };

  const trabadosPorConteo = new Map<string, number>();
  for (const d of dispositivosTrabados ?? []) {
    trabadosPorConteo.set(d.conteo_id, (trabadosPorConteo.get(d.conteo_id) ?? 0) + 1);
  }

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
          bodegaNombre: (c.bodegas as unknown as { nombre: string } | null)?.nombre ?? null,
          dispositivosTrabados: trabadosPorConteo.get(c.id) ?? 0,
        }))}
      />
    </div>
  );
}
