"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createBrowserClient,
  resumenConteo,
  compararConteo,
  type ResumenConteo,
  type ResultadoComparativo,
} from "@farmacia/db";
import { BarrasSvg } from "@/components/barras-svg";
import { exportarExcel, exportarPdf } from "@/lib/exportar-resumen";

const bs = (v: number) => `Bs ${v.toLocaleString("es-BO", { maximumFractionDigits: 2 })}`;

export function ResumenGerencial({
  conteoId,
  nombreConteo,
}: {
  conteoId: string;
  nombreConteo: string;
}) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [resumen, setResumen] = useState<ResumenConteo | null>(null);
  const [comparativo, setComparativo] = useState<ResultadoComparativo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    async function cargar() {
      setCargando(true);
      setError(null);
      try {
        const [r, c] = await Promise.all([
          resumenConteo(supabase, conteoId),
          compararConteo(supabase, conteoId),
        ]);
        if (!cancelado) {
          setResumen(r);
          setComparativo(c);
        }
      } catch (e) {
        if (!cancelado) {
          setError(e instanceof Error ? e.message : "No se pudo cargar el resumen.");
        }
      } finally {
        if (!cancelado) setCargando(false);
      }
    }

    cargar();
    return () => {
      cancelado = true;
    };
  }, [conteoId, supabase]);

  if (cargando) {
    return <p className="mt-6 text-sm text-muted">Cargando resumen…</p>;
  }
  if (error) {
    return <p className="mt-6 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>;
  }
  if (!resumen) return null;

  const datosSucursales = [
    ...(comparativo?.anterior_misma_sucursal
      ? [
          {
            label: `Este conteo vs "${comparativo.anterior_misma_sucursal.nombre}"`,
            valor: comparativo.anterior_misma_sucursal.unidades_totales,
          },
        ]
      : []),
    ...(comparativo?.otras_sucursales.map((s) => ({
      label: s.sucursal_nombre,
      valor: s.unidades_totales,
    })) ?? []),
  ];

  return (
    <div className="mt-8 border-t border-line pt-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-ink">Resumen gerencial</h2>
        <div className="flex gap-2">
          <button
            onClick={() => exportarExcel(resumen, comparativo, nombreConteo)}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-paper"
          >
            Exportar Excel
          </button>
          <button
            onClick={() => exportarPdf(resumen, comparativo, nombreConteo)}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-paper"
          >
            Exportar PDF
          </button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metrica label="Unidades totales" valor={String(resumen.unidades_totales)} />
        <Metrica label="SKU distintos" valor={String(resumen.skus_distintos)} />
        <Metrica label="SKU no encontrados" valor={String(resumen.skus_catalogo_no_encontrados)} />
        <Metrica label="Valor a costo" valor={bs(resumen.valor_costo)} />
        <Metrica label="Valor a precio" valor={bs(resumen.valor_precio)} />
        <Metrica label="Margen teórico" valor={bs(resumen.margen_teorico)} />
        <Metrica
          label="Desconocidos (este conteo)"
          valor={String(resumen.desconocidos_pendientes_este_conteo)}
        />
        <Metrica label="Desconocidos (empresa)" valor={String(resumen.desconocidos_empresa_pendientes)} />
      </div>

      <div className="mb-3 rounded-lg border border-line bg-paper p-4 text-sm">
        <p className="mb-3 font-medium text-ink">Desconocidos detectados en este conteo</p>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-muted">Detectados acá</p>
            <p className="font-mono text-lg font-semibold text-ink">{resumen.desconocidos_detectados_este_conteo}</p>
          </div>
          <div>
            <p className="text-muted">Resueltos por IA</p>
            <p className="font-mono text-lg font-semibold text-ink">{resumen.desconocidos_resueltos_ia_este_conteo}</p>
          </div>
          <div>
            <p className="text-muted">Resueltos manualmente</p>
            <p className="font-mono text-lg font-semibold text-ink">{resumen.desconocidos_resueltos_manual_este_conteo}</p>
          </div>
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-line bg-paper p-4 text-sm">
        <p className="mb-3 font-medium text-ink">Desconocidos — toda la empresa (contexto general)</p>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-muted">Total histórico</p>
            <p className="font-mono text-lg font-semibold text-ink">{resumen.desconocidos_empresa_total}</p>
          </div>
          <div>
            <p className="text-muted">Resueltos por IA</p>
            <p className="font-mono text-lg font-semibold text-ink">{resumen.desconocidos_empresa_resueltos_ia}</p>
          </div>
          <div>
            <p className="text-muted">Resueltos manualmente</p>
            <p className="font-mono text-lg font-semibold text-ink">{resumen.desconocidos_empresa_resueltos_manual}</p>
          </div>
        </div>
      </div>

      {resumen.tiene_vencimientos && (
        <div className="mb-6 rounded-lg border border-warn/30 bg-warn-soft p-4 text-sm">
          <p className="text-warn">
            <strong>{resumen.vencimientos_menos_90_dias}</strong> producto(s) vencen en menos de 90
            días · <strong>{resumen.vencimientos_menos_180_dias}</strong> en menos de 180 días.
          </p>
        </div>
      )}

      <div className="mb-6 rounded-lg border border-line bg-surface p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">Top 20 por valor inmovilizado (costo)</h3>
        <BarrasSvg
          datos={resumen.top_20_valor_inmovilizado.map((p) => ({
            label: p.nombre,
            valor: p.valor_costo,
          }))}
          formatear={bs}
        />
      </div>

      {datosSucursales.length > 0 && (
        <div className="mb-6 rounded-lg border border-line bg-surface p-4">
          <h3 className="mb-3 text-sm font-medium text-ink">Unidades — comparativo</h3>
          <BarrasSvg datos={datosSucursales} color="#1f9d82" />
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <h3 className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink">Productividad por operario</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="px-4 py-2 font-medium">Usuario</th>
              <th className="px-4 py-2 font-medium">Escaneos</th>
              <th className="px-4 py-2 font-medium">Por hora</th>
            </tr>
          </thead>
          <tbody>
            {resumen.productividad_por_operario.map((p) => (
              <tr key={p.usuario_id} className="border-t border-line">
                <td className="px-4 py-1.5 font-mono text-xs text-muted">{p.usuario_id}</td>
                <td className="px-4 py-1.5 font-mono text-ink">{p.escaneos}</td>
                <td className="px-4 py-1.5 font-mono text-ink">{p.escaneos_por_hora}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metrica({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-mono text-lg font-semibold text-ink">{valor}</p>
    </div>
  );
}
