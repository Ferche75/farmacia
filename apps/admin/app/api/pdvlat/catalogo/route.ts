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
// El `stock` de cada item sale de stock_actual_lote (20260908000000): es
// el stock REAL de ahora — la última foto física más todo lo que se movió
// después, incluidas las ventas que el propio pdvlat ya sincronizó por
// /api/pdvlat/ventas. Se resuelve con UNA llamada por página, no una por
// producto: con `limite=1000` eso sería un N+1 de mil round-trips.
//
// `stock` y `precio_venta` van en UNIDADES INDIVIDUALES (comprimido, ml,
// g — lo que diga `unidad`), no en envases: pdvlat vende suelto y
// Farmacia normaliza acá, en el borde de la API, para que del otro lado
// la cuenta sea siempre cantidad × precio_venta. El factor es
// `contenido` (unidades por envase). Ver
// 20260910000000_stock_en_unidades_individuales.sql.
//
// El empresa_id NO se recibe por querystring: sale del api_key. Aceptarlo
// como parámetro sería regalar un enumerador de catálogos ajenos (con
// costo y precio adentro) a cualquiera que tenga una credencial válida.
//
// Paginación por keyset sobre producto_id, no por offset: el catálogo está
// pensado para escalar a 100.000 SKU (CONTEXTO.md) y un OFFSET grande
// obliga a Postgres a recorrer y descartar todo lo anterior en cada
// página. El cursor es opaco para pdvlat: se pide la primera página sin
// `cursor` y se sigue con el `next_cursor` que devuelve la anterior,
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

  // Stock real de toda la página en una sola llamada. Con sucursal_id se
  // acota a esa sucursal; sin él, stock_actual_lote agrega todos los
  // ámbitos (sucursal/bodega) de la empresa — misma convención null-safe
  // que stock_actual.
  const stockPorProducto = new Map<string, number>();

  if (ids.length > 0) {
    const { data: stocks, error: errorStock } = await supabase.rpc(
      "stock_actual_lote",
      {
        p_empresa_id: empresaId,
        p_producto_ids: ids,
        p_sucursal_id: sucursalId,
      }
    );

    if (errorStock) {
      return NextResponse.json({ error: errorStock.message }, { status: 500 });
    }

    for (const fila of stocks ?? []) {
      stockPorProducto.set(fila.producto_id, fila.stock);
    }
  }

  const items = filas.map((fila) => {
    const codigos = fila.productos.codigos_barra ?? [];
    const principal = codigos.find((c) => c.es_principal) ?? codigos[0] ?? null;
    const lotes = lotesPorProducto.get(fila.producto_id) ?? [];

    // Unidades que trae un envase. Mismo fallback que el
    // `coalesce(nullif(contenido, 0), 1)` de stock_actual (ver
    // 20260910000000_stock_en_unidades_individuales.sql): contenido en 0
    // es un dato malo de importación y dividir por él daría Infinity;
    // contenido nulo es "nunca se cargó el tamaño del envase", y se
    // asume envase == unidad.
    const contenido = fila.productos.contenido;
    const unidadesPorEnvase =
      contenido !== null && contenido > 0 ? contenido : 1;

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
      // El principal, plano: es el que el POS imprime y busca por defecto.
      codigo_barra: principal ? principal.codigo_norm : null,
      // Todos los códigos, no solo el principal: un mismo producto puede
      // tener el EAN de la caja y el del blister, y el POS tiene que
      // poder matchear cualquiera de los dos.
      codigos_barra: codigos.map((c) => c.codigo_norm),
      // Bs (moneda de referencia del proyecto). `costo` es del envase
      // (es lo que se le paga al proveedor, y pdvlat no compra).
      costo: fila.costo,
      // Precio POR UNIDAD INDIVIDUAL (comprimido/ml/g, según `unidad`),
      // no por envase: productos_empresa.precio es el precio de la caja y
      // acá se divide por `contenido`. Es lo que hace que del lado de
      // pdvlat la cuenta sea siempre cantidad × precio_venta, compre 1
      // comprimido o la caja entera. Redondeado a 2 decimales, la
      // precisión de la moneda: el POS cobra en Bs, un precio unitario
      // con más decimales no se puede ni cobrar ni cuadrar contra el
      // vuelto. Ver 20260910000000_stock_en_unidades_individuales.sql.
      precio_venta:
        fila.precio === null
          ? null
          : Math.round((fila.precio / unidadesPorEnvase) * 100) / 100,
      stock_minimo: fila.stock_minimo,
      // Existencia autoritativa de ahora (ver el comentario de arriba),
      // también en UNIDADES INDIVIDUALES: stock_actual_lote ya convierte
      // la foto del conteo (que es en envases) multiplicándola por
      // `contenido`. 0 para un producto sin conteos ni movimientos.
      stock: stockPorProducto.get(fila.producto_id) ?? 0,
      // Desglose por lote/vencimiento SOLO informativo: `cantidad` es lo
      // que dijo el último conteo físico de ese lote — en ENVASES, sin
      // convertir, porque es lo que se escaneó — y no el stock de hoy
      // (sirve para vigilar vencimientos, no para saber cuánto hay).
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
    items,
    // null = no hay más páginas. Se manda el último producto_id de ESTA
    // página aunque haya venido incompleta.
    next_cursor:
      filas.length === limite ? filas[filas.length - 1].producto_id : null,
  });
}
