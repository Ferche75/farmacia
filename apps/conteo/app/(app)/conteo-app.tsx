"use client";

import { useEffect, useState } from "react";
import { db, type MetaConteo } from "@/lib/db";
import { descargarCatalogo, type ProgresoDescarga } from "@/lib/descargar-catalogo";
import { SeleccionConteo } from "./seleccion-conteo";
import { PantallaConteo } from "./pantalla-conteo";

export interface SucursalOpcion {
  id: string;
  nombre: string;
}

type Paso = "cargando" | "eligiendo" | "descargando" | "listo";

export function ConteoApp({
  perfilId,
  empresaId,
  sucursales,
}: {
  perfilId: string;
  empresaId: string;
  sucursales: SucursalOpcion[];
}) {
  const [paso, setPaso] = useState<Paso>("cargando");
  const [meta, setMeta] = useState<MetaConteo | null>(null);
  const [progreso, setProgreso] = useState<ProgresoDescarga | null>(null);
  // Distingue el refresco manual (desde adentro del conteo, "Actualizar
  // catálogo") de la descarga inicial: mismo paso "descargando" y misma
  // pantalla, pero el mensaje cambia — acá NO se está bajando por primera
  // vez, se está refrescando porque el catálogo del server cambió después
  // de que este dispositivo bajó el suyo (el caso real que lo disparó: un
  // producto se agregó/importó después de que el operario ya había
  // arrancado a contar, y su copia local no lo tenía).
  const [esActualizacion, setEsActualizacion] = useState(false);

  useEffect(() => {
    let cancelado = false;

    async function iniciar() {
      const existente = await db.meta.get("actual");

      if (!existente) {
        if (!cancelado) setPaso("eligiendo");
        return;
      }

      if (existente.catalogoListo) {
        if (!cancelado) {
          setMeta(existente);
          setPaso("listo");
        }
        return;
      }

      // Había un conteo elegido pero la descarga del catálogo se cortó a
      // mitad de camino (se cerró la app) — se reintenta sola.
      if (!cancelado) setPaso("descargando");
      await descargarCatalogo((p) => !cancelado && setProgreso(p));
      const actualizado = await db.meta.get("actual");
      if (!cancelado) {
        setMeta(actualizado ?? null);
        setPaso(actualizado ? "listo" : "eligiendo");
      }
    }

    iniciar();
    return () => {
      cancelado = true;
    };
  }, []);

  async function onConteoElegido(nuevoMeta: MetaConteo) {
    await db.meta.put(nuevoMeta);
    setMeta(nuevoMeta);
    setEsActualizacion(false);
    setPaso("descargando");
    await descargarCatalogo((p) => setProgreso(p));
    const actualizado = await db.meta.get("actual");
    setMeta(actualizado ?? null);
    setPaso("listo");
  }

  // Refresco manual desde adentro del conteo (botón "Actualizar catálogo"
  // en pantalla-conteo.tsx): NO toca `meta`/`db.lineas` — el conteo sigue
  // siendo el mismo, con lo ya escaneado intacto. Solo vuelve a bajar
  // db.catalogo entero (mismo `descargarCatalogo` que la carga inicial,
  // que ya hace `clear()` + `bulkPut`), así que un producto nuevo en el
  // servidor pasa a estar disponible para escanear sin tener que cerrar
  // el conteo y volver a entrar.
  async function onActualizarCatalogo() {
    setEsActualizacion(true);
    setPaso("descargando");
    await descargarCatalogo((p) => setProgreso(p));
    setPaso("listo");
  }

  async function onCerrarConteo() {
    await db.meta.delete("actual");
    setMeta(null);
    setProgreso(null);
    setPaso("eligiendo");
  }

  if (paso === "cargando") {
    return <div className="flex flex-1 items-center justify-center text-muted">Cargando…</div>;
  }

  if (paso === "eligiendo") {
    return (
      <SeleccionConteo
        perfilId={perfilId}
        empresaId={empresaId}
        sucursales={sucursales}
        onElegido={onConteoElegido}
      />
    );
  }

  if (paso === "descargando") {
    const pct = progreso && progreso.total > 0 ? Math.round((progreso.descargados / progreso.total) * 100) : 0;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
        <div className="h-1.5 w-64 overflow-hidden rounded-full bg-ink-3">
          <div
            className="h-full rounded-full bg-brand transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div>
          <p className="text-base text-paper">
            {esActualizacion ? "Actualizando catálogo…" : "Bajando catálogo para trabajar offline"}
          </p>
          <p className="mt-1 text-sm text-muted tabular-nums">
            {progreso ? `${progreso.descargados.toLocaleString("es-BO")} / ${progreso.total.toLocaleString("es-BO")}` : "…"}
          </p>
        </div>
      </div>
    );
  }

  if (paso === "listo" && meta) {
    return (
      <PantallaConteo
        meta={meta}
        empresaId={empresaId}
        onCerrarConteo={onCerrarConteo}
        onActualizarCatalogo={onActualizarCatalogo}
      />
    );
  }

  return null;
}
