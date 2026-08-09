import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@farmacia/db/server";

interface ConfigEmpresa {
  n8n_webhook_secret?: string;
}

// n8n llama acá cuando termina de procesar la foto con Gemini (prompt de
// la sección 5 del spec). Sin sesión de usuario — se autentica con el
// secreto compartido (config.n8n_webhook_secret de la empresa), nunca
// con un JWT, así que usa la service_role key (ignora RLS) y valida el
// secreto a mano antes de escribir nada.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const desconocidoId = body?.desconocido_id as string | undefined;
  if (!desconocidoId) {
    return NextResponse.json({ error: "Falta desconocido_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: desconocido } = await supabase
    .from("desconocidos")
    .select("id, empresa_id")
    .eq("id", desconocidoId)
    .single();
  if (!desconocido) {
    return NextResponse.json({ error: "No existe" }, { status: 404 });
  }

  const { data: empresa } = await supabase
    .from("empresas")
    .select("config")
    .eq("id", desconocido.empresa_id)
    .single();
  const config = (empresa?.config ?? {}) as ConfigEmpresa;

  if (config.n8n_webhook_secret) {
    const secretoRecibido = request.headers.get("X-Webhook-Secret");
    if (secretoRecibido !== config.n8n_webhook_secret) {
      return NextResponse.json({ error: "Secreto inválido" }, { status: 401 });
    }
  }

  // Parseo tolerante (el spec lo pide del lado de n8n, pero acá también
  // por las dudas): si "reconocido" no vino o no es boolean, se trata
  // como no reconocido en vez de romper.
  const reconocido = body?.reconocido === true;
  const nuevoEstado = reconocido ? "sugerido" : "no_reconocido";

  const { error } = await supabase
    .from("desconocidos")
    .update({
      estado: nuevoEstado,
      ia_respuesta: body,
      ia_confianza: typeof body?.confianza === "number" ? body.confianza : null,
    })
    .eq("id", desconocidoId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
