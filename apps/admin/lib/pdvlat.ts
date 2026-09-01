import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@farmacia/db/server";

// Autenticación servidor-a-servidor de la integración con el POS pdvlat.
//
// Mismo patrón que el callback de n8n (apps/conteo,
// /api/desconocidos/callback-ia): sin sesión de Supabase, service_role key
// y un secreto compartido validado a mano. La diferencia es que acá las
// credenciales son propias (tabla integraciones_pdv) y no se reusa el
// secreto de n8n — son dos integraciones distintas y comprometer una no
// tiene por qué comprometer la otra.
//
// Dos headers en vez de uno: X-PDV-Api-Key identifica la fila (es el
// índice de búsqueda, no es secreto) y X-PDV-Api-Secret la autentica. Así
// el secreto nunca se usa como criterio de búsqueda en la base y se puede
// rotar sin cambiar el identificador.

export const HEADER_API_KEY = "X-PDV-Api-Key";
export const HEADER_API_SECRET = "X-PDV-Api-Secret";

export interface IntegracionPdv {
  id: string;
  empresaId: string;
  tenantIdPdvlat: string | null;
}

/** Comparación de largo constante: evita filtrar el secreto byte a byte
 * midiendo cuánto tarda la respuesta. */
function secretosIguales(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Devuelve la integración autenticada, o una respuesta 401 lista para
 * devolver. El caller hace: `if ("respuesta" in r) return r.respuesta;` */
export async function autenticarPdv(
  request: Request
): Promise<{ integracion: IntegracionPdv } | { respuesta: NextResponse }> {
  const apiKey = request.headers.get(HEADER_API_KEY);
  const apiSecret = request.headers.get(HEADER_API_SECRET);

  const noAutorizado = NextResponse.json(
    { error: "Credenciales de integración inválidas" },
    { status: 401 }
  );

  if (!apiKey || !apiSecret) return { respuesta: noAutorizado };

  const supabase = createServiceRoleClient();

  const { data } = await supabase
    .from("integraciones_pdv")
    .select("id, empresa_id, api_secret, tenant_id_pdvlat, activo, vinculado_at")
    .eq("api_key", apiKey)
    .maybeSingle();

  // Una integración a la que todavía no se le canjeó el código de
  // invitación no puede operar: sus credenciales son las provisorias que
  // se generaron al crear la fila y nunca salieron de la base.
  if (!data || !data.activo || !data.vinculado_at) return { respuesta: noAutorizado };

  if (!secretosIguales(apiSecret, data.api_secret)) return { respuesta: noAutorizado };

  return {
    integracion: {
      id: data.id,
      empresaId: data.empresa_id,
      tenantIdPdvlat: data.tenant_id_pdvlat,
    },
  };
}
