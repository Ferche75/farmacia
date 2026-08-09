import Image from "next/image";
import Link from "next/link";
import { createServerClient } from "@farmacia/db/server";
import { requirePerfilAdmin } from "@/lib/dal";

export const dynamic = "force-dynamic";

const ROL_LABEL: Record<string, string> = {
  admin: "Admin",
  gerente: "Gerente",
  superadmin: "Superadmin",
};

function IconCaja({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3 4 6.5v11L12 21l8-3.5v-11L12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M4 6.5 12 10l8-3.5M12 10v11" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function IconClipboard({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="5" y="4" width="14" height="17" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.6" />
      <path d="m8.5 12 2 2 4-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBarras({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4 20V10M12 20V4M20 20v-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconNube({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M7 18a4 4 0 0 1-.6-7.96A5 5 0 0 1 16 8a4.5 4.5 0 0 1 1 8.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 12v6m0-6 2.2 2.2M12 12l-2.2 2.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconEscudo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3 5 5.5v5.2c0 4.4 2.9 7.7 7 8.8 4.1-1.1 7-4.4 7-8.8V5.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="m9 12 2 2 4-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default async function HomePage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  const [productos, revision, conteos, importaciones] = await Promise.all([
    supabase.from("productos").select("*", { count: "exact", head: true }).eq("activo", true),
    supabase
      .from("desconocidos")
      .select("*", { count: "exact", head: true })
      .eq("empresa_id", perfil.empresaId)
      .neq("estado", "resuelto"),
    supabase.from("conteos").select("*", { count: "exact", head: true }).eq("empresa_id", perfil.empresaId),
    supabase.from("importaciones").select("*", { count: "exact", head: true }).eq("empresa_id", perfil.empresaId),
  ]);

  const productosCount = productos.count ?? 0;
  const revisionCount = revision.count ?? 0;
  const conteosCount = conteos.count ?? 0;
  const importacionesCount = importaciones.count ?? 0;
  const sinDatos = productosCount === 0 && conteosCount === 0 && importacionesCount === 0;

  const stats = [
    {
      valor: productosCount,
      label: "Productos",
      descripcion: productosCount > 0 ? "Activos en el catálogo" : "Catálogo aún no implementado",
      icon: IconCaja,
      color: "brand",
    },
    {
      valor: revisionCount,
      label: "En revisión",
      descripcion: revisionCount > 0 ? "Pendientes en la bandeja" : "No hay productos en la bandeja",
      icon: IconClipboard,
      color: "violet",
    },
    {
      valor: conteosCount,
      label: "Conteos",
      descripcion: conteosCount > 0 ? "Registrados en total" : "Conteos aún no implementados",
      icon: IconBarras,
      color: "amber",
    },
    {
      valor: importacionesCount,
      label: "Importaciones",
      descripcion: importacionesCount > 0 ? "Realizadas en total" : "No se han realizado importaciones",
      icon: IconNube,
      color: "sky",
    },
  ] as const;

  const colorClases: Record<(typeof stats)[number]["color"], { icono: string; barra: string }> = {
    brand: { icono: "bg-brand-soft text-brand", barra: "bg-brand" },
    violet: { icono: "bg-violet-50 text-violet-600", barra: "bg-violet-400" },
    amber: { icono: "bg-amber-50 text-amber-600", barra: "bg-amber-400" },
    sky: { icono: "bg-sky-50 text-sky-600", barra: "bg-sky-400" },
  };

  return (
    <div>
      {/* Hero — tarjeta oscura a propósito: acento de marca sobre el resto de la
          página clara, igual que el mockup de referencia. */}
      <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-[#0a1416] via-[#0d2123] to-[#123430] p-10">
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.15]"
          preserveAspectRatio="none"
          viewBox="0 0 1200 300"
          aria-hidden
        >
          <path
            d="M0,150 C150,110 300,190 450,150 C600,110 750,190 900,150 C1050,110 1150,170 1200,150"
            stroke="#5eead4"
            strokeWidth="1"
            fill="none"
          />
          <path
            d="M0,200 C150,170 300,230 450,200 C600,170 750,230 900,200 C1050,170 1150,220 1200,205"
            stroke="#5eead4"
            strokeWidth="1"
            fill="none"
          />
          <path
            d="M0,100 C150,70 300,130 450,95 C600,60 750,120 900,90 C1050,60 1150,110 1200,90"
            stroke="#5eead4"
            strokeWidth="1"
            fill="none"
          />
        </svg>

        <div
          className="pointer-events-none absolute right-40 top-1/2 h-80 w-80 -translate-y-1/2 rounded-full bg-brand-bright/25 blur-3xl"
          aria-hidden
        />

        <div className="relative flex items-center justify-between gap-10">
          <div className="max-w-lg">
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              ¡Bienvenido, <span className="text-brand-bright">{perfil.nombre.split(" ")[0]}</span>!
            </h1>
            <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-brand-bright/30 bg-white/5 px-3 py-1 text-xs font-medium text-brand-bright">
              <IconEscudo className="h-3.5 w-3.5" />
              Rol: {ROL_LABEL[perfil.rol] ?? perfil.rol}
            </span>
            <p className="mt-4 text-sm leading-relaxed text-white/60">
              {sinDatos
                ? "Todavía no hay catálogo ni conteo implementados — eso llega en las próximas fases."
                : "Accedé rápido a lo que necesitás gestionar hoy."}
            </p>
          </div>
          <Image
            src="/ilustracion-bienvenida.png"
            alt=""
            width={260}
            height={260}
            className="relative mr-16 shrink-0"
            priority
            unoptimized
          />
        </div>
      </div>

      {/* Resumen rápido */}
      <div className="mt-8">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-muted" aria-hidden>
            <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
            <rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
            <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
            <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Resumen rápido
        </h2>

        <div className="mt-4 grid grid-cols-4 gap-4">
          {stats.map((s) => {
            const Icon = s.icon;
            const clases = colorClases[s.color];
            return (
              <div key={s.label} className="overflow-hidden rounded-lg border border-line bg-surface p-5">
                <div className={`flex h-10 w-10 items-center justify-center rounded-full ${clases.icono}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <p className="mt-3 text-3xl font-semibold tracking-tight text-ink">{s.valor}</p>
                <p className="mt-0.5 text-sm font-medium text-ink">{s.label}</p>
                <p className="mt-1 text-xs text-muted">{s.descripcion}</p>
                <div className={`-mx-5 -mb-5 mt-4 h-1 ${clases.barra}`} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Banner de cierre */}
      <div className="mt-6 flex items-center justify-between gap-6 rounded-lg border border-line bg-surface p-6">
        <div className="flex items-center gap-5">
          <Image
            src="/ilustracion-vacio.png"
            alt=""
            width={210}
            height={140}
            className="shrink-0"
            unoptimized
          />
          <div>
            <h3 className="font-medium text-ink">{sinDatos ? "Todo listo para comenzar" : "Seguí gestionando tu farmacia"}</h3>
            <p className="mt-1 text-sm text-muted">
              {sinDatos
                ? "Aún no hay datos cargados en el sistema. Usá las opciones del menú superior para empezar."
                : "Importá actualizaciones de catálogo o revisá lo que falta cargar en la bandeja de revisión."}
            </p>
          </div>
        </div>
        <Link
          href="/importar"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand/90"
        >
          Importar catálogo
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
