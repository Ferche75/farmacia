import { NextResponse } from "next/server";
import { createServerClient } from "@farmacia/db/server";

interface ConfigEmpresa {
  n8n_webhook_url?: string;
  n8n_webhook_secret?: string;
  modo_desconocidos?: "confirmar_al_momento" | "solo_foto";
}

// Dispara el workflow de n8n para UN desconocido recién creado. Se llama
// desde el cliente sin esperar la respuesta (lib/motor-sync.ts) —
// CONTEXTO.md regla 6: la IA nunca bloquea el conteo. Awaitear el POST a
// n8n ACÁ adentro sí es correcto: es solo "aceptá este trabajo", rápido,
// no es esperar a que Gemini termine de procesar la imagen (eso pasa
// después, dentro de n8n, y llega por separado a /callback-ia).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const desconocidoId = body?.desconocidoId as string | undefined;
  if (!desconocidoId) {
    return NextResponse.json({ error: "Falta desconocidoId" }, { status: 400 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const { data: desconocido } = await supabase
    .from("desconocidos")
    .select("id, empresa_id, codigo_norm, foto_path")
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

  if (!config.n8n_webhook_url) {
    // Todavía no se configuró n8n para esta empresa — no es un error, el
    // desconocido se queda en pendiente_ia y un humano lo resuelve a
    // mano en la bandeja de revisión (Fase 5).
    return NextResponse.json({ disparado: false, motivo: "n8n_no_configurado" });
  }

  if (!desconocido.foto_path) {
    return NextResponse.json({ disparado: false, motivo: "sin_foto" });
  }

  const { data: fotoFirmada } = await supabase.storage
    .from("desconocidos")
    .createSignedUrl(desconocido.foto_path, 60 * 30);

  if (!fotoFirmada?.signedUrl) {
    return NextResponse.json({ disparado: false, motivo: "no_se_pudo_firmar_la_foto" });
  }

  const callbackUrl = new URL("/api/desconocidos/callback-ia", request.url).toString();

  try {
    await fetch(config.n8n_webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.n8n_webhook_secret ? { "X-Webhook-Secret": config.n8n_webhook_secret } : {}),
      },
      body: JSON.stringify({
        desconocido_id: desconocido.id,
        codigo_norm: desconocido.codigo_norm,
        foto_url: fotoFirmada.signedUrl,
        callback_url: callbackUrl,
        callback_secret: config.n8n_webhook_secret ?? null,
      }),
    });
  } catch {
    // n8n no contestó / no se pudo llegar — no es fatal, mismo criterio
    // que arriba: queda pendiente_ia para revisión manual.
    return NextResponse.json({ disparado: false, motivo: "n8n_no_respondio" });
  }

  return NextResponse.json({ disparado: true });
}
