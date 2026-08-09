// Comprime a máximo 1280px de lado mayor, calidad 0.8 — tal cual pide
// el spec de Fase 4, antes de guardar localmente o subir a Storage.

const LADO_MAXIMO = 1280;
const CALIDAD = 0.8;

export async function comprimirImagen(archivo: File | Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(archivo);
  try {
    const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height));
    const ancho = Math.round(bitmap.width * escala);
    const alto = Math.round(bitmap.height * escala);

    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo comprimir la imagen (canvas no soportado)");
    ctx.drawImage(bitmap, 0, 0, ancho, alto);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("No se pudo comprimir la imagen"))),
        "image/jpeg",
        CALIDAD
      );
    });
  } finally {
    bitmap.close();
  }
}
