"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@farmacia/db";
import { PanelLista } from "./panel-lista";
import { PanelDetalle } from "./panel-detalle";
import type { DesconocidoItem, EstadoDesconocido, OpcionSimple, RespuestaIA } from "./tipos";

const ESTADOS_VISIBLES: EstadoDesconocido[] = ["pendiente_ia", "sugerido", "no_reconocido"];

export function Bandeja({ empresaId }: { empresaId: string }) {
  const supabase = useMemo(() => createBrowserClient(), []);

  const [items, setItems] = useState<DesconocidoItem[]>([]);
  const [sucursales, setSucursales] = useState<OpcionSimple[]>([]);
  const [conteos, setConteos] = useState<OpcionSimple[]>([]);
  const [cargando, setCargando] = useState(true);

  const [estadosFiltro, setEstadosFiltro] = useState<Set<EstadoDesconocido>>(
    new Set(ESTADOS_VISIBLES)
  );
  const [sucursalFiltro, setSucursalFiltro] = useState<string>("");
  const [conteoFiltro, setConteoFiltro] = useState<string>("");
  const [desde, setDesde] = useState<string>("");
  const [hasta, setHasta] = useState<string>("");

  const [seleccionadoId, setSeleccionadoId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);

    const { data: desconocidos } = await supabase
      .from("desconocidos")
      .select("id, codigo_norm, codigo_raw, foto_path, estado, ia_respuesta, ia_confianza, created_at")
      .eq("empresa_id", empresaId)
      .neq("estado", "resuelto")
      .order("created_at", { ascending: false });

    const ids = (desconocidos ?? []).map((d) => d.id);

    // Sucursal/conteo de un desconocido se derivan por las líneas de
    // conteo que lo referencian (la tabla desconocidos es a nivel
    // empresa, no sucursal — puede haber sido escaneado en más de un
    // conteo/sucursal antes de resolverse). Se resuelve en JS en vez de
    // un filtro embebido de PostgREST para no depender de una sintaxis
    // de join que no se pudo verificar sin una instancia real corriendo.
    let lineasPorDesconocido = new Map<string, string[]>();
    let sucursalPorConteo = new Map<string, string>();
    let opcionesConteos: OpcionSimple[] = [];
    let opcionesSucursales: OpcionSimple[] = [];

    if (ids.length > 0) {
      const { data: lineas } = await supabase
        .from("conteo_lineas")
        .select("desconocido_id, conteo_id")
        .in("desconocido_id", ids);

      const conteoIds = Array.from(new Set((lineas ?? []).map((l) => l.conteo_id)));

      const { data: conteosData } = conteoIds.length
        ? await supabase.from("conteos").select("id, nombre, sucursal_id").in("id", conteoIds)
        : { data: [] };

      const sucursalIds = Array.from(new Set((conteosData ?? []).map((c) => c.sucursal_id)));

      const { data: sucursalesData } = sucursalIds.length
        ? await supabase.from("sucursales").select("id, nombre").in("id", sucursalIds)
        : { data: [] };

      opcionesSucursales = (sucursalesData ?? []).map((s) => ({ id: s.id, nombre: s.nombre }));
      opcionesConteos = (conteosData ?? []).map((c) => ({ id: c.id, nombre: c.nombre }));
      sucursalPorConteo = new Map((conteosData ?? []).map((c) => [c.id, c.sucursal_id]));

      lineasPorDesconocido = new Map();
      for (const l of lineas ?? []) {
        if (!l.desconocido_id) continue;
        const arr = lineasPorDesconocido.get(l.desconocido_id) ?? [];
        arr.push(l.conteo_id);
        lineasPorDesconocido.set(l.desconocido_id, arr);
      }
    }

    const armados: DesconocidoItem[] = (desconocidos ?? []).map((d) => {
      const conteoIds = lineasPorDesconocido.get(d.id) ?? [];
      const sucursalIds = Array.from(
        new Set(conteoIds.map((cid) => sucursalPorConteo.get(cid)).filter((x): x is string => !!x))
      );
      return {
        id: d.id,
        codigo_norm: d.codigo_norm,
        codigo_raw: d.codigo_raw,
        foto_path: d.foto_path,
        estado: d.estado,
        ia_respuesta: d.ia_respuesta as unknown as RespuestaIA | null,
        ia_confianza: d.ia_confianza,
        created_at: d.created_at,
        sucursalIds,
        conteoIds,
      };
    });

    setItems(armados);
    setSucursales(opcionesSucursales);
    setConteos(opcionesConteos);
    setCargando(false);
  }, [supabase, empresaId]);

  useEffect(() => {
    async function ejecutar() {
      await cargar();
    }
    ejecutar();
  }, [cargar]);

  const contadores = useMemo(() => {
    const c: Record<EstadoDesconocido, number> = {
      pendiente_ia: 0,
      sugerido: 0,
      no_reconocido: 0,
      resuelto: 0,
    };
    for (const it of items) c[it.estado]++;
    return c;
  }, [items]);

  const filtrados = useMemo(() => {
    return items.filter((it) => {
      if (!estadosFiltro.has(it.estado)) return false;
      if (sucursalFiltro && !it.sucursalIds.includes(sucursalFiltro)) return false;
      if (conteoFiltro && !it.conteoIds.includes(conteoFiltro)) return false;
      if (desde && it.created_at < desde) return false;
      if (hasta && it.created_at > `${hasta}T23:59:59`) return false;
      return true;
    });
  }, [items, estadosFiltro, sucursalFiltro, conteoFiltro, desde, hasta]);

  // Auto-selección cuando cambia la lista filtrada — durante el render,
  // no en un efecto (mismo criterio que tarjeta-sugerencia.tsx en
  // apps/conteo: "Adjusting state when a prop changes" de la doc de
  // React, evita el render-en-cascada de react-hooks/set-state-in-effect).
  const [filtradosPrevios, setFiltradosPrevios] = useState<DesconocidoItem[] | null>(null);
  if (filtrados !== filtradosPrevios) {
    setFiltradosPrevios(filtrados);
    if (filtrados.length === 0) {
      setSeleccionadoId(null);
    } else if (!filtrados.some((it) => it.id === seleccionadoId)) {
      setSeleccionadoId(filtrados[0].id);
    }
  }

  const indiceActual = filtrados.findIndex((it) => it.id === seleccionadoId);
  const actual = indiceActual >= 0 ? filtrados[indiceActual] : null;

  function irA(indice: number) {
    if (indice < 0 || indice >= filtrados.length) return;
    setSeleccionadoId(filtrados[indice].id);
  }

  function onResueltoOCartado() {
    setItems((prev) => prev.filter((it) => it.id !== actual?.id));
  }

  return (
    <div className="flex flex-1 gap-4 overflow-hidden">
      <PanelLista
        items={filtrados}
        contadores={contadores}
        cargando={cargando}
        sucursales={sucursales}
        conteos={conteos}
        estadosFiltro={estadosFiltro}
        onEstadosFiltroChange={setEstadosFiltro}
        sucursalFiltro={sucursalFiltro}
        onSucursalFiltroChange={setSucursalFiltro}
        conteoFiltro={conteoFiltro}
        onConteoFiltroChange={setConteoFiltro}
        desde={desde}
        onDesdeChange={setDesde}
        hasta={hasta}
        onHastaChange={setHasta}
        seleccionadoId={seleccionadoId}
        onSeleccionar={setSeleccionadoId}
      />
      <PanelDetalle
        item={actual}
        onAnterior={() => irA(indiceActual - 1)}
        onSiguiente={() => irA(indiceActual + 1)}
        onResuelto={onResueltoOCartado}
      />
    </div>
  );
}
