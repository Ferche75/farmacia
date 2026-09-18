// Sugiere precio_blister/precio_unidad a partir del precio de caja, para
// precargar el formulario de /productos — NUNCA los calcula solo y los
// guarda: precio_blister y precio_unidad siguen siendo campos editables
// que el vendedor confirma o corrige antes de "Guardar" (ver el
// comentario grande en 20260930000001_calculadora_precios_empresa.sql
// sobre por qué esto no reemplaza la carga manual).
//
// Función pura, sin dependencias de Next/Supabase: se re-ejecuta en
// cada tecla que toca el precio de caja o el desglose, así que tiene que
// ser barata y sincrónica.

export type OperacionCalculadora = "suma" | "multiplicador" | "porcentaje";

export interface ReglaCalculadoraPrecios {
  operacion: OperacionCalculadora;
  valor: number;
}

export function aplicarRegla(base: number, regla: ReglaCalculadoraPrecios | null): number {
  if (!regla) return base;
  switch (regla.operacion) {
    case "suma":
      return base + regla.valor;
    case "multiplicador":
      return base * regla.valor;
    case "porcentaje":
      return base * (1 + regla.valor / 100);
  }
}

// Redondeo hacia arriba al próximo múltiplo de 0,50 — confirmado con el
// dueño del negocio (ver HANDOFF-calculadora-precios.md): 1.23 → 1.50,
// 1.51 → 2.00, 1.50 → 1.50 (ya está justo, no sube de más).
export function redondear(precio: number): number {
  return Math.ceil(precio / 0.5) * 0.5;
}

/** Precio de un blíster suelto, como fracción proporcional del precio de
 * caja (precio_caja / blisters_por_caja) con la regla de la empresa
 * aplicada encima y redondeada. `null` si falta algún dato para hacer la
 * cuenta (nada de esto se ve hasta que el formulario tenga precio de
 * caja Y el desglose de blísteres cargado). */
export function sugerirPrecioBlister(
  precioCaja: number | null,
  blistersPorCaja: number | null,
  regla: ReglaCalculadoraPrecios | null
): number | null {
  if (precioCaja === null || !(precioCaja > 0)) return null;
  if (blistersPorCaja === null || !(blistersPorCaja > 0)) return null;
  return redondear(aplicarRegla(precioCaja / blistersPorCaja, regla));
}

/** Mismo criterio que sugerirPrecioBlister, para la unidad suelta:
 * precio_caja / (blisters_por_caja * unidades_por_blister). */
export function sugerirPrecioUnidad(
  precioCaja: number | null,
  blistersPorCaja: number | null,
  unidadesPorBlister: number | null,
  regla: ReglaCalculadoraPrecios | null
): number | null {
  if (precioCaja === null || !(precioCaja > 0)) return null;
  if (blistersPorCaja === null || !(blistersPorCaja > 0)) return null;
  if (unidadesPorBlister === null || !(unidadesPorBlister > 0)) return null;
  return redondear(aplicarRegla(precioCaja / (blistersPorCaja * unidadesPorBlister), regla));
}
