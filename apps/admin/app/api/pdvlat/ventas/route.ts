import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@farmacia/db/server";
import { autenticarPdv } from "@/lib/pdvlat";

export const dynamic = "force-dynamic";

interface ItemVenta {
  codigo_barra?: string;
  producto_id?: string;
  cantidad?: number;
}

// Descuento de stock por venta del POS.
//
// Toda la orden entra en UNA llamada a registrar_venta: esa función es
// plpgsql, o sea una única transacción, así que si una línea falla se
// revierte la orden entera. Iterar acá en TS llamando un RPC por línea
// dejaría media venta descontada ante el primer código desconocido.
//
// Idempotente por (empresa, referencia): reintentar el mismo POST con la
// misma referencia no vuelve a descontar, devuelve `duplicada: true` con
// el stock actual. pdvlat puede reintentar sin lógica extra.
//
// Los códigos de barra se mandan CRUDOS: la normalización la hace
// normalizar_codigo() dentro del RPC (CONTEXTO.md regla 4 — nunca confiar
// en un codigo_norm que venga de afuera).
//
// POST /api/pdvlat/ventas
// { "sucursal_id": "...", "bodega_id": null, "referencia": "ORD-00123",
//   "items": [ { "codigo_barra": "7790...", "cantidad": 2 } ] }
export async function POST(request: Request) {
  const auth = await autenticarPdv(request);
  if ("respuesta" in auth) return auth.respuesta;

  const { empresaId } = auth.integracion;
  const body = await request.json().catch(() => null);

  const sucursalId =
    typeof body?.sucursal_id === "string" ? body.sucursal_id : null;
  const bodegaId = typeof body?.bodega_id === "string" ? body.bodega_id : null;
  const referencia =
    typeof body?.referencia === "string" ? body.referencia.trim() : "";
  const items: ItemVenta[] = Array.isArray(body?.items) ? body.items : [];

  if (!sucursalId) {
    return NextResponse.json({ error: "Falta 'sucursal_id'" }, { status: 400 });
  }

  if (!referencia) {
    return NextResponse.json(
      { error: "Falta 'referencia' (número de orden del POS)" },
      { status: 400 }
    );
  }

  if (items.length === 0) {
    return NextResponse.json({ error: "La venta no tiene items" }, { status: 400 });
  }

  // Solo se saca la basura evidente acá; la validación de verdad (que el
  // producto exista, que la sucursal sea de esta empresa, que la cantidad
  // sea positiva) vive en el RPC, que es el que puede garantizarla de
  // forma atómica.
  const lineas = items.map((item) => ({
    codigo_barra: typeof item.codigo_barra === "string" ? item.codigo_barra : null,
    producto_id: typeof item.producto_id === "string" ? item.producto_id : null,
    cantidad: item.cantidad,
  }));

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.rpc("registrar_venta", {
    p_empresa_id: empresaId,
    p_sucursal_id: sucursalId,
    p_referencia: referencia,
    p_lineas: lineas,
    p_bodega_id: bodegaId,
  });

  if (error) {
    // P0001 = RAISE EXCEPTION del RPC: siempre un problema del payload
    // (código que no está en el catálogo, cantidad inválida, sucursal de
    // otra empresa). 422 para que pdvlat sepa que reintentar tal cual no
    // va a servir.
    const status = error.code === "P0001" ? 422 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json(data);
}
