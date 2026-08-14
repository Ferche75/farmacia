import type { createBrowserClient } from "@farmacia/db";

// Mismo vocabulario que el prompt de Gemini en n8n/flujo-desconocidos-ia.json
// (sección "unidad: uno de comprimidos|capsulas|ml|g|unidades|sobres|ampollas")
// — así lo que sugiere la IA cae siempre en una opción real del selector.
export const UNIDADES_PRESENTACION = ["comprimidos", "capsulas", "ml", "g", "unidades", "sobres", "ampollas"];
export const UNIDADES_CONCENTRACION = ["mg", "ml", "mcg", "%"];

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
