import {
  createBrowserClient,
  datosCompletitudCatalogo,
  type OverlayEmpresaProducto,
} from "@farmacia/db";
import { db, type ProductoLocal } from "./db";
import { calcularDatosCompletos } from "./campos-obligatorios";

const TAMANO_PAGINA = 1000;

// Las columnas nuevas (principio_activo, categoria, marca,
// accion_terapeutica, especialidad, fabricante) entran acá SOLO para poder
// decidir offline si al producto le falta algún dato obligatorio — ver
// lib/campos-obligatorios.ts. Siguen sin estar costo ni precio: no viven
// en `productos` ni en `codigos_barra`, así que no hay forma de traerlos
// por este join ni por accidente.
const SELECT_CODIGO_CON_PRODUCTO =
  "codigo_norm, producto_id, unidades_por_codigo, productos(nombre, concentracion, forma, contenido, unidad, principio_activo, categoria, marca, accion_terapeutica, especialidad, fabricante, laboratorios(nombre))";

/** Los 4 campos de productos_empresa, indexados por producto_id. Ver
 * `descargarOverlayEmpresa` para por qué llegan por un RPC y no por un
 * select ni por un embed de PostgREST. */
type OverlayPorProducto = Map<string, OverlayEmpresaProducto>;

function filaAProductoLocal(
  row: FilaCodigoBarra,
  overlay: OverlayPorProducto,
  requeridos: readonly string[]
): ProductoLocal {
  const pe = overlay.get(row.producto_id);

  const producto: ProductoLocal = {
    codigoNorm: row.codigo_norm,
    productoId: row.producto_id,
    nombre: row.productos?.nombre ?? "(sin nombre)",
    laboratorio: row.productos?.laboratorios?.nombre ?? null,
    concentracion: row.productos?.concentracion ?? null,
    forma: row.productos?.forma ?? null,
    contenido: row.productos?.contenido ?? null,
    unidad: row.productos?.unidad ?? null,
    unidadesPorCodigo: row.unidades_por_codigo || 1,
    principioActivo: row.productos?.principio_activo ?? null,
    categoria: row.productos?.categoria ?? null,
    marca: row.productos?.marca ?? null,
    accionTerapeutica: row.productos?.accion_terapeutica ?? null,
    especialidad: row.productos?.especialidad ?? null,
    fabricante: row.productos?.fabricante ?? null,
    codigoProveedor: pe?.codigo_proveedor ?? null,
    distribuidor: pe?.distribuidor ?? null,
    loteCatalogo: pe?.lote_catalogo ?? null,
    loteCatalogo2: pe?.lote_catalogo_2 ?? null,
    datosCompletos: true,
  };

  // Derivado y guardado, no calculado al leer: procesarEscaneo lo lee como
  // un booleano y nada más (presupuesto de <100ms sin red).
  producto.datosCompletos = calcularDatosCompletos(producto, requeridos);
  return producto;
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
    principio_activo: string | null;
    categoria: string | null;
    marca: string | null;
    accion_terapeutica: string | null;
    especialidad: string | null;
    fabricante: string | null;
    laboratorios: { nombre: string } | null;
  } | null;
}

/** Los campos obligatorios de la empresa + el overlay de productos_empresa,
 * que es lo único que falta para poder decidir offline si a un producto le
 * faltan datos.
 *
 * POR QUÉ UN RPC Y NO UN SELECT (ni un embed de PostgREST):
 *
 *  - `productos_empresa` es INVISIBLE para un operario. La policy
 *    productos_empresa_select (20260806000001) es literalmente
 *    `empresa_id = mi_empresa_id() and mi_rol() <> 'operario'`, y está así
 *    a propósito: es la barrera de costo/precio, puesta en la base y no en
 *    el frontend. Un `.select()` (o un embed
 *    `codigos_barra → productos → productos_empresa`, que PostgREST sí
 *    sabe resolver por la FK productos_empresa.producto_id) no daría
 *    error: daría CERO FILAS, y entonces codigo_proveedor/distribuidor/
 *    lote_catalogo se verían siempre vacíos y el popup se dispararía para
 *    siempre, en todos los productos. Aflojar esa policy para que el
 *    operario pueda leer la tabla sería abrirle costo y precio: justo lo
 *    prohibido. Un RPC SECURITY DEFINER que selecciona 4 columnas
 *    elegidas a mano da el acceso sin tocar la barrera.
 *  - `empresas.config` sí lo puede leer un operario, pero ese jsonb
 *    también guarda n8n_webhook_secret (20260806000006): traerse la
 *    columna entera al IndexedDB de un teléfono para sacarle una lista de
 *    strings sería filtrar un secreto de arrastre. El RPC devuelve solo
 *    la lista.
 *
 * Si la empresa no tiene ningún campo obligatorio de productos_empresa, el
 * servidor devuelve total 0 y no manda ninguna fila — no se pagina nada. */
async function descargarOverlayEmpresa(
  supabase: ReturnType<typeof createBrowserClient>
): Promise<{ requeridos: string[]; overlay: OverlayPorProducto }> {
  const overlay: OverlayPorProducto = new Map();

  const primera = await datosCompletitudCatalogo(supabase, { offset: 0, limit: TAMANO_PAGINA });
  for (const fila of primera.filas ?? []) overlay.set(fila.producto_id, fila);

  const total = primera.total_productos_empresa ?? 0;
  for (let desde = TAMANO_PAGINA; desde < total; desde += TAMANO_PAGINA) {
    const pagina = await datosCompletitudCatalogo(supabase, { offset: desde, limit: TAMANO_PAGINA });
    if (!pagina.filas?.length) break;
    for (const fila of pagina.filas) overlay.set(fila.producto_id, fila);
  }

  return { requeridos: primera.campos_requeridos ?? [], overlay };
}

/** Baja SOLO código, nombre, laboratorio, presentación y los campos de
 * clasificación que hacen falta para el chequeo de datos obligatorios —
 * nunca costo ni precio (CONTEXTO.md regla 3). De `productos`/
 * `codigos_barra` no hay riesgo: esas columnas ni existen ahí. De
 * `productos_empresa`, que sí las tiene, lo único que baja son los 4
 * campos no-precio que devuelve datos_completitud_catalogo_conteo, un RPC
 * que los selecciona a mano (ver descargarOverlayEmpresa). */
export async function descargarCatalogo(
  onProgreso: (p: ProgresoDescarga) => void
): Promise<number> {
  const supabase = createBrowserClient();

  const { requeridos, overlay } = await descargarOverlayEmpresa(supabase);

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

    const filas: ProductoLocal[] = ((data ?? []) as unknown as FilaCodigoBarra[]).map((row) =>
      filaAProductoLocal(row, overlay, requeridos)
    );

    await db.catalogo.bulkPut(filas);
    descargados += filas.length;
    onProgreso({ descargados, total });
  }

  await descargarMetadataDesconocidos(supabase);

  await db.meta.update("actual", {
    catalogoListo: true,
    catalogoDescargadoAt: Date.now(),
    catalogoTotal: descargados,
    camposRequeridosImportacion: requeridos,
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
 *   Desde 20260922000000 eso además recalcula `datosCompletos`: si el
 *   admin completó desde el panel un dato que faltaba, el popup deja de
 *   aparecer solo, sin cerrar el conteo.
 *
 * LO QUE ESTA SUSCRIPCIÓN **NO** CUBRE, Y POR QUÉ (decisión, no olvido):
 * los cambios en `productos_empresa` y en `empresas.config` no llegan en
 * vivo. Realtime respeta la RLS de quien escucha (ver el comentario de
 * 20260814000001), y la de productos_empresa excluye al operario justo
 * para tapar costo/precio: sumar esa tabla a la publicación no le
 * llegaría igual, y sí expondría la fila ENTERA —costo y precio incluidos—
 * a cualquier sesión que sí pase la policy. Con `empresas` es peor: la
 * fila trae config, o sea n8n_webhook_secret. Ninguna de las dos se toca.
 *
 * El agujero que eso deja es chico y se tapa solo:
 *  - si alguien completa los 4 campos de empresa desde el panel mientras
 *    el conteo está abierto, el snapshot local queda viejo — pero justo
 *    antes de abrir el popup se re-consulta el dato fresco al servidor
 *    (completarDatosProducto con campos vacíos), así que el popup NO
 *    aparece; a lo sumo se pierden unos ms en una llamada.
 *  - si el admin cambia la lista de campos obligatorios con un conteo
 *    abierto, los `datosCompletos` locales siguen con el criterio viejo
 *    hasta el próximo conteo (que re-descarga todo). Aceptado: cambiar
 *    esa configuración es una acción rarísima y el peor caso es un popup
 *    de más o de menos durante una sesión, nunca un dato perdido — el RPC
 *    solo llena huecos y re-valida todo del lado del servidor.
 *
 * Devuelve una función para cortar la suscripción (llamar al desmontar). */
export function suscribirCambiosCatalogo(): () => void {
  const supabase = createBrowserClient();

  // El overlay de productos_empresa no viaja por realtime (ver arriba), así
  // que al refrescar una fila se arrastra lo que ya sabía la fila local de
  // ese mismo producto. Si el producto es nuevo para este dispositivo, no
  // hay overlay que arrastrar y esos 4 campos quedan en null — el popup lo
  // resuelve consultando al servidor antes de mostrarse.
  async function refrescarPorProducto(productoId: string) {
    const meta = await db.meta.get("actual");
    const requeridos = meta?.camposRequeridosImportacion ?? [];

    const { data } = await supabase
      .from("codigos_barra")
      .select(SELECT_CODIGO_CON_PRODUCTO)
      .eq("producto_id", productoId);
    if (!data?.length) return;

    const previas = await db.catalogo.where("productoId").equals(productoId).toArray();
    const overlay: OverlayPorProducto = new Map();
    const previa = previas[0];
    if (previa) {
      overlay.set(productoId, {
        producto_id: productoId,
        codigo_proveedor: previa.codigoProveedor ?? null,
        distribuidor: previa.distribuidor ?? null,
        lote_catalogo: previa.loteCatalogo ?? null,
        lote_catalogo_2: previa.loteCatalogo2 ?? null,
      });
    }

    await db.catalogo.bulkPut(
      (data as unknown as FilaCodigoBarra[]).map((row) => filaAProductoLocal(row, overlay, requeridos))
    );
  }

  const canal = supabase
    .channel("catalogo-cambios")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "codigos_barra" },
      async (payload) => {
        const productoId = (payload.new as { producto_id?: string }).producto_id;
        if (productoId) await refrescarPorProducto(productoId);
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
        await refrescarPorProducto(productoId);
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
