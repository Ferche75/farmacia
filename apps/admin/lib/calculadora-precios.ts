// Sugiere precio_blister/precio_unidad a partir del precio de caja, para
// precargar el formulario de /productos — NUNCA los calcula solo y los
// guarda: precio_blister y precio_unidad siguen siendo campos editables
// que el vendedor confirma o corrige antes de "Guardar" (ver el
// comentario grande en
// 20260930000002_calculadora_precios_por_presentacion.sql sobre por qué
// esto no reemplaza la carga manual).
//
// Los tipos (OperacionCalculadora, ReglaCalculadoraPrecios,
// NivelesCalculadoraPrecios, CalculadoraPreciosEmpresa) viven en
// @farmacia/db (packages/db/src/rpc.ts) — es el contrato compartido con
// el RPC que los persiste. Import type-only: no agrega ninguna
// dependencia real de Supabase/Next a este archivo, que se re-ejecuta en
// cada tecla que toca el precio de caja o el desglose y tiene que seguir
// siendo puro y barato.
import type { CalculadoraPreciosEmpresa, NivelesCalculadoraPrecios, ReglaCalculadoraPrecios } from "@farmacia/db";

/** Lee `empresas.config.calculadora_precios` (jsonb libre, snake_case en
 * la base) y lo tipa. Vive acá para no duplicarlo entre
 * app/(app)/productos/page.tsx y app/(app)/configuracion/page.tsx, los dos
 * Server Components que necesitan esto — mismo criterio que ya usa cada
 * uno para vencimiento_semaforo. */
export function calculadoraPreciosDesdeConfig(configRaw: Record<string, unknown>): CalculadoraPreciosEmpresa {
  const raw = configRaw.calculadora_precios as
    | {
        default?: { nivel_intermedio?: ReglaCalculadoraPrecios | null; unidad?: ReglaCalculadoraPrecios | null } | null;
        por_presentacion?: Record<
          string,
          { nivel_intermedio?: ReglaCalculadoraPrecios | null; unidad?: ReglaCalculadoraPrecios | null } | null
        >;
      }
    | undefined;

  return {
    porDefecto: raw?.default
      ? { nivelIntermedio: raw.default.nivel_intermedio ?? null, unidad: raw.default.unidad ?? null }
      : null,
    porPresentacion: Object.fromEntries(
      Object.entries(raw?.por_presentacion ?? {}).map(([presentacion, niveles]) => [
        presentacion,
        niveles
          ? { nivelIntermedio: niveles.nivel_intermedio ?? null, unidad: niveles.unidad ?? null }
          : { nivelIntermedio: null, unidad: null },
      ])
    ),
  };
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

/** El markup real varía por presentación (comprimidos vs. ampollas vs.
 * vial…), así que la config guarda una regla `porDefecto` y puede pisarla
 * por presentación puntual en `porPresentacion`. Esta función resuelve
 * cuál aplica: la específica de esa presentación si existe, si no la de
 * default, si no ninguna (`null` — el formulario no ofrece sugerencia). */
export function nivelesParaPresentacion(
  config: CalculadoraPreciosEmpresa,
  presentacion: string
): NivelesCalculadoraPrecios | null {
  return config.porPresentacion[presentacion] ?? config.porDefecto ?? null;
}

/** Precio de un blíster/bandeja suelto, como fracción proporcional del
 * precio de caja (precio_caja / blisters_por_caja) con la regla de
 * `niveles.nivelIntermedio` aplicada encima y redondeada. `null` si falta
 * algún dato para hacer la cuenta (nada de esto se ve hasta que el
 * formulario tenga precio de caja Y el desglose cargado) o si no hay
 * regla resuelta para esta presentación. */
export function sugerirPrecioBlister(
  precioCaja: number | null,
  blistersPorCaja: number | null,
  niveles: NivelesCalculadoraPrecios | null
): number | null {
  if (precioCaja === null || !(precioCaja > 0)) return null;
  if (blistersPorCaja === null || !(blistersPorCaja > 0)) return null;
  return redondear(aplicarRegla(precioCaja / blistersPorCaja, niveles?.nivelIntermedio ?? null));
}

/** Mismo criterio que sugerirPrecioBlister, para la unidad suelta:
 * precio_caja / (blisters_por_caja * unidades_por_blister), con la regla
 * de `niveles.unidad`. */
export function sugerirPrecioUnidad(
  precioCaja: number | null,
  blistersPorCaja: number | null,
  unidadesPorBlister: number | null,
  niveles: NivelesCalculadoraPrecios | null
): number | null {
  if (precioCaja === null || !(precioCaja > 0)) return null;
  if (blistersPorCaja === null || !(blistersPorCaja > 0)) return null;
  if (unidadesPorBlister === null || !(unidadesPorBlister > 0)) return null;
  return redondear(aplicarRegla(precioCaja / (blistersPorCaja * unidadesPorBlister), niveles?.unidad ?? null));
}
