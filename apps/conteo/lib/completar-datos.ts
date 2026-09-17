import {
  createBrowserClient,
  completarDatosProducto,
  type DatosCompletablesProducto,
} from "@farmacia/db";
import { db, type ProductoLocal } from "./db";
import { calcularDatosCompletos, camposFaltantes, type CampoCompletable } from "./campos-obligatorios";

// El popup de "completar datos" del conteo, del lado de los datos.
// pantalla-conteo.tsx solo pinta inputs y llama a estas dos funciones.
//
// Las dos necesitan conexión, igual que crear_producto_y_contar: son
// llamadas directas al servidor, no se encolan para sincronizar después.
// Quien llama tiene que chequear `sinConexion()` antes y frenar el
// escaneo con un mensaje, nunca dejarlo pasar en silencio.
//
// Acá tampoco hay costo ni precio: el RPC que está del otro lado no los
// selecciona ni los acepta, y DatosCompletablesProducto no los tiene.

/** Mismo chequeo que usa motor-sync.ts para decidir si intentar mandar la
 * cola — no hay otro mecanismo de detección de conectividad en esta app. */
export function sinConexion(): boolean {
  return typeof navigator !== "undefined" && !navigator.onLine;
}

/** Vuelca al catálogo local los valores que devolvió el servidor (para
 * TODOS los códigos de ese producto, no solo el escaneado), recalcula
 * `datosCompletos` y devuelve qué sigue faltando.
 *
 * De paso actualiza `camposRequeridosImportacion` del meta: el RPC
 * devuelve la lista vigente, así que si el admin la cambió con el conteo
 * abierto, el criterio local se pone al día acá (el resto del catálogo se
 * corrige recién en la próxima descarga completa — ver el comentario de
 * suscribirCambiosCatalogo). */
async function volcarAlCatalogo(
  productoId: string,
  datos: DatosCompletablesProducto
): Promise<CampoCompletable[]> {
  const requeridos =
    datos.campos_requeridos ?? (await db.meta.get("actual"))?.camposRequeridosImportacion ?? [];

  if (datos.campos_requeridos) {
    await db.meta.update("actual", { camposRequeridosImportacion: datos.campos_requeridos });
  }

  const campos = {
    principioActivo: datos.principioActivo,
    categoria: datos.categoria,
    laboratorio: datos.laboratorio,
    fabricante: datos.fabricante,
    marca: datos.marca,
    accionTerapeutica: datos.accionTerapeutica,
    especialidad: datos.especialidad,
    concentracion: datos.concentracion,
    contenido: datos.contenido,
    unidad: datos.unidad,
    codigoProveedor: datos.codigoProveedor,
    distribuidor: datos.distribuidor,
    loteCatalogo: datos.loteCatalogo,
    loteCatalogo2: datos.loteCatalogo2,
  };

  const filas = await db.catalogo.where("productoId").equals(productoId).toArray();

  // Sin filas locales (no debería pasar: acá se llega desde un escaneo que
  // matcheó) se calcula igual sobre un producto sintético, para no
  // devolver "no falta nada" por el motivo equivocado.
  if (filas.length === 0) {
    const sintetico: ProductoLocal = {
      codigoNorm: "",
      productoId,
      nombre: "",
      forma: null,
      unidadesPorCodigo: 1,
      ...campos,
    };
    return camposFaltantes(sintetico, requeridos);
  }

  const actualizadas = filas.map((fila) => {
    const nueva: ProductoLocal = { ...fila, ...campos };
    nueva.datosCompletos = calcularDatosCompletos(nueva, requeridos);
    return nueva;
  });
  await db.catalogo.bulkPut(actualizadas);

  return camposFaltantes(actualizadas[0], requeridos);
}

/** Le pregunta al servidor los valores ACTUALES del producto sin escribir
 * nada (p_campos = {}), los guarda en el catálogo local y devuelve qué
 * falta de verdad.
 *
 * Se llama justo antes de abrir el popup. El snapshot local puede tener
 * horas y los 4 campos de productos_empresa no llegan por realtime, así
 * que sin esto el operario podría terminar completando a mano un dato que
 * otra persona ya cargó desde el panel. Si devuelve `[]`, no hay popup: el
 * escaneo sigue derecho. */
export async function verificarDatosEnServidor(productoId: string): Promise<CampoCompletable[]> {
  const supabase = createBrowserClient();
  const datos = await completarDatosProducto(supabase, { productoId });
  return volcarAlCatalogo(productoId, datos);
}

/** Guarda lo que el operario tipeó en el popup y deja el catálogo local al
 * día. Devuelve qué sigue faltando: `[]` significa que el producto quedó
 * completo y el escaneo puede aplicarse.
 *
 * El servidor solo LLENA HUECOS (nunca pisa un dato existente) y re-valida
 * cada key contra su propio whitelist y contra la lista de obligatorios de
 * la empresa, así que lo que se manda desde acá es una propuesta, no una
 * orden — por eso lo que vale para seguir es lo que devuelve, no lo que se
 * tipeó. */
export async function guardarDatosFaltantes(
  productoId: string,
  campos: Record<string, string>
): Promise<CampoCompletable[]> {
  const supabase = createBrowserClient();
  const datos = await completarDatosProducto(supabase, { productoId, campos });
  return volcarAlCatalogo(productoId, datos);
}
