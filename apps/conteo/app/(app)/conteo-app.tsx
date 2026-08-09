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
    setPaso("descargando");
    await descargarCatalogo((p) => setProgreso(p));
    const actualizado = await db.meta.get("actual");
    setMeta(actualizado ?? null);
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
          <p className="text-base text-paper">Bajando catálogo para trabajar offline</p>
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
      />
    );
  }

  return null;
}
