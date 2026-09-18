import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@farmacia/db/server";

// Barrido diario que borra las fotos de altas_manuales_conteo que ya
// pasaron los 7 días — la mitad "se borra sola" de la decisión de
// 20260929000000_log_altas_manuales_conteo.sql. Lo llama n8n una vez por
// día (n8n/flujo-limpieza-fotos-altas.json); no hay cron en la base.
//
// Sin sesión de usuario: se autentica con un secreto compartido y usa la
// service_role key (ignora RLS) para poder ver y borrar las filas de
// TODAS las empresas de una pasada.
//
// DIFERENCIA IMPORTANTE con apps/conteo/app/api/desconocidos/callback-ia:
// ahí el secreto es POR EMPRESA y OPCIONAL (si la empresa no configuró
// ninguno, el callback pasa igual), y está bien porque ese endpoint solo
// puede tocar el desconocido cuyo id le mandaron. Este barre todas las
// empresas y borra archivos, así que el secreto es OBLIGATORIO SIEMPRE: si
// MANTENIMIENTO_SECRET no está en el entorno del server, el endpoint
// rechaza todo con 401 en vez de "dejar pasar porque no hay secreto
// configurado". Un endpoint de borrado masivo desprotegido por olvidarse
// una variable de entorno no es un modo de falla aceptable.

const DIAS_DE_VIDA_DE_LA_FOTO = 7;

export async function POST(request: Request) {
  const secretoEsperado = process.env.MANTENIMIENTO_SECRET;
  if (!secretoEsperado || request.headers.get("X-Mantenimiento-Secret") !== secretoEsperado) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  const vencidasDesde = new Date(
    Date.now() - DIAS_DE_VIDA_DE_LA_FOTO * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: vencidas, error: errorConsulta } = await supabase
    .from("altas_manuales_conteo")
    .select("id, foto_path")
    .not("foto_path", "is", null)
    .lt("creado_at", vencidasDesde);

  if (errorConsulta) {
    return NextResponse.json({ error: errorConsulta.message }, { status: 500 });
  }

  if (!vencidas || vencidas.length === 0) {
    return NextResponse.json({ ok: true, borradas: 0 });
  }

  // Un solo remove con todos los paths: es el mismo bucket para todas las
  // empresas (la separación es por carpeta, empresa_id/conteo_id/), así
  // que no hace falta agrupar por nada.
  const paths = vencidas.map((v) => v.foto_path).filter((p): p is string => p !== null);
  const { error: errorStorage } = await supabase.storage.from("altas-manuales").remove(paths);

  if (errorStorage) {
    // A propósito no se actualiza NINGUNA fila si el remove falló: dejar
    // foto_path en null con el archivo todavía en el bucket lo volvería
    // invisible para el próximo barrido y quedaría ocupando espacio para
    // siempre. Al revés no pasa nada: borrar un objeto que ya no existe
    // es idempotente, así que reintentar mañana es seguro.
    return NextResponse.json({ error: errorStorage.message }, { status: 500 });
  }

  const { error: errorUpdate } = await supabase
    .from("altas_manuales_conteo")
    .update({ foto_path: null, foto_borrada_at: new Date().toISOString() })
    .in(
      "id",
      vencidas.map((v) => v.id)
    );

  if (errorUpdate) {
    return NextResponse.json({ error: errorUpdate.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, borradas: paths.length });
}
