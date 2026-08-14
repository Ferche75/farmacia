import { db, type LineaDesconocidoLocal } from "./db";
import { dispositivoActual, generarUuid, formatearPresentacion } from "./motor-escaneo";

// Se llama cuando motor-escaneo.procesarEscaneo() devolvió "no_encontrado"
// — acá se decide si es la primera vez que se ve ese código (hace falta
// foto) o si ya se conoce (local o porque el catálogo lo trajo al bajar
// el conteo), caso en el que CONTEXTO.md pide sumar 1 sin pedir otra foto.

export async function esDesconocidoConocido(codigoNorm: string): Promise<boolean> {
  return (await db.desconocidos.get(codigoNorm)) !== undefined;
}

async function upsertLinea(conteoId: string, codigoNorm: string, delta: number): Promise<LineaDesconocidoLocal> {
  const id = `${conteoId}:${codigoNorm}`;
  const existente = await db.lineasDesconocidos.get(id);
  const nueva: LineaDesconocidoLocal = {
    id,
    conteoId,
    codigoNorm,
    cantidad: (existente?.cantidad ?? 0) + delta,
    ultimoEscaneoAt: Date.now(),
  };
  await db.lineasDesconocidos.put(nueva);
  return nueva;
}

/** Re-escaneo de un código ya conocido como desconocido — no pide foto,
 * solo suma 1 (o `delta` para cantidad manual). */
export async function procesarReescaneoDesconocido(params: {
  conteoId: string;
  codigoRaw: string;
  codigoNorm: string;
  delta?: number;
}): Promise<LineaDesconocidoLocal> {
  const { conteoId, codigoRaw, codigoNorm, delta = 1 } = params;

  return db.transaction("rw", db.lineasDesconocidos, db.colaDesconocidos, async () => {
    const linea = await upsertLinea(conteoId, codigoNorm, delta);

    await db.colaDesconocidos.put({
      clientUuid: generarUuid(),
      conteoId,
      codigoRaw,
      codigoNorm,
      fotoBlob: null, // ya se conoce, no hace falta volver a subir nada
      dispositivo: dispositivoActual(),
      createdAt: Date.now(),
      sincronizado: 0,
    });

    return linea;
  });
}

/** Primera vez que se ve este código: guarda la foto (ya comprimida)
 * local para verla sin conexión desde este dispositivo, y la encola
 * para subirse a Storage + crear el desconocido en el servidor cuando
 * haya red. */
export async function registrarFotoDesconocidoNuevo(params: {
  conteoId: string;
  codigoRaw: string;
  codigoNorm: string;
  fotoComprimida: Blob;
}): Promise<LineaDesconocidoLocal> {
  const { conteoId, codigoRaw, codigoNorm, fotoComprimida } = params;

  return db.transaction(
    "rw",
    db.desconocidos,
    db.lineasDesconocidos,
    db.colaDesconocidos,
    async () => {
      await db.desconocidos.put({ codigoNorm, desconocidoId: null, fotoBlob: fotoComprimida });
      const linea = await upsertLinea(conteoId, codigoNorm, 1);

      await db.colaDesconocidos.put({
        clientUuid: generarUuid(),
        conteoId,
        codigoRaw,
        codigoNorm,
        fotoBlob: fotoComprimida,
        dispositivo: dispositivoActual(),
        createdAt: Date.now(),
        sincronizado: 0,
      });

      return linea;
    }
  );
}

export async function obtenerFotoLocal(codigoNorm: string): Promise<Blob | null> {
  const d = await db.desconocidos.get(codigoNorm);
  return d?.fotoBlob ?? null;
}

/** Edición manual en la lista en vivo, mismo criterio que
 * establecerCantidad() en motor-escaneo.ts: nunca pisa el número,
 * registra la diferencia como un evento más. */
export async function establecerCantidadDesconocido(
  conteoId: string,
  codigoNorm: string,
  nuevaCantidad: number
): Promise<void> {
  await db.transaction("rw", db.lineasDesconocidos, db.colaDesconocidos, async () => {
    const id = `${conteoId}:${codigoNorm}`;
    const linea = await db.lineasDesconocidos.get(id);
    if (!linea) return;

    const delta = nuevaCantidad - linea.cantidad;
    if (delta === 0) return;

    await db.colaDesconocidos.put({
      clientUuid: generarUuid(),
      conteoId,
      codigoRaw: codigoNorm,
      codigoNorm,
      fotoBlob: null,
      dispositivo: dispositivoActual(),
      createdAt: Date.now(),
      sincronizado: 0,
    });

    await db.lineasDesconocidos.put({ ...linea, cantidad: nuevaCantidad, ultimoEscaneoAt: Date.now() });
  });
}

/** Se llama después de que resolver_desconocido() confirma en el
 * servidor. Refleja lo mismo localmente: mueve la línea de
 * lineasDesconocidos a lineas (conservando la cantidad) y agrega el
 * código al catálogo local, para que un re-escaneo futuro matchee
 * directo sin pasar de nuevo por el camino "desconocido".
 *
 * Límite conocido (documentado, no resuelto): si justo en ese instante
 * había un envío de colaDesconocidos sin sincronizar para este mismo
 * código, ese envío va a fallar en el próximo intento de sync (el
 * servidor va a decir "este código ya está en el catálogo") y va a
 * quedar trabado pidiendo reintento para siempre. Es un caso raro
 * (carrera exacta entre resolver y sincronizar) — se resolvería a mano
 * revisando la cola en devtools si llega a pasar. */
export async function migrarDesconocidoAProductoLocal(params: {
  conteoId: string;
  codigoNorm: string;
  productoId: string;
  nombre: string;
  laboratorio: string | null;
  concentracion: string | null;
  forma: string | null;
  contenido: number | null;
  unidad: string | null;
}): Promise<void> {
  const {
    conteoId,
    codigoNorm,
    productoId,
    nombre,
    laboratorio,
    concentracion,
    forma,
    contenido,
    unidad,
  } = params;

  await db.transaction(
    "rw",
    db.catalogo,
    db.lineas,
    db.lineasDesconocidos,
    db.desconocidos,
    async () => {
      await db.catalogo.put({
        codigoNorm,
        productoId,
        nombre,
        laboratorio,
        concentracion,
        forma,
        contenido,
        unidad,
        // resolver_desconocido (servidor) siempre crea el codigo_barra con
        // el default de la columna (1) — ese RPC no expone un multiplicador.
        unidadesPorCodigo: 1,
      });

      const idDesc = `${conteoId}:${codigoNorm}`;
      const lineaDesc = await db.lineasDesconocidos.get(idDesc);
      if (lineaDesc) {
        const presentacion = [forma, concentracion].filter(Boolean).join(" · ") || null;
        await db.lineas.put({
          id: `${conteoId}:${productoId}`,
          conteoId,
          productoId,
          codigoNorm,
          nombre,
          laboratorio,
          presentacion,
          cantidad: lineaDesc.cantidad,
          ultimoEscaneoAt: lineaDesc.ultimoEscaneoAt,
        });
        await db.lineasDesconocidos.delete(idDesc);
      }

      await db.desconocidos.delete(codigoNorm);
    }
  );
}

/** Contraparte local de crear_producto_y_contar (RPC) — "Cargar sin foto"
 * desde un "No encontrado". A diferencia de migrarDesconocidoAProductoLocal,
 * acá nunca hubo una lineaDesconocidos que fusionar: el código nunca pasó
 * por el camino de "desconocido", se resolvió de una. */
export async function agregarProductoManualAProductoLocal(params: {
  conteoId: string;
  codigoNorm: string;
  productoId: string;
  nombre: string;
  laboratorio: string | null;
  concentracion: string | null;
  contenido: number | null;
  unidad: string | null;
  cantidad: number;
}): Promise<void> {
  const { conteoId, codigoNorm, productoId, nombre, laboratorio, concentracion, contenido, unidad, cantidad } = params;

  await db.transaction("rw", db.catalogo, db.lineas, async () => {
    await db.catalogo.put({
      codigoNorm,
      productoId,
      nombre,
      laboratorio,
      concentracion,
      forma: null,
      contenido,
      unidad,
      unidadesPorCodigo: 1,
    });

    await db.lineas.put({
      id: `${conteoId}:${productoId}`,
      conteoId,
      productoId,
      codigoNorm,
      nombre,
      laboratorio,
      presentacion: formatearPresentacion({ concentracion, forma: null, contenido, unidad }),
      cantidad,
      ultimoEscaneoAt: Date.now(),
    });
  });
}
