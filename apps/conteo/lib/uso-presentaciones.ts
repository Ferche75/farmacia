// Cuenta cuántas veces se elige cada presentación al dar de alta un
// producto manual, para que los botones rápidos del paso 1 del wizard
// (ver pantalla-conteo.tsx) reflejen lo que ESTA farmacia usa de verdad y
// no una lista fija adivinada — pedido explícito del usuario: "que sean
// dinámicos, si usan otros después que los 4 por defecto deberían
// cambiar".
//
// Vive en localStorage y no en Dexie (lib/db.ts) a propósito: es una
// preferencia de ESTE dispositivo, no un dato de negocio que haya que
// sincronizar con el servidor ni compartir entre dispositivos. Si se
// pierde (modo privado, storage limpiado, `localStorage` ausente), la
// función de lectura cae en un objeto vacío y el paso 1 vuelve a mostrar
// los defaults — no hay nada roto que arreglar, solo vuelve a aprender.

const CLAVE = "conteo:uso-presentaciones";

// Punto de partida para un dispositivo sin uso todavía. NO son los
// primeros 4 de UNIDADES_PRESENTACION tal cual (el 4to real de esa lista
// es "tableta efervescente", poco frecuente) — se eligieron a mano como
// los más comunes en una farmacia típica. En cuanto haya uso real, estos
// se van desplazando.
const DEFAULT_FRECUENTES = ["comprimidos", "capsulas", "jarabe", "ampollas"];

function leerConteos(): Record<string, number> {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return {};
    const parsed: unknown = JSON.parse(crudo);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Suma un uso de `unidad`. Se llama cuando un alta manual se GUARDA con
 * éxito (no al tipear o clickear en el paso 1): elegir una presentación y
 * después arrepentirse / cancelar el formulario no debería contar como
 * uso real. */
export function registrarUsoPresentacion(unidad: string | null | undefined): void {
  const limpio = (unidad ?? "").trim();
  if (!limpio) return;
  try {
    const conteos = leerConteos();
    conteos[limpio] = (conteos[limpio] ?? 0) + 1;
    localStorage.setItem(CLAVE, JSON.stringify(conteos));
  } catch {
    // Sin conteos guardados, la próxima apertura del formulario vuelve a
    // mostrar los defaults — no afecta al producto que se acaba de guardar.
  }
}

/** Las `limite` presentaciones más elegidas en ESTE dispositivo (mayor
 * conteo primero). Completa lo que falte con DEFAULT_FRECUENTES, sin
 * repetir una que ya haya entrado por uso real, para que los botones
 * rápidos nunca queden con menos de `limite` opciones. */
export function obtenerPresentacionesFrecuentes(limite = 4): string[] {
  const conteos = leerConteos();
  const porUso = Object.entries(conteos)
    .sort((a, b) => b[1] - a[1])
    .map(([unidad]) => unidad);

  const resultado = [...porUso];
  for (const def of DEFAULT_FRECUENTES) {
    if (resultado.length >= limite) break;
    if (!resultado.includes(def)) resultado.push(def);
  }
  return resultado.slice(0, limite);
}
