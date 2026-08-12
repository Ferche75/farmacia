import * as XLSX from "xlsx";
import type { createBrowserClient } from "@farmacia/db";

type Supabase = ReturnType<typeof createBrowserClient>;

const TAMANO_PAGINA = 1000;

interface ProductoFila {
  id: string;
  nombre: string;
  principio_activo: string | null;
  concentracion: string | null;
  forma: string | null;
  contenido: number | null;
  unidad: string | null;
  categoria: string | null;
  requiere_receta: boolean;
  controlado: boolean;
  origen: string;
  activo: boolean;
  laboratorios: { nombre: string } | null;
}

interface CodigoFila {
  producto_id: string;
  codigo_norm: string;
  codigo_raw: string;
  tipo: string | null;
  es_principal: boolean;
}

interface PrecioFila {
  producto_id: string;
  costo: number | null;
  precio: number | null;
  stock_minimo: number | null;
  codigo_proveedor: string | null;
}

// PostgREST devuelve como mucho 1000 filas por consulta (límite del lado
// del servidor de Supabase, no configurable desde acá) — un backup real
// tiene que paginar en vez de asumir que el catálogo entero entra en una
// sola respuesta.
export async function exportarCatalogoCompleto(supabase: Supabase, empresaId: string) {
  const productos: ProductoFila[] = [];
  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    const { data, error } = await supabase
      .from("productos")
      .select(
        "id, nombre, principio_activo, concentracion, forma, contenido, unidad, categoria, requiere_receta, controlado, origen, activo, laboratorios(nombre)"
      )
      .order("nombre")
      .range(desde, desde + TAMANO_PAGINA - 1);
    if (error) throw new Error(error.message);
    productos.push(...((data ?? []) as unknown as ProductoFila[]));
    if (!data || data.length < TAMANO_PAGINA) break;
  }

  const codigos: CodigoFila[] = [];
  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    const { data, error } = await supabase
      .from("codigos_barra")
      .select("producto_id, codigo_norm, codigo_raw, tipo, es_principal")
      .order("producto_id")
      .range(desde, desde + TAMANO_PAGINA - 1);
    if (error) throw new Error(error.message);
    codigos.push(...(data ?? []));
    if (!data || data.length < TAMANO_PAGINA) break;
  }

  const preciosEmpresa: PrecioFila[] = [];
  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    const { data, error } = await supabase
      .from("productos_empresa")
      .select("producto_id, costo, precio, stock_minimo, codigo_proveedor")
      .eq("empresa_id", empresaId)
      .range(desde, desde + TAMANO_PAGINA - 1);
    if (error) throw new Error(error.message);
    preciosEmpresa.push(...(data ?? []));
    if (!data || data.length < TAMANO_PAGINA) break;
  }

  const codigosPorProducto = new Map<string, string[]>();
  for (const c of codigos) {
    const arr = codigosPorProducto.get(c.producto_id) ?? [];
    arr.push(c.codigo_norm);
    codigosPorProducto.set(c.producto_id, arr);
  }

  const precioPorProducto = new Map(preciosEmpresa.map((p) => [p.producto_id, p]));

  const wb = XLSX.utils.book_new();

  const wsProductos = XLSX.utils.json_to_sheet(
    productos.map((p) => {
      const pe = precioPorProducto.get(p.id);
      return {
        Nombre: p.nombre,
        Laboratorio: p.laboratorios?.nombre ?? "",
        "Principio activo": p.principio_activo ?? "",
        Concentración: p.concentracion ?? "",
        Forma: p.forma ?? "",
        Contenido: p.contenido ?? "",
        Unidad: p.unidad ?? "",
        Categoría: p.categoria ?? "",
        "Requiere receta": p.requiere_receta ? "sí" : "no",
        Controlado: p.controlado ? "sí" : "no",
        Origen: p.origen,
        Activo: p.activo ? "sí" : "no",
        "Códigos de barra": (codigosPorProducto.get(p.id) ?? []).join("; "),
        "Costo (Bs)": pe?.costo ?? "",
        "Precio (Bs)": pe?.precio ?? "",
        "Stock mínimo": pe?.stock_minimo ?? "",
        "Código de proveedor": pe?.codigo_proveedor ?? "",
      };
    })
  );
  XLSX.utils.book_append_sheet(wb, wsProductos, "Catálogo");

  const wsCodigos = XLSX.utils.json_to_sheet(
    codigos.map((c) => ({
      "Código normalizado": c.codigo_norm,
      "Código original": c.codigo_raw,
      Tipo: c.tipo ?? "",
      Principal: c.es_principal ? "sí" : "no",
      "ID producto": c.producto_id,
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsCodigos, "Códigos de barra");

  const fecha = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `catalogo-${fecha}.xlsx`);
}
