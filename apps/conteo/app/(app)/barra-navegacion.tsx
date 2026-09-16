"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { liveQuery } from "dexie";
import { House, ListChecks, Settings } from "lucide-react";
import { db } from "@/lib/db";

const TABS = [
  { href: "/", etiqueta: "Conteo", Icono: House },
  { href: "/productos", etiqueta: "Productos", Icono: ListChecks },
  { href: "/configuracion", etiqueta: "Configuración", Icono: Settings },
] as const;

/**
 * Barra de tabs fija abajo. Vive en el layout (no en cada página) para
 * que sea la misma en las tres pantallas.
 *
 * CUÁNDO SE MUESTRA — el layout es un Server Component y no ve el paso
 * local ("cargando" / "eligiendo" / "descargando" / "listo") de
 * conteo-app.tsx, así que en vez de levantar ese estado (que obligaría a
 * meter un context/provider alrededor de toda la máquina de estados, un
 * refactor que esta tarea no pide) la barra se pregunta a sí misma lo
 * mismo que conteo-app.tsx le pregunta a Dexie: si existe
 * meta("actual") Y su catálogo ya terminó de bajar. Esas dos condiciones
 * juntas son exactamente `paso === "listo"` — sin conteo elegido no hay
 * meta ("eligiendo"), y mientras baja el catálogo hay meta pero
 * catalogoListo sigue en false ("descargando"). Se usa liveQuery para
 * que la barra aparezca sola apenas la descarga termina, sin tener que
 * avisarle nada desde conteo-app.tsx.
 *
 * Excepción: en /productos y /configuracion la barra se muestra siempre.
 * Son rutas reales y, si alguien entra directo por URL (o cierra el
 * conteo desde Configuración), sin barra quedaría sin forma de volver.
 */
export function BarraNavegacion() {
  const pathname = usePathname();
  const [conteoListo, setConteoListo] = useState(false);

  useEffect(() => {
    const sub = liveQuery(() => db.meta.get("actual")).subscribe({
      next: (meta) => setConteoListo(Boolean(meta?.catalogoListo)),
      error: () => setConteoListo(false),
    });
    return () => sub.unsubscribe();
  }, []);

  const esRutaPropia = pathname !== "/";
  if (!conteoListo && !esRutaPropia) return null;

  return (
    <>
      {/* Reserva el alto de la barra: al ser `fixed` no empuja el
          contenido, y sin esto las últimas tarjetas de la lista quedan
          tapadas. */}
      <div aria-hidden className="h-[4.5rem] shrink-0" />
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line-light bg-surface pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto flex max-w-lg items-stretch">
          {TABS.map(({ href, etiqueta, Icono }) => {
            const activo = pathname === href;
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  aria-current={activo ? "page" : undefined}
                  className={`flex h-[4.5rem] flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors ${
                    activo ? "text-brand" : "text-soft"
                  }`}
                >
                  <Icono size={22} strokeWidth={activo ? 2.4 : 1.9} aria-hidden />
                  {etiqueta}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
