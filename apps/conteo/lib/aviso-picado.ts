// Si ya se le mostró a ESTE dispositivo el popup que explica qué es
// "Picado" (solo lo suelto, la caja ya se sumó sola al escanear). Se
// muestra una vez —la primera vez que se toca el botón Picado— y no
// más: repetirlo en cada escaneo sería el mismo ruido que ya se quiso
// sacar del texto de abajo del botón.
//
// Vive en localStorage y no en Dexie (lib/db.ts), mismo criterio que
// lib/uso-presentaciones.ts: es una preferencia de ESTE dispositivo (ya
// vio el aviso o no), no un dato de negocio que haya que sincronizar. Si
// se pierde (modo privado, storage limpiado), el aviso vuelve a
// aparecer una vez más — no hay nada roto que arreglar.

const CLAVE = "conteo:aviso-picado-visto";

export function yaVioAvisoPicado(): boolean {
  try {
    return localStorage.getItem(CLAVE) === "1";
  } catch {
    return false;
  }
}

export function marcarAvisoPicadoVisto(): void {
  try {
    localStorage.setItem(CLAVE, "1");
  } catch {
    // Sin guardar, el aviso vuelve a aparecer la próxima vez — molesto
    // pero no roto.
  }
}
