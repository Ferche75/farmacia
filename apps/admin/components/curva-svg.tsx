// Gráfico de línea, a mano con SVG — hermano de barras-svg.tsx y mismo
// criterio: "gráficos simples, pensados para leerse en una reunión". Sin
// librería de charts, porque la alternativa (agregar Recharts/d3 para UNA
// serie de ~10 puntos) pesa más que este archivo entero.
//
// Por qué una línea y no barras: lo que se muestra acá es el ritmo a lo
// largo del TIEMPO, y la pregunta es sobre la forma de la curva
// (¿arrancan lento y aceleran? ¿aflojan sobre el final?), no sobre
// comparar un intervalo con otro. Una barra por bucket contesta "cuántos
// en este rato"; la línea contesta "cómo viene la cosa", que es lo que se
// pidió.

export interface PuntoCurva {
  label: string;
  valor: number;
}

// Geometría fija, igual que BarrasSvg: el viewBox es un sistema de
// coordenadas propio y el CSS lo escala al ancho del contenedor.
const ANCHO = 400;
const ALTO = 150;
// `arriba` tiene que dar para el rótulo del pico, que se dibuja 9px por
// encima de un punto que puede estar justo en el techo del plot; si no,
// el número se corta contra el borde del viewBox.
const MARGEN = { arriba: 22, derecha: 12, abajo: 22, izquierda: 30 };
const ANCHO_PLOT = ANCHO - MARGEN.izquierda - MARGEN.derecha;
const ALTO_PLOT = ALTO - MARGEN.arriba - MARGEN.abajo;

export function CurvaSvg({
  datos,
  formatear = (v: number) => String(Math.round(v)),
  color = "#146356",
}: {
  datos: PuntoCurva[];
  formatear?: (v: number) => string;
  color?: string;
}) {
  if (datos.length === 0) {
    return <p className="text-sm text-muted">Sin datos.</p>;
  }

  const max = Math.max(...datos.map((d) => d.valor), 1);
  // Con un solo punto no hay línea que dibujar y la división de abajo
  // sería por cero: el punto se planta en el medio y se ve el número.
  // Pasa de verdad — un conteo corto entra entero en un solo intervalo.
  const x = (i: number) =>
    MARGEN.izquierda + (datos.length === 1 ? ANCHO_PLOT / 2 : (i / (datos.length - 1)) * ANCHO_PLOT);
  const y = (v: number) => MARGEN.arriba + ALTO_PLOT - (v / max) * ALTO_PLOT;

  const puntos = datos.map((d, i) => `${x(i)},${y(d.valor)}`).join(" ");

  // Etiquetas SELECTIVAS, a diferencia de BarrasSvg (que pone el número
  // en cada barra porque son categorías sueltas y cada una se lee sola).
  // Acá los puntos son una sola serie de ~10-12 y un número sobre cada
  // uno tapa justamente la forma de la curva, que es lo único que este
  // gráfico tiene para decir. Se rotulan el pico (la respuesta a "¿cuál
  // fue el mejor momento?") y los extremos (arranque y cierre, que es la
  // comparación que hace sola la cabeza de quien mira).
  const indiceMax = datos.reduce((mejor, d, i) => (d.valor > datos[mejor].valor ? i : mejor), 0);
  const rotulados = new Set([0, datos.length - 1, indiceMax]);

  // Un tick de eje X cada ~4 puntos: con 12 buckets y las horas completas
  // ("14:30") una etiqueta por punto se superpone sola. El primero y el
  // último siempre, que son los que ubican la curva en el día.
  const pasoTick = Math.max(1, Math.ceil(datos.length / 4));

  return (
    <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} className="w-full" style={{ height: ALTO }}>
      {/* Grilla horizontal en 0 / mitad / máximo: hairline y bien atrás,
          para que se pueda leer una altura sin competirle a la línea. */}
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={MARGEN.izquierda}
            x2={ANCHO - MARGEN.derecha}
            y1={y(max * f)}
            y2={y(max * f)}
            stroke="#e8e5e0"
            strokeWidth={1}
          />
          <text
            x={MARGEN.izquierda - 5}
            y={y(max * f)}
            dy="0.35em"
            textAnchor="end"
            fontSize="9"
            fontFamily="var(--font-plex-mono)"
            fill="#79726a"
          >
            {Math.round(max * f)}
          </text>
        </g>
      ))}

      <polyline
        points={puntos}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {datos.map((d, i) => (
        <g key={d.label + i}>
          {/* El anillo del color de la superficie (no un borde de color)
              es lo que mantiene el punto legible donde cruza la línea. */}
          <circle cx={x(i)} cy={y(d.valor)} r={4} fill={color} stroke="#fcfcfb" strokeWidth={2} />
          {rotulados.has(i) && (
            <text
              x={x(i)}
              y={y(d.valor) - 9}
              textAnchor="middle"
              fontSize="10"
              fontFamily="var(--font-plex-mono)"
              fill="#211f1c"
            >
              {formatear(d.valor)}
            </text>
          )}
          {(i % pasoTick === 0 || i === datos.length - 1) && (
            <text
              x={x(i)}
              y={ALTO - 6}
              textAnchor={i === 0 ? "start" : i === datos.length - 1 ? "end" : "middle"}
              fontSize="9"
              fontFamily="var(--font-plex-mono)"
              fill="#79726a"
            >
              {d.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
