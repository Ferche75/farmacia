import type { ProductoLocal } from "./db";

// Gemelo en TS del whitelist `v_campos_completables` que está DOS VECES en
// supabase/migrations/20260922000000_completar_datos_obligatorios_al_escanear.sql
// (en datos_completitud_catalogo_conteo y en completar_datos_producto).
//
// SINCRONIZACIÓN MANUAL, igual que el resto de los listados de campos de
// este proyecto (ver el comentario de cabecera de
// apps/admin/lib/campos-sistema.ts): no hay generación de código
// compartida entre SQL y TS. Si estos tres listados dejan de decir lo
// mismo, el resultado es uno de dos bugs feos:
//   * un campo que está acá pero no en SQL ⇒ el cliente lo marca como
//     faltante, el operario lo completa, el servidor lo ignora en
//     silencio, y el popup vuelve a aparecer en el próximo escaneo. Para
//     siempre.
//   * un campo que está en SQL pero no acá ⇒ nunca se pide, y el dato
//     obligatorio que la farmacia configuró no se llena nunca.
//
// COSTO Y PRECIO NO ESTÁN, Y NO PUEDEN ESTAR (CONTEXTO.md regla 1/3).
// apps/conteo lo usan operarios: no ven ni escriben precios. Aunque la
// empresa los tenga tildados en "Campos obligatorios al importar" —que es
// perfectamente válido para el importador de CSV— acá se ignoran. La
// defensa está repetida a propósito en las 3 capas: este array, el
// whitelist de SQL, y el hecho de que ninguna query ni RPC del lado de
// conteo selecciona esas columnas.
//
// codigoBarra y unidadesPorCodigo tampoco están: el producto se encontró
// JUSTAMENTE por su código de barras, y unidades_por_codigo es un
// multiplicador por código que vale 1 por default, no un campo vacío.

/** Los campos de `productos` (globales) que se pueden completar. */
const CAMPOS_GLOBALES = [
  "principioActivo",
  "categoria",
  "laboratorio",
  "fabricante",
  "marca",
  "accionTerapeutica",
  "especialidad",
  "concentracion",
  "contenido",
  "unidad",
] as const;

/** Los campos de `productos_empresa` (por empresa) que se pueden completar. */
const CAMPOS_EMPRESA = ["codigoProveedor", "distribuidor", "loteCatalogo", "loteCatalogo2"] as const;

export const CAMPOS_COMPLETABLES_CONTEO = [...CAMPOS_GLOBALES, ...CAMPOS_EMPRESA] as const;

export type CampoCompletable = (typeof CAMPOS_COMPLETABLES_CONTEO)[number];

/** Lo que se muestra como etiqueta del input en el popup. Mismos textos
 * que CAMPOS_SISTEMA en apps/admin, para que el operario lea exactamente
 * lo que el admin tildó en Configuración. */
export const LABEL_CAMPO: Record<CampoCompletable, string> = {
  principioActivo: "Principio activo",
  categoria: "Categoría / línea",
  laboratorio: "Laboratorio",
  fabricante: "Fabricante",
  marca: "Marca",
  accionTerapeutica: "Acción terapéutica",
  especialidad: "Especialidad",
  concentracion: "Concentración",
  contenido: "Contenido (número)",
  unidad: "Unidad",
  codigoProveedor: "Código de proveedor",
  distribuidor: "Distribuidor",
  loteCatalogo: "Lote",
  loteCatalogo2: "Lote 2",
};

/** `contenido` es numeric en la base; el resto son texto libre. Lo usa el
 * popup para elegir el inputMode del campo. */
export const CAMPOS_NUMERICOS: readonly CampoCompletable[] = ["contenido"];

function esCampoCompletable(campo: string): campo is CampoCompletable {
  return (CAMPOS_COMPLETABLES_CONTEO as readonly string[]).includes(campo);
}

/** El valor que hoy tiene el producto para ese campo, mirando SOLO el
 * catálogo local. Un string vacío o en blanco cuenta como faltante, igual
 * que un null — una celda vacía de un CSV entra a la base como '' más de
 * una vez. */
function valorLocal(producto: ProductoLocal, campo: CampoCompletable): string | null {
  switch (campo) {
    case "principioActivo":
      return producto.principioActivo ?? null;
    case "categoria":
      return producto.categoria ?? null;
    case "laboratorio":
      return producto.laboratorio;
    case "fabricante":
      return producto.fabricante ?? null;
    case "marca":
      return producto.marca ?? null;
    case "accionTerapeutica":
      return producto.accionTerapeutica ?? null;
    case "especialidad":
      return producto.especialidad ?? null;
    case "concentracion":
      return producto.concentracion;
    case "contenido":
      return producto.contenido === null || producto.contenido === undefined
        ? null
        : String(producto.contenido);
    case "unidad":
      return producto.unidad;
    case "codigoProveedor":
      return producto.codigoProveedor ?? null;
    case "distribuidor":
      return producto.distribuidor ?? null;
    case "loteCatalogo":
      return producto.loteCatalogo ?? null;
    case "loteCatalogo2":
      return producto.loteCatalogo2 ?? null;
  }
}

/** Filtra la lista que vino del servidor a los campos que este código sabe
 * chequear. El servidor ya filtra igual, pero repetirlo acá es lo que hace
 * que una lista guardada por una versión más nueva (o un meta viejo) no
 * rompa nada. */
export function camposCompletablesRequeridos(requeridos: readonly string[]): CampoCompletable[] {
  return requeridos.filter(esCampoCompletable);
}

/** Qué campos obligatorios le faltan HOY a este producto, según el
 * catálogo local. Se calcula en dos momentos distintos:
 *
 *  - al sincronizar el catálogo, para dejar guardado `datosCompletos`
 *    (`faltantes.length === 0`) y que el escaneo no tenga que calcular
 *    nada;
 *  - justo antes de abrir el popup, para saber qué inputs mostrar — pero
 *    ahí se recalcula contra el dato FRESCO que devuelve
 *    completarDatosProducto({}), no contra el snapshot local. */
export function camposFaltantes(
  producto: ProductoLocal,
  requeridos: readonly string[]
): CampoCompletable[] {
  return camposCompletablesRequeridos(requeridos).filter((campo) => {
    const valor = valorLocal(producto, campo);
    return valor === null || valor.trim() === "";
  });
}

/** El booleano que se guarda en ProductoLocal.datosCompletos. */
export function calcularDatosCompletos(
  producto: ProductoLocal,
  requeridos: readonly string[]
): boolean {
  return camposFaltantes(producto, requeridos).length === 0;
}
