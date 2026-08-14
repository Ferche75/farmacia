import { createBrowserClient } from "@farmacia/db";
import { db, type ProductoLocal } from "./db";

const TAMANO_PAGINA = 1000;

const SELECT_CODIGO_CON_PRODUCTO =
  "codigo_norm, producto_id, unidades_por_codigo, productos(nombre, concentracion, forma, contenido, unidad, laboratorios(nombre))";

function filaAProductoLocal(row: FilaCodigoBarra): ProductoLocal {
  return {
    codigoNorm: row.codigo_norm,
    productoId: row.producto_id,
    nombre: row.productos?.nombre ?? "(sin nombre)",
    laboratorio: row.productos?.laboratorios?.nombre ?? null,
    concentracion: row.productos?.concentracion ?? null,
    forma: row.productos?.forma ?? null,
    contenido: row.productos?.contenido ?? null,
    unidad: row.productos?.unidad ?? null,
    unidadesPorCodigo: row.unidades_por_codigo || 1,
  };
}

export interface ProgresoDescarga {
  descargados: number;
  total: number;
}

interface FilaCodigoBarra {
  codigo_norm: string;
  producto_id: string;
  unidades_por_codigo: number;
  productos: {
    nombre: string;
    concentracion: string | null;
    forma: string | null;
    contenido: number | null;
    unidad: string | null;
    laboratorios: { nombre: string } | null;
  } | null;
}

/** Baja SOLO código, nombre, laboratorio y presentación — nunca costo ni
 * precio (CONTEXTO.md regla 3). Esos campos ni siquiera están en
 * `productos`/`codigos_barra`, así que no hay riesgo de traerlos por
 * accidente: viven en `productos_empresa`, una tabla aparte que esta
 * pantalla no toca. */
export async function descargarCatalogo(
  onProgreso: (p: ProgresoDescarga) => void
): Promise<number> {
  const supabase = createBrowserClient();

  const { count, error: countError } = await supabase
    .from("codigos_barra")
    .select("*", { count: "exact", head: true });
  if (countError) throw countError;

  const total = count ?? 0;
  let descargados = 0;

  await db.catalogo.clear();
  onProgreso({ descargados: 0, total });

  for (let desde = 0; desde < total; desde += TAMANO_PAGINA) {
    const hasta = Math.min(desde + TAMANO_PAGINA, total) - 1;

    const { data, error } = await supabase
      .from("codigos_barra")
      .select(SELECT_CODIGO_CON_PRODUCTO)
      .range(desde, hasta);
    if (error) throw error;

    const filas: ProductoLocal[] = ((data ?? []) as unknown as FilaCodigoBarra[]).map(filaAProductoLocal);

    await db.catalogo.bulkPut(filas);
    descargados += filas.length;
    onProgreso({ descargados, total });
  }

  await descargarMetadataDesconocidos(supabase);

  await db.meta.update("actual", {
    catalogoListo: true,
    catalogoDescargadoAt: Date.now(),
    catalogoTotal: descargados,
  });

  return descargados;
}

/** Mantiene el catálogo local al día MIENTRAS el conteo sigue abierto y
 * hay conexión — sin esto, un producto cargado/editado desde apps/admin
 * no aparece hasta cerrar el conteo y empezar uno nuevo (que es lo único
 * que hoy re-descarga todo). No reemplaza la descarga inicial: es un
 * complemento que solo actúa online, la app sigue funcionando offline con
 * el snapshot que ya tiene — igual que el resto de esta app.
 *
 * - INSERT en codigos_barra: código nuevo (producto nuevo, o un código
 *   agregado a uno que ya existía) — se pide esa fila con el join
 *   completo y se guarda.
 * - DELETE en codigos_barra: el código se sacó/desactivó — se borra del
 *   catálogo local para que deje de matchear acá también.
 * - UPDATE en productos: nombre/laboratorio/concentración/presentación
 *   cambiaron — se refrescan TODOS los códigos locales de ese producto.
 *
 * Devuelve una función para cortar la suscripción (llamar al desmontar). */
export function suscribirCambiosCatalogo(): () => void {
  const supabase = createBrowserClient();

  const canal = supabase
    .channel("catalogo-cambios")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "codigos_barra" },
      async (payload) => {
        const codigoNorm = (payload.new as { codigo_norm: string }).codigo_norm;
        const { data } = await supabase
          .from("codigos_barra")
          .select(SELECT_CODIGO_CON_PRODUCTO)
          .eq("codigo_norm", codigoNorm)
          .single();
        if (data) await db.catalogo.put(filaAProductoLocal(data as unknown as FilaCodigoBarra));
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "codigos_barra" },
      async (payload) => {
        const codigoNorm = (payload.old as { codigo_norm?: string }).codigo_norm;
        if (codigoNorm) await db.catalogo.delete(codigoNorm);
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "productos" },
      async (payload) => {
        const productoId = (payload.new as { id: string }).id;
        const { data } = await supabase
          .from("codigos_barra")
          .select(SELECT_CODIGO_CON_PRODUCTO)
          .eq("producto_id", productoId);
        if (data?.length) {
          await db.catalogo.bulkPut((data as unknown as FilaCodigoBarra[]).map(filaAProductoLocal));
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(canal);
  };
}

/** Trae qué códigos YA están marcados como desconocidos en el servidor
 * (de cualquier dispositivo/conteo de esta empresa) — así este
 * dispositivo, aunque nunca haya visto ese código, sabe que no hace
 * falta pedir otra foto si lo escanea. Límite documentado (ver
 * docs/decisiones.md): esto trae el CÓDIGO, no la FOTO — si este
 * dispositivo no fue el que la sacó, no hay miniatura para mostrar sin
 * conexión hasta que haya red. Los ya 'resuelto' se excluyen a
 * propósito: esos ya tienen un codigo_barra real y matchean por el
 * camino normal. */
async function descargarMetadataDesconocidos(
  supabase: ReturnType<typeof createBrowserClient>
): Promise<void> {
  const { data, error } = await supabase
    .from("desconocidos")
    .select("id, codigo_norm")
    .neq("estado", "resuelto");
  if (error) throw error;

  for (const fila of data ?? []) {
    const existente = await db.desconocidos.get(fila.codigo_norm);
    if (!existente) {
      await db.desconocidos.put({ codigoNorm: fila.codigo_norm, desconocidoId: fila.id, fotoBlob: null });
    }
  }
}
