"use client";

import type { DesconocidoItem, EstadoDesconocido, OpcionSimple } from "./tipos";

const ETIQUETAS_ESTADO: Record<EstadoDesconocido, string> = {
  pendiente_ia: "Pendiente IA",
  sugerido: "Sugerido",
  no_reconocido: "No reconocido",
  resuelto: "Resuelto",
};

const ESTADOS_FILTRABLES: EstadoDesconocido[] = ["pendiente_ia", "sugerido", "no_reconocido"];

const ESTILO_ESTADO: Record<EstadoDesconocido, { activo: string; badge: string; icon: (p: { className?: string }) => React.JSX.Element }> = {
  pendiente_ia: { activo: "border-brand bg-brand-soft text-brand", badge: "bg-brand", icon: IconChispa },
  sugerido: { activo: "border-violet-300 bg-violet-50 text-violet-600", badge: "bg-violet-500", icon: IconDiamante },
  no_reconocido: { activo: "border-amber-300 bg-amber-50 text-amber-600", badge: "bg-amber-500", icon: IconRayo },
  resuelto: { activo: "border-line bg-paper text-muted", badge: "bg-muted", icon: IconChispa },
};

function IconChispa({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 3 13.8 9.2 20 11 13.8 12.8 12 19 10.2 12.8 4 11 10.2 9.2 12 3Z" />
    </svg>
  );
}

function IconDiamante({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4 9h16L12 20 4 9Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m8 4-4 5h16l-4-5H8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function IconRayo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function IconSucursal({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 9.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5M3 5h18l-1.5 4.5a2 2 0 0 1-1.9 1.5h-1.2a2 2 0 0 1-2-1.7 2 2 0 0 1-2 1.7h-1.8a2 2 0 0 1-2-1.7 2 2 0 0 1-2 1.7H7.4a2 2 0 0 1-1.9-1.5L3 5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCalendario({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconRefrescar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66M17 3v4.5h-4.5M7 21v-4.5h4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTarjetaImagen({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden>
      <rect x="6" y="8" width="30" height="26" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="17" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="m9 30 7-7 5 5 5-5 8 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconLupaGrande({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden>
      <circle cx="24" cy="24" r="11" stroke="currentColor" strokeWidth="2.2" />
      <path d="m32 32 9 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function EstadoVacio({ icono, titulo, subtitulo }: { icono: React.ReactNode; titulo: string; subtitulo: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-brand-soft">
        {icono}
        <IconChispa className="absolute -right-1 -top-1 h-3 w-3 text-brand-bright/70" />
        <IconChispa className="absolute -left-1.5 bottom-2 h-2 w-2 text-brand-bright/40" />
      </div>
      <div>
        <p className="text-sm font-medium text-ink">{titulo}</p>
        <p className="mt-1 text-xs text-muted">{subtitulo}</p>
      </div>
    </div>
  );
}

export function PanelLista(props: {
  items: DesconocidoItem[];
  contadores: Record<EstadoDesconocido, number>;
  cargando: boolean;
  sucursales: OpcionSimple[];
  conteos: OpcionSimple[];
  estadosFiltro: Set<EstadoDesconocido>;
  onEstadosFiltroChange: (s: Set<EstadoDesconocido>) => void;
  sucursalFiltro: string;
  onSucursalFiltroChange: (v: string) => void;
  conteoFiltro: string;
  onConteoFiltroChange: (v: string) => void;
  desde: string;
  onDesdeChange: (v: string) => void;
  hasta: string;
  onHastaChange: (v: string) => void;
  seleccionadoId: string | null;
  onSeleccionar: (id: string) => void;
}) {
  const {
    items,
    contadores,
    cargando,
    sucursales,
    conteos,
    estadosFiltro,
    onEstadosFiltroChange,
    sucursalFiltro,
    onSucursalFiltroChange,
    conteoFiltro,
    onConteoFiltroChange,
    desde,
    onDesdeChange,
    hasta,
    onHastaChange,
    seleccionadoId,
    onSeleccionar,
  } = props;

  function toggleEstado(estado: EstadoDesconocido) {
    const nuevo = new Set(estadosFiltro);
    if (nuevo.has(estado)) nuevo.delete(estado);
    else nuevo.add(estado);
    onEstadosFiltroChange(nuevo);
  }

  function limpiarFiltros() {
    onEstadosFiltroChange(new Set(ESTADOS_FILTRABLES));
    onSucursalFiltroChange("");
    onConteoFiltroChange("");
    onDesdeChange("");
    onHastaChange("");
  }

  const hayFiltrosActivos =
    estadosFiltro.size !== ESTADOS_FILTRABLES.length || sucursalFiltro || conteoFiltro || desde || hasta;

  return (
    <div className="flex w-2/5 min-w-[320px] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
      <div className="space-y-2.5 border-b border-line p-3">
        <div className="flex flex-wrap gap-1.5">
          {ESTADOS_FILTRABLES.map((estado) => {
            const estilo = ESTILO_ESTADO[estado];
            const Icon = estilo.icon;
            const activo = estadosFiltro.has(estado);
            return (
              <button
                key={estado}
                onClick={() => toggleEstado(estado)}
                className={
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors " +
                  (activo ? estilo.activo : "border-line text-muted hover:border-muted")
                }
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-white ${
                    activo ? estilo.badge : "bg-line"
                  }`}
                >
                  <Icon className="h-2.5 w-2.5" />
                </span>
                {ETIQUETAS_ESTADO[estado]} ({contadores[estado]})
              </button>
            );
          })}
        </div>

        <div className="relative">
          <IconSucursal className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <select
            value={sucursalFiltro}
            onChange={(e) => onSucursalFiltroChange(e.target.value)}
            className="w-full rounded-md border border-line bg-surface py-1.5 pl-8 pr-2 text-sm text-ink outline-none focus:border-brand"
          >
            <option value="">Todas las sucursales</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
              </option>
            ))}
          </select>
        </div>

        <div className="relative">
          <IconCalendario className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <select
            value={conteoFiltro}
            onChange={(e) => onConteoFiltroChange(e.target.value)}
            className="w-full rounded-md border border-line bg-surface py-1.5 pl-8 pr-2 text-sm text-ink outline-none focus:border-brand"
          >
            <option value="">Todos los conteos</option>
            {conteos.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <label className="relative block w-1/2">
            <span className="mb-1 block text-xs text-muted">Desde</span>
            <IconCalendario className="pointer-events-none absolute left-2.5 top-[1.9rem] h-3.5 w-3.5 text-muted" />
            <input
              type="date"
              value={desde}
              onChange={(e) => onDesdeChange(e.target.value)}
              className="w-full rounded-md border border-line bg-surface py-1.5 pl-7 pr-1 text-sm text-ink outline-none focus:border-brand"
            />
          </label>
          <label className="relative block w-1/2">
            <span className="mb-1 block text-xs text-muted">Hasta</span>
            <IconCalendario className="pointer-events-none absolute left-2.5 top-[1.9rem] h-3.5 w-3.5 text-muted" />
            <input
              type="date"
              value={hasta}
              onChange={(e) => onHastaChange(e.target.value)}
              className="w-full rounded-md border border-line bg-surface py-1.5 pl-7 pr-1 text-sm text-ink outline-none focus:border-brand"
            />
          </label>
        </div>

        {hayFiltrosActivos && (
          <button
            onClick={limpiarFiltros}
            className="flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-bright"
          >
            <IconRefrescar className="h-3.5 w-3.5" />
            Limpiar filtros
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col overflow-auto">
        {cargando && <p className="p-3 text-sm text-muted">Cargando…</p>}
        {!cargando && items.length === 0 && (
          <EstadoVacio
            icono={
              <>
                <IconTarjetaImagen className="h-11 w-11 text-line" />
                <IconLupaGrande className="absolute -bottom-1.5 -right-1.5 h-6 w-6 rounded-full bg-brand-soft text-brand" />
              </>
            }
            titulo="No hay desconocidos con estos filtros."
            subtitulo="Probá ajustando los filtros o seleccionando otro rango de fechas."
          />
        )}
        <ul>
          {items.map((it) => (
            <li key={it.id}>
              <button
                onClick={() => onSeleccionar(it.id)}
                className={
                  "block w-full border-b border-line px-3 py-2.5 text-left text-sm transition-colors " +
                  (it.id === seleccionadoId ? "bg-brand-soft" : "hover:bg-paper")
                }
              >
                <div className="font-mono text-xs text-muted">{it.codigo_norm}</div>
                <div className="flex items-center justify-between">
                  <span className="text-ink">{it.ia_respuesta?.nombre || ETIQUETAS_ESTADO[it.estado]}</span>
                  {it.ia_confianza != null && (
                    <span className="font-mono text-xs text-muted">
                      {Math.round(it.ia_confianza * 100)}%
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
