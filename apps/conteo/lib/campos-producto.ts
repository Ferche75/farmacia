import type { createBrowserClient } from "@farmacia/db";

// Las dos listas de opciones YA NO SE DEFINEN ACÁ: viven en
// packages/db/src/campos-producto.ts y se reexportan tal cual para no
// tocar los imports de quienes ya las usaban (pantalla-conteo.tsx,
// tarjeta-sugerencia.tsx).
//
// Hasta este cambio este archivo tenía SU PROPIA copia a mano de
// UNIDADES_PRESENTACION (7 valores) mientras apps/admin tenía otra (21), y
// las dos se habían desincronizado: una presentación elegida en el panel
// ni siquiera existía en el selector del dispositivo. La fuente única de
// verdad ahora es @farmacia/db.
//
// Los 7 valores originales (comprimidos, capsulas, ml, g, unidades,
// sobres, ampollas) —que son los que emite el prompt de Gemini en
// n8n/flujo-desconocidos-ia.json— siguen estando, con la misma escritura:
// lo que sugiere la IA sigue cayendo siempre en una opción real del
// selector. La lista compartida es un superconjunto de ese prompt.
//
// `camposDePresentacion` viaja por la misma puerta desde que el alta manual
// del conteo es un wizard: el paso 2 decide qué campos mostrar según la
// presentación elegida, exactamente con el mismo criterio que el ABM de
// apps/admin. Tiene que salir de la misma fuente que las listas, si no
// vuelve a pasar lo de arriba (dos criterios que se desincronizan).
export { UNIDADES_PRESENTACION, UNIDADES_CONCENTRACION, camposDePresentacion } from "@farmacia/db";

// Parseo best-effort de lo que devuelve la IA (ej. "400 mg") a
// valor+unidad separados para los 2 inputs. Notaciones compuestas tipo
// "500 mg/5 ml" no entran enteras en un numérico — se recorta a la
// primera cantidad+unidad reconocida y el resto se pierde; es una
// simplificación a propósito (la mayoría de los productos son
// concentración simple), corregible a mano si hace falta más precisión.
export function parseConcentracion(texto: string | undefined): { valor: string; unidad: string } {
  const match = texto?.match(/(\d+(?:[.,]\d+)?)\s*(mg|ml|mcg|%)/i);
  if (!match) return { valor: "", unidad: "mg" };
  return { valor: match[1].replace(",", "."), unidad: match[2].toLowerCase() };
}

// laboratorios solo lo puede escribir admin/gerente/superadmin (RLS) —
// resolver_desconocido y crear_producto_y_contar validan permisos de
// rol por su cuenta, así que un insert directo del cliente acá es seguro:
// si el que llama no tiene permiso, este upsert va a fallar solo.
export async function resolverLaboratorioId(
  supabase: ReturnType<typeof createBrowserClient>,
  nombre: string
): Promise<string | null> {
  const limpio = nombre.trim();
  if (!limpio) return null;
  const { data, error } = await supabase
    .from("laboratorios")
    .upsert({ nombre: limpio }, { onConflict: "nombre" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}
