import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@farmacia/db/server";
import { autenticarPdv } from "@/lib/pdvlat";

export const dynamic = "force-dynamic";

const LIMITE_DEFAULT = 500;
const LIMITE_MAX = 1000;

interface FilaCatalogo {
  producto_id: string;
  costo: number | null;
  precio: number | null;
  stock_minimo: number | null;
  productos: {
    nombre: string;
    principio_activo: string | null;
    concentracion: string | null;
    forma: string | null;
    contenido: number | null;
    unidad: string | null;
    requiere_receta: boolean;
    controlado: boolean;
    categoria: string | null;
    fabricante: string | null;
    laboratorios: { nombre: string } | null;
    codigos_barra: {
      codigo_norm: string;
      codigo_raw: string;
      es_principal: boolean;
      unidades_por_codigo: number;
    }[];
  };
}

interface FilaLote {
  producto_id: string;
  lote: string | null;
  vencimiento: string;
  cantidad: number;
  sucursal_id: string;
}

// Catálogo de la empresa para pdvlat: Farmacia es la fuente de verdad del
// nombre, el código de barras, el principio activo y el lote/vencimiento.
//
// El empresa_id NO se recibe por querystring: sale del api_key. Aceptarlo
// como parámetro sería regalar un enumerador de catálogos ajenos (con
// costo y precio adentro) a cualquiera que tenga una credencial válida.
//
// Paginación por keyset sobre producto_id, no por offset: el catálogo está
// pensado para escalar a 100.000 SKU (CONTEXTO.md) y un OFFSET grande
// obliga a Postgres a recorrer y descartar todo lo anterior en cada
// página. El cursor es opaco para pdvlat: se pide la primera página sin
// `cursor` y se sigue con el `siguiente_cursor` que devuelve la anterior,
// hasta que venga null.
//
// GET /api/pdvlat/catalogo?limite=500&cursor=<uuid>&sucursal_id=<uuid>
export async function GET(request: Request) {
  const auth = await autenticarPdv(request);
  if ("respuesta" in auth) return auth.respuesta;

  const { empresaId } = auth.integracion;
  const url = new URL(request.url);

  const limiteRaw = Number(url.searchParams.get("limite"));
  const limite =
    Number.isFinite(limiteRaw) && limiteRaw > 0
      ? Math.min(Math.trunc(limiteRaw), LIMITE_MAX)
      : LIMITE_DEFAULT;
  const cursor = url.searchParams.get("cursor");
  const sucursalId = url.searchParams.get("sucursal_id");

  const supabase = createServiceRoleClient();

  let consulta = supabase
    .from("productos_empresa")
    .select(
      "producto_id, costo, precio, stock_minimo, productos!inner(nombre, principio_activo, concentracion, forma, contenido, unidad, requiere_receta, controlado, categoria, fabricante, laboratorios(nombre), codigos_barra(codigo_norm, codigo_raw, es_principal, unidades_por_codigo))"
    )
    .eq("empresa_id", empresaId)
    .eq("activo", true)
    .eq("productos.activo", true)
    .order("producto_id", { ascending: true })
    .limit(limite);

  if (cursor) consulta = consulta.gt("producto_id", cursor);

  const { data, error } = await consulta.returns<FilaCatalogo[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const filas = data ?? [];
  const ids = filas.map((f) => f.producto_id);

  // Lotes en una consulta aparte en vez de un embed más: `lotes` es
  // multi-fila por producto y por sucursal, y embeberla obligaría a
  // filtrar el recurso anidado por empresa_id (fácil de olvidar y de
  // filtrar de más). Solo interesan los lotes con existencia > 0 — un
  // lote en 0 ya no es nada que vigilar.
  const lotesPorProducto = new Map<string, FilaLote[]>();

  if (ids.length > 0) {
    let consultaLotes = supabase
      .from("lotes")
      .select("producto_id, lote, vencimiento, cantidad, sucursal_id")
      .eq("empresa_id", empresaId)
      .in("producto_id", ids)
      .gt("cantidad", 0)
      .order("vencimiento", { ascending: true });

    if (sucursalId) consultaLotes = consultaLotes.eq("sucursal_id", sucursalId);

    const { data: lotes, error: errorLotes } =
      await consultaLotes.returns<FilaLote[]>();

    if (errorLotes) {
      return NextResponse.json({ error: errorLotes.message }, { status: 500 });
    }

    for (const lote of lotes ?? []) {
      const acumulado = lotesPorProducto.get(lote.producto_id) ?? [];
      acumulado.push(lote);
      lotesPorProducto.set(lote.producto_id, acumulado);
    }
  }

  const productos = filas.map((fila) => {
    const codigos = fila.productos.codigos_barra ?? [];
    const principal = codigos.find((c) => c.es_principal) ?? codigos[0] ?? null;
    const lotes = lotesPorProducto.get(fila.producto_id) ?? [];

    return {
      producto_id: fila.producto_id,
      nombre: fila.productos.nombre,
      laboratorio: fila.productos.laboratorios?.nombre ?? null,
      principio_activo: fila.productos.principio_activo,
      concentracion: fila.productos.concentracion,
      forma: fila.productos.forma,
      contenido: fila.productos.contenido,
      unidad: fila.productos.unidad,
      requiere_receta: fila.productos.requiere_receta,
      controlado: fila.productos.controlado,
      categoria: fila.productos.categoria,
      fabricante: fila.productos.fabricante,
      codigo_barra: principal
        ? {
            codigo_norm: principal.codigo_norm,
            codigo_raw: principal.codigo_raw,
            unidades_por_codigo: principal.unidades_por_codigo,
          }
        : null,
      // Todos los códigos, no solo el principal: un mismo producto puede
      // tener el EAN de la caja y el del blister, y el POS tiene que
      // poder matchear cualquiera de los dos.
      codigos_barra: codigos.map((c) => c.codigo_norm),
      // Bs (moneda de referencia del proyecto).
      costo: fila.costo,
      precio: fila.precio,
      stock_minimo: fila.stock_minimo,
      // Vencimiento más próximo primero (el order by de arriba).
      lotes: lotes.map((l) => ({
        lote: l.lote,
        vencimiento: l.vencimiento,
        cantidad: l.cantidad,
        sucursal_id: l.sucursal_id,
      })),
    };
  });

  return NextResponse.json({
    empresa_id: empresaId,
    productos,
    // null = no hay más páginas. Se manda el último producto_id de ESTA
    // página aunque haya venido incompleta.
    siguiente_cursor:
      filas.length === limite ? filas[filas.length - 1].producto_id : null,
  });
}
