"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createBrowserClient,
  resumenConteo,
  compararConteo,
  curvaRitmoConteo,
  type ResumenConteo,
  type ResultadoComparativo,
  type CurvaRitmoConteo,
} from "@farmacia/db";
import { BarrasSvg } from "@/components/barras-svg";
import { CurvaSvg } from "@/components/curva-svg";
import { exportarExcel, exportarPdf } from "@/lib/exportar-resumen";

const bs = (v: number) => `Bs ${v.toLocaleString("es-BO", { maximumFractionDigits: 2 })}`;

/** Fecha Y HORA, siempre las dos. Pedido explícito del dueño: un conteo
 * empieza y termina el mismo día, así que la fecha sola no contesta nada
 * de lo que quería saber. */
const fechaHora = (iso: string) => new Date(iso).toLocaleString("es-BO");

/** Solo la hora, para el eje X de la curva — ahí la fecha es siempre la
 * misma y repetirla en cada tick no cabe. */
const horaCorta = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" });

/** "2 h 45 min". El RPC devuelve horas decimales (2.75), que es cómodo
 * para calcular y horrible para leer en voz alta en una reunión. */
function formatearDuracion(horas: number): string {
  const minutosTotales = Math.round(horas * 60);
  const h = Math.floor(minutosTotales / 60);
  const m = minutosTotales % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

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
  const [curva, setCurva] = useState<CurvaRitmoConteo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    async function cargar() {
      setCargando(true);
      setError(null);
      try {
        // Las tres juntas y no en efectos separados: los tres RPC tienen
        // los mismos guards y la pantalla no sirve a medias — si falla
        // uno, el mensaje de error es el mismo y es mejor mostrarlo una
        // vez que dejar media pantalla pintada.
        const [r, c, cu] = await Promise.all([
          resumenConteo(supabase, conteoId),
          compararConteo(supabase, conteoId),
          curvaRitmoConteo(supabase, conteoId),
        ]);
        if (!cancelado) {
          setResumen(r);
          setComparativo(c);
          setCurva(cu);
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

      {/* Arriba de todo porque es lo primero que se pregunta al abrir un
          conteo cerrado ("¿cuándo lo hicieron y cuánto les llevó?"), y
          porque le da contexto a los números de abajo: 8.000 unidades en
          dos horas y en ocho horas no son la misma noticia. */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metrica label="Iniciado" valor={fechaHora(resumen.iniciado_at)} compacto />
        <Metrica
          label="Cerrado"
          valor={resumen.cerrado_at ? fechaHora(resumen.cerrado_at) : "En curso"}
          compacto
        />
        <Metrica
          label={resumen.cerrado_at ? "Duración" : "Duración (hasta ahora)"}
          valor={formatearDuracion(resumen.duracion_horas)}
          compacto
        />
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

          {/* La otra mitad del comparativo: el gráfico dice cuánto se
              contó, esto dice cuánto costó contarlo. Solo contra el
              conteo anterior de la MISMA sucursal — comparar la duración
              contra otra sucursal, con otro equipo y otro depósito, no
              significa nada. */}
          {comparativo?.anterior_misma_sucursal && (
            <p className="mt-4 border-t border-line pt-3 text-sm text-muted">
              Duración: <strong className="text-ink">{formatearDuracion(resumen.duracion_horas)}</strong>{" "}
              esta vez, contra{" "}
              <strong className="text-ink">
                {formatearDuracion(comparativo.anterior_misma_sucursal.duracion_horas)}
              </strong>{" "}
              en &ldquo;{comparativo.anterior_misma_sucursal.nombre}&rdquo;
              {" — "}
              {textoDiferenciaDuracion(
                resumen.duracion_horas,
                comparativo.anterior_misma_sucursal.duracion_horas
              )}
              .
            </p>
          )}
        </div>
      )}

      {/* "¿Arrancan lento y agarran ritmo, o se cansan y aflojan?" — la
          pregunta que un promedio de escaneos por hora no contesta, porque
          da el mismo número para un equipo parejo que para uno que hizo
          todo en la primera hora. Una sola línea, todo el equipo junto:
          acá la pregunta es sobre el conteo, no sobre quién rinde más (para
          eso está la tabla de abajo). */}
      {curva && curva.buckets.length > 0 && (
        <div className="mb-6 rounded-lg border border-line bg-surface p-4">
          <h3 className="text-sm font-medium text-ink">Ritmo de escaneo</h3>
          <p className="mb-3 text-xs text-muted">
            Escaneos de todo el equipo cada {curva.intervalo_minutos} minutos, a lo largo del conteo.
          </p>
          <CurvaSvg
            datos={curva.buckets.map((b) => ({
              label: horaCorta(b.inicio_bucket),
              valor: b.escaneos,
            }))}
          />
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <h3 className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink">Productividad por operario</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="px-4 py-2 font-medium">Usuario</th>
              <th className="px-4 py-2 font-medium">Escaneos</th>
              {/* "Por hora" divide por las horas del CONTEO entero, no por
                  las de cada operario: el que se sumó a la mitad aparece
                  lento sin serlo. Las dos columnas de al lado son las que
                  dejan ver eso. */}
              <th className="px-4 py-2 font-medium">Por hora</th>
              <th className="px-4 py-2 font-medium">Primer escaneo</th>
              <th className="px-4 py-2 font-medium">Último escaneo</th>
            </tr>
          </thead>
          <tbody>
            {resumen.productividad_por_operario.map((p) => (
              <tr key={p.usuario_id} className="border-t border-line">
                <td className="px-4 py-1.5 font-mono text-xs text-muted">{p.usuario_id}</td>
                <td className="px-4 py-1.5 font-mono text-ink">{p.escaneos}</td>
                <td className="px-4 py-1.5 font-mono text-ink">{p.escaneos_por_hora}</td>
                <td className="px-4 py-1.5 font-mono text-xs text-muted">
                  {fechaHora(p.primer_escaneo_at)}
                </td>
                <td className="px-4 py-1.5 font-mono text-xs text-muted">
                  {fechaHora(p.ultimo_escaneo_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** El "¿y eso es bueno o malo?" del comparativo de duración, en una
 * frase. Sin porcentajes ni flechas de colores: es un dato de contexto al
 * pie de un gráfico, no una métrica con su propia tarjeta.
 *
 * El umbral de 1 minuto existe porque los dos números tienen piso de 1
 * minuto en el RPC y porque "3 segundos más rápido" no es información. */
function textoDiferenciaDuracion(horasAhora: number, horasAntes: number): string {
  const minutos = Math.round((horasAhora - horasAntes) * 60);
  if (Math.abs(minutos) < 1) return "prácticamente lo mismo";
  const magnitud = formatearDuracion(Math.abs(minutos) / 60);
  return minutos < 0 ? `${magnitud} más rápido` : `${magnitud} más lento`;
}

/** `compacto` es para los valores que son TEXTO y no un número: una fecha
 * con hora en mono a text-lg se sale de la tarjeta en pantallas chicas, y
 * achicar toda la grilla por eso arruinaría las métricas que sí tienen que
 * leerse de lejos. */
function Metrica({
  label,
  valor,
  compacto = false,
}: {
  label: string;
  valor: string;
  compacto?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`font-mono font-semibold text-ink ${compacto ? "text-sm" : "text-lg"}`}>
        {valor}
      </p>
    </div>
  );
}
