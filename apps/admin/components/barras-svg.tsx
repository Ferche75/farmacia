// Gráfico de barras horizontal, a mano con SVG — "gráficos simples,
// pensados para leerse en una reunión" (spec Fase 6). Sin librería de
// charts: para 2-3 gráficos chicos en una sola pantalla no vale la pena
// la dependencia, y esto es fácil de leer/mantener tal cual es.

export interface BarraDato {
  label: string;
  valor: number;
}

export function BarrasSvg({
  datos,
  formatear = (v: number) => String(Math.round(v)),
  color = "#146356",
}: {
  datos: BarraDato[];
  formatear?: (v: number) => string;
  color?: string;
}) {
  if (datos.length === 0) {
    return <p className="text-sm text-muted">Sin datos.</p>;
  }

  const max = Math.max(...datos.map((d) => d.valor), 1);
  const altoFila = 28;
  const alto = datos.length * altoFila;

  return (
    <svg viewBox={`0 0 400 ${alto}`} className="w-full" style={{ height: alto }}>
      {datos.map((d, i) => {
        const anchoBarra = Math.max((d.valor / max) * 260, d.valor > 0 ? 2 : 0);
        const y = i * altoFila;
        return (
          <g key={d.label + i} transform={`translate(0, ${y})`}>
            <text x={0} y={altoFila / 2} dy="0.35em" fontSize="11" fill="#79726a">
              {d.label.length > 22 ? d.label.slice(0, 22) + "…" : d.label}
            </text>
            <rect x={130} y={4} width={anchoBarra} height={altoFila - 12} fill={color} rx={3} />
            <text x={130 + anchoBarra + 6} y={altoFila / 2} dy="0.35em" fontSize="11" fontFamily="var(--font-plex-mono)" fill="#211f1c">
              {formatear(d.valor)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
