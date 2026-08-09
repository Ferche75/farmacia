// Misma marca que apps/conteo (corchetes de visor de escáner) — identidad
// compartida entre las dos apps aunque sean bundles separados.
export function Marca({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" className={className} aria-hidden>
      <path d="M4 18V8a4 4 0 0 1 4-4h10" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M52 18V8a4 4 0 0 0-4-4H38" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M4 38v10a4 4 0 0 0 4 4h10" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M52 38v10a4 4 0 0 1-4 4H38" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="16" y="24" width="3" height="8" rx="1.5" fill="currentColor" />
      <rect x="22" y="24" width="2" height="8" rx="1" fill="currentColor" />
      <rect x="27" y="24" width="4" height="8" rx="1.5" fill="currentColor" />
      <rect x="34" y="24" width="2" height="8" rx="1" fill="currentColor" />
      <rect x="38" y="24" width="3" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}
