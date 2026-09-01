import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@farmacia/db/server";

export const dynamic = "force-dynamic";

// Canje del código de invitación: el único endpoint de /api/pdvlat que NO
// pide api_key/api_secret, porque es justamente el que las entrega.
//
// Su control de acceso es el código en sí: 48 bits, de un solo uso, válido
// 72 h, generado por el admin de la empresa desde "Mi empresa" en este
// mismo panel (RPC generar_codigo_invitacion_pdv). Toda la validación real
// vive en vincular_integracion_pdv (SECURITY DEFINER) — acá solo se parsea
// el body y se traduce el error a un status HTTP.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const codigo = typeof body?.codigo === "string" ? body.codigo : null;
  const tenantId =
    typeof body?.tenant_id === "string" ? body.tenant_id : null;

  if (!codigo || !tenantId) {
    return NextResponse.json(
      { error: "Faltan 'codigo' y/o 'tenant_id'" },
      { status: 400 }
    );
  }

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.rpc("vincular_integracion_pdv", {
    p_codigo: codigo,
    p_tenant_id: tenantId,
  });

  if (error) {
    // P0001 = RAISE EXCEPTION de la función (código inválido o vencido,
    // falta el tenant). Es culpa del request, no del servidor.
    const status = error.code === "P0001" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  // api_key y api_secret viajan UNA sola vez, acá. pdvlat tiene que
  // guardarlos de su lado; si los pierde, el admin genera otro código y se
  // vuelve a vincular (eso rota las credenciales viejas).
  return NextResponse.json(data);
}
