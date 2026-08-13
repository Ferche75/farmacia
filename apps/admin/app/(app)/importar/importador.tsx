"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createBrowserClient,
  iniciarImportacion,
  previsualizarImportacion,
  confirmarImportacionLote,
  finalizarImportacion,
  TAMANO_LOTE_IMPORTACION,
  type Json,
  type ResultadoPrevisualizacion,
} from "@farmacia/db";
import { CAMPOS_SISTEMA, MAPEO_VACIO, type MapeoColumnas } from "@/lib/campos-sistema";
import { parseArchivo, aplicarMapeo, trocear, type ArchivoParseado } from "@/lib/importacion";

type Paso = "laboratorio" | "mapeo" | "preview" | "confirmando" | "listo";

const PASOS: { paso: Paso; label: string }[] = [
  { paso: "laboratorio", label: "Archivo" },
  { paso: "mapeo", label: "Mapeo" },
  { paso: "preview", label: "Revisión" },
  { paso: "listo", label: "Listo" },
];

interface MapeoGuardado {
  id: string;
  nombre: string;
  mapeo: MapeoColumnas;
}

interface SucursalOpcion {
  id: string;
  nombre: string;
}

interface Progreso {
  lote: number;
  totalLotes: number;
  creados: number;
  actualizados: number;
  rechazados: number;
}

export function Importador({
  empresaId,
  sucursales,
}: {
  empresaId: string;
  sucursales: SucursalOpcion[];
}) {
  const supabase = useMemo(() => createBrowserClient(), []);

  const [paso, setPaso] = useState<Paso>("laboratorio");
  const [sucursalId, setSucursalId] = useState("");
  const [laboratorio, setLaboratorio] = useState("");
  const [margen, setMargen] = useState("");
  const [archivo, setArchivo] = useState<ArchivoParseado | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState("");
  const [mapeo, setMapeo] = useState<MapeoColumnas>(MAPEO_VACIO);
  const [mapeosGuardados, setMapeosGuardados] = useState<MapeoGuardado[]>([]);
  const [preview, setPreview] = useState<ResultadoPrevisualizacion | null>(null);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    supabase
      .from("mapeos_columnas")
      .select("id, nombre, mapeo")
      .order("nombre")
      .then(({ data }) => {
        if (data) {
          setMapeosGuardados(
            data.map((m) => ({ id: m.id, nombre: m.nombre, mapeo: m.mapeo as unknown as MapeoColumnas }))
          );
        }
      });
  }, [supabase]);

  const camposFaltantes = CAMPOS_SISTEMA.filter((c) => c.requerido && !mapeo[c.campo]);
  const pasoIndex = paso === "confirmando" ? 2 : PASOS.findIndex((p) => p.paso === paso);

  async function onArchivoElegido(file: File) {
    setError(null);
    setCargando(true);
    try {
      const parseado = await parseArchivo(file);
      setArchivo(parseado);
      setNombreArchivo(file.name);
      setPaso("mapeo");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo leer el archivo.");
    } finally {
      setCargando(false);
    }
  }

  async function guardarMapeo() {
    const nombrePreset = laboratorio.trim();
    if (!nombrePreset) return;
    setCargando(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from("mapeos_columnas")
        .upsert(
          { empresa_id: empresaId, nombre: nombrePreset, mapeo: mapeo as unknown as Json },
          { onConflict: "empresa_id,nombre" }
        )
        .select("id, nombre, mapeo")
        .single();
      if (err) throw err;
      if (data) {
        setMapeosGuardados((prev) => {
          const sinEste = prev.filter((m) => m.id !== data.id);
          return [...sinEste, { id: data.id, nombre: data.nombre, mapeo: data.mapeo as unknown as MapeoColumnas }].sort(
            (a, b) => a.nombre.localeCompare(b.nombre)
          );
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar el mapeo.");
    } finally {
      setCargando(false);
    }
  }

  async function irAPreview() {
    if (!archivo) return;
    setCargando(true);
    setError(null);
    try {
      const filas = aplicarMapeo(archivo.filas, mapeo, margen ? Number(margen) : undefined);
      const resultado = await previsualizarImportacion(supabase, laboratorio.trim() || null, filas);
      setPreview(resultado);
      setPaso("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo previsualizar la importación.");
    } finally {
      setCargando(false);
    }
  }

  async function confirmar() {
    if (!archivo) return;
    setPaso("confirmando");
    setError(null);
    try {
      const filas = aplicarMapeo(archivo.filas, mapeo, margen ? Number(margen) : undefined);
      const importacionId = await iniciarImportacion(
        supabase,
        nombreArchivo,
        mapeo as unknown as Json,
        sucursalId || null
      );
      const lotes = trocear(filas, TAMANO_LOTE_IMPORTACION);

      let acc = { creados: 0, actualizados: 0, rechazados: 0 };
      for (let i = 0; i < lotes.length; i++) {
        const r = await confirmarImportacionLote(supabase, importacionId, laboratorio.trim() || null, lotes[i]);
        acc = {
          creados: acc.creados + r.creados,
          actualizados: acc.actualizados + r.actualizados,
          rechazados: acc.rechazados + r.rechazados,
        };
        setProgreso({ lote: i + 1, totalLotes: lotes.length, ...acc });
      }

      await finalizarImportacion(supabase, importacionId);
      setPaso("listo");
    } catch (e) {
      setError(e instanceof Error ? e.message : "La importación falló a mitad de camino.");
    }
  }

  function empezarDeNuevo() {
    setPaso("laboratorio");
    setSucursalId("");
    setLaboratorio("");
    setMargen("");
    setArchivo(null);
    setNombreArchivo("");
    setMapeo(MAPEO_VACIO);
    setPreview(null);
    setProgreso(null);
    setError(null);
  }

  return (
    <div className="max-w-5xl">
      <ol className="mb-6 flex items-center gap-2 text-xs font-medium">
        {PASOS.map((p, i) => (
          <li key={p.paso} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-6 bg-line" />}
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                i === pasoIndex
                  ? "bg-brand-soft text-brand"
                  : i < pasoIndex
                    ? "text-muted"
                    : "text-muted/60"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${i <= pasoIndex ? "bg-brand" : "bg-line"}`}
              />
              {p.label}
            </span>
          </li>
        ))}
      </ol>

      {error && (
        <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {paso === "laboratorio" && (
        <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-6">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Sucursal *</label>
            <select
              value={sucursalId}
              onChange={(e) => setSucursalId(e.target.value)}
              className="input"
            >
              <option value="">-- elegir --</option>
              {sucursales.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted">
              De qué sucursal es este archivo — queda registrado en la importación. El costo/precio se guarda
              para toda la empresa igual, no varía entre sucursales.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Laboratorio — opcional</label>
            <input
              type="text"
              value={laboratorio}
              onChange={(e) => setLaboratorio(e.target.value)}
              placeholder="Ej: Bagó"
              className="input"
            />
            <p className="mt-1.5 text-xs text-muted">
              Solo hace falta si el archivo NO trae su propia columna &quot;Laboratorio&quot; por fila (para
              archivos que mezclan varios proveedores, mapeá esa columna en el paso siguiente en vez de
              completar esto). Los mapeos guardados se buscan por este nombre.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Margen sobre costo (%) — opcional</label>
            <input
              type="number"
              value={margen}
              onChange={(e) => setMargen(e.target.value)}
              placeholder="Ej: 30"
              className="input"
            />
            <p className="mt-1.5 text-xs text-muted">
              Si una fila trae costo pero no precio, calcula el precio de venta con este margen. Dejalo vacío si el
              archivo ya trae precio o si preferís cargarlo a mano después.
            </p>
          </div>

          {mapeosGuardados.length > 0 && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Mapeo guardado (opcional)</label>
              <select
                className="input"
                onChange={(e) => {
                  const elegido = mapeosGuardados.find((m) => m.id === e.target.value);
                  if (elegido) {
                    setMapeo(elegido.mapeo);
                    if (!laboratorio) setLaboratorio(elegido.nombre);
                  }
                }}
                defaultValue=""
              >
                <option value="">-- ninguno --</option>
                {mapeosGuardados.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nombre}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Archivo (.csv o .xlsx)</label>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              disabled={!sucursalId || cargando}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onArchivoElegido(file);
              }}
              className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand disabled:opacity-50"
            />
            {!sucursalId && <p className="mt-1.5 text-xs text-muted">Elegí la sucursal primero.</p>}
          </div>
        </div>
      )}

      {paso === "mapeo" && archivo && (
        <div className="space-y-4 rounded-lg border border-line bg-surface p-6">
          <p className="text-sm text-muted">
            {nombreArchivo} — {archivo.filas.length} filas detectadas. Asociá cada campo del sistema a una columna del archivo.
          </p>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="pb-2 font-medium">Campo del sistema</th>
                <th className="pb-2 font-medium">Columna del archivo</th>
              </tr>
            </thead>
            <tbody>
              {CAMPOS_SISTEMA.map((c) => (
                <tr key={c.campo} className="border-t border-line">
                  <td className="py-2 pr-4 text-ink">
                    {c.label}
                    {c.requerido && <span className="text-danger"> *</span>}
                  </td>
                  <td className="py-2">
                    <select
                      className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
                      value={mapeo[c.campo]}
                      onChange={(e) => setMapeo((prev) => ({ ...prev, [c.campo]: e.target.value }))}
                    >
                      <option value="">-- no mapear --</option>
                      {archivo.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {camposFaltantes.length > 0 && (
            <p className="rounded-md border border-warn/20 bg-warn-soft px-3 py-2 text-sm text-warn">
              Falta mapear: {camposFaltantes.map((c) => c.label).join(", ")}.
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={guardarMapeo}
              disabled={cargando}
              className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-50"
            >
              Guardar mapeo como &quot;{laboratorio.trim() || "..."}&quot;
            </button>
            <button
              onClick={irAPreview}
              disabled={cargando || camposFaltantes.length > 0}
              className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {cargando ? "Previsualizando…" : "Previsualizar"}
            </button>
            <button onClick={empezarDeNuevo} className="text-sm text-muted transition-colors hover:text-ink">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {paso === "preview" && preview && (
        <div className="space-y-4 rounded-lg border border-line bg-surface p-6">
          <div className="flex gap-6 text-sm">
            <span className="text-ink">Total: <strong className="font-mono">{preview.total}</strong></span>
            <span className="text-ok">Crear: <strong className="font-mono">{preview.crear}</strong></span>
            <span className="text-brand">Actualizar: <strong className="font-mono">{preview.actualizar}</strong></span>
            <span className="text-danger">Rechazar: <strong className="font-mono">{preview.rechazar}</strong></span>
          </div>

          <div className="max-h-96 overflow-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-paper">
                <tr className="text-left text-muted">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Código</th>
                  <th className="px-3 py-2 font-medium">Acción</th>
                  <th className="px-3 py-2 font-medium">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {preview.filas.slice(0, 20).map((f) => (
                  <tr key={f.fila_index} className="border-t border-line">
                    <td className="px-3 py-1.5 text-muted">{f.fila_index + 1}</td>
                    <td className="px-3 py-1.5 font-mono text-ink">
                      {f.codigo_barra || (f.nombre ? `"${f.nombre}" (por nombre)` : "—")}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          f.accion === "crear"
                            ? "text-ok"
                            : f.accion === "actualizar"
                              ? "text-brand"
                              : "text-danger"
                        }
                      >
                        {f.accion}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-muted">{f.motivo ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.filas.length > 20 && (
              <p className="border-t border-line px-3 py-2 text-xs text-muted">
                Mostrando las primeras 20 de {preview.filas.length} filas.
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={confirmar}
              className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90"
            >
              Confirmar importación
            </button>
            <button onClick={() => setPaso("mapeo")} className="text-sm text-muted transition-colors hover:text-ink">
              Volver a mapear
            </button>
          </div>
        </div>
      )}

      {paso === "confirmando" && (
        <div className="max-w-lg rounded-lg border border-line bg-surface p-6">
          <p className="mb-3 text-sm text-ink">
            Procesando lote {progreso?.lote ?? 0} de {progreso?.totalLotes ?? "…"}…
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-paper">
            <div
              className="h-full bg-brand transition-all"
              style={{
                width: progreso ? `${(progreso.lote / progreso.totalLotes) * 100}%` : "0%",
              }}
            />
          </div>
          {progreso && (
            <p className="mt-3 font-mono text-xs text-muted">
              Creados: {progreso.creados} · Actualizados: {progreso.actualizados} · Rechazados: {progreso.rechazados}
            </p>
          )}
        </div>
      )}

      {paso === "listo" && progreso && (
        <div className="max-w-lg rounded-lg border border-line bg-surface p-6">
          <p className="mb-3 text-lg font-semibold text-ink">Importación completa</p>
          <p className="font-mono text-sm text-muted">
            {progreso.creados} creados, {progreso.actualizados} actualizados, {progreso.rechazados} rechazados.
          </p>
          <button
            onClick={empezarDeNuevo}
            className="mt-4 rounded-md bg-brand px-3 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90"
          >
            Nueva importación
          </button>
        </div>
      )}
    </div>
  );
}
