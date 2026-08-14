"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createBrowserClient, cerrarConteo, crearProductoYContar, type NuevoProductoManual } from "@farmacia/db";
import { db, type LineaLocal, type LineaDesconocidoLocal, type MetaConteo } from "@/lib/db";
import {
  procesarEscaneo,
  deshacerUltimoEscaneo,
  establecerCantidad,
  generarUuid,
  dispositivoActual,
  type ResultadoEscaneo,
} from "@/lib/motor-escaneo";
import {
  esDesconocidoConocido,
  procesarReescaneoDesconocido,
  establecerCantidadDesconocido,
  obtenerFotoLocal,
  agregarProductoManualAProductoLocal,
} from "@/lib/motor-desconocidos";
import { comprimirImagen } from "@/lib/foto";
import { UNIDADES_PRESENTACION, UNIDADES_CONCENTRACION } from "@/lib/campos-producto";
import { suscribirCambiosCatalogo } from "@/lib/descargar-catalogo";
import {
  sincronizarPendientes,
  sincronizarDesconocidosPendientes,
  iniciarSyncAutomatico,
  contarPendientes,
} from "@/lib/motor-sync";
import {
  feedbackEncontrado,
  feedbackNoEncontrado,
  feedbackDuplicado,
  feedbackCodigoInvalido,
} from "@/lib/feedback";
import { TarjetaSugerencia } from "./tarjeta-sugerencia";

// Tiempo de inactividad tras el cual se da por terminada una lectura si
// el lector NO manda Enter/Tab (algunos lectores HID mandan otra tecla,
// o ninguna — ver docs/decisiones.md). Un lector típico tipea un código
// entero en unos pocos ms; una persona tipeando a mano tarda bastante
// más entre teclas, así que 80ms alcanza para separar ambos casos sin
// notarse como demora. Si SÍ llega Enter/Tab, se procesa al toque y este
// timeout ni se espera.
const IDLE_MS = 80;

type Feedback =
  | { tipo: "encontrado"; linea: LineaLocal; unidadesPorCodigo: number }
  | { tipo: "desconocido_conocido"; linea: LineaDesconocidoLocal; foto: Blob | null }
  | { tipo: "no_encontrado"; codigoRaw: string; codigoNorm: string }
  | { tipo: "duplicado"; codigoRaw: string }
  | { tipo: "codigo_invalido"; codigoRaw: string }
  | null;

function urlDeFoto(blob: Blob | null): string | null {
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

export function PantallaConteo({
  meta,
  empresaId,
  onCerrarConteo,
}: {
  meta: MetaConteo;
  empresaId: string;
  onCerrarConteo: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fotoInputRef = useRef<HTMLInputElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esperandoFotoRef = useRef<{ codigoRaw: string; codigoNorm: string } | null>(null);

  const [lineas, setLineas] = useState<LineaLocal[]>([]);
  const [lineasDesc, setLineasDesc] = useState<LineaDesconocidoLocal[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pendientes, setPendientes] = useState(0);
  const [mostrarCantidadManual, setMostrarCantidadManual] = useState(false);
  const [codigoManual, setCodigoManual] = useState("");
  const [cantidadManual, setCantidadManual] = useState("1");
  const [editando, setEditando] = useState<string | null>(null);
  const [valorEdicion, setValorEdicion] = useState("");
  const [subiendoFoto, setSubiendoFoto] = useState(false);
  const [confirmandoCierre, setConfirmandoCierre] = useState(false);
  const [cerrando, setCerrando] = useState(false);
  const [errorCierre, setErrorCierre] = useState<string | null>(null);

  // Formulario de carga que se abre apenas se saca la foto de un "No
  // encontrado" — CONTEXTO.md / decisión 2026-08-14: sacar la foto Y
  // completar los datos son un solo paso, no dos (la IA no es un paso
  // obligatorio, quien cuenta carga el producto ahí mismo mirando la
  // caja). `fotoCapturada` es solo de referencia en pantalla mientras se
  // completa el form — no se sube ni se guarda en ningún lado.
  const [cargandoProducto, setCargandoProducto] = useState(false);
  const [fotoCapturada, setFotoCapturada] = useState<Blob | null>(null);
  const [formCarga, setFormCarga] = useState({
    nombre: "",
    laboratorio: "",
    concentracionValor: "",
    concentracionUnidad: "mg",
    contenido: "",
    unidad: "",
  });
  const [guardandoProducto, setGuardandoProducto] = useState(false);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const refrescarLineas = useCallback(async () => {
    const todas = await db.lineas.where("conteoId").equals(meta.conteoId).toArray();
    todas.sort((a, b) => b.ultimoEscaneoAt - a.ultimoEscaneoAt);
    setLineas(todas);

    const desc = await db.lineasDesconocidos.where("conteoId").equals(meta.conteoId).toArray();
    desc.sort((a, b) => b.ultimoEscaneoAt - a.ultimoEscaneoAt);
    setLineasDesc(desc);
  }, [meta.conteoId]);

  const refrescarPendientes = useCallback(async () => {
    setPendientes(await contarPendientes(meta.conteoId));
  }, [meta.conteoId]);

  useEffect(() => {
    async function cargarInicial() {
      await refrescarLineas();
      await refrescarPendientes();
      // sync inmediato al abrir (por si quedó algo pendiente de una sesión anterior)
      await sincronizarPendientes(meta.conteoId);
      await sincronizarDesconocidosPendientes(empresaId, meta.conteoId);
      await refrescarPendientes();
    }
    cargarInicial();

    const detener = iniciarSyncAutomatico(empresaId, meta.conteoId, () => {
      refrescarPendientes();
    });
    const detenerCatalogo = suscribirCambiosCatalogo();

    return () => {
      detener();
      detenerCatalogo();
    };
  }, [empresaId, meta.conteoId, refrescarLineas, refrescarPendientes]);

  function reenfocar() {
    inputRef.current?.focus();
  }

  useEffect(() => {
    reenfocar();
  }, []);

  async function ejecutarEscaneo(codigoRaw: string, delta = 1, saltarDebounce = false) {
    const resultado: ResultadoEscaneo = await procesarEscaneo({
      conteoId: meta.conteoId,
      codigoRaw,
      delta,
      saltarDebounce,
    });

    switch (resultado.tipo) {
      case "encontrado":
        feedbackEncontrado();
        setFeedback({ tipo: "encontrado", linea: resultado.linea, unidadesPorCodigo: resultado.unidadesPorCodigo });
        await refrescarLineas();
        await refrescarPendientes();
        break;

      case "no_encontrado": {
        const codigoNorm = resultado.codigoNorm!;
        if (await esDesconocidoConocido(codigoNorm)) {
          // Ya se sabe qué es este código (lo trajo el catálogo o lo
          // sacó este dispositivo antes) — no hace falta otra foto,
          // solo sumar 1 (CONTEXTO.md / Fase 4).
          const linea = await procesarReescaneoDesconocido({
            conteoId: meta.conteoId,
            codigoRaw,
            codigoNorm,
            delta,
          });
          const foto = await obtenerFotoLocal(codigoNorm);
          feedbackEncontrado();
          setFeedback({ tipo: "desconocido_conocido", linea, foto });
          await refrescarLineas();
          await refrescarPendientes();
        } else {
          feedbackNoEncontrado();
          setFeedback({ tipo: "no_encontrado", codigoRaw: resultado.codigoRaw, codigoNorm });
        }
        break;
      }

      case "duplicado":
        feedbackDuplicado();
        setFeedback({ tipo: "duplicado", codigoRaw: resultado.codigoRaw });
        break;

      case "codigo_invalido":
        feedbackCodigoInvalido();
        setFeedback({ tipo: "codigo_invalido", codigoRaw: resultado.codigoRaw });
        break;
    }
  }

  function limpiarTimeout() {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  function procesarValorDelInput() {
    const valor = inputRef.current?.value.trim() ?? "";
    if (inputRef.current) inputRef.current.value = "";
    limpiarTimeout();
    if (!valor) return;
    ejecutarEscaneo(valor);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      procesarValorDelInput();
    }
  }

  function onChangeInput() {
    limpiarTimeout();
    timeoutRef.current = setTimeout(procesarValorDelInput, IDLE_MS);
  }

  async function onDeshacer() {
    const ok = await deshacerUltimoEscaneo(meta.conteoId);
    if (ok) {
      await refrescarLineas();
      await refrescarPendientes();
    }
    reenfocar();
  }

  async function onCantidadManualSubmit() {
    const n = parseInt(cantidadManual, 10);
    if (!codigoManual.trim() || !n || n <= 0) return;
    await ejecutarEscaneo(codigoManual.trim(), n, true);
    setCodigoManual("");
    setCantidadManual("1");
    setMostrarCantidadManual(false);
    reenfocar();
  }

  function empezarEdicion(id: string, cantidadActual: number) {
    setEditando(id);
    setValorEdicion(String(cantidadActual));
  }

  async function guardarEdicionProducto(lineaId: string) {
    const n = parseInt(valorEdicion, 10);
    if (!isNaN(n) && n >= 0) {
      await establecerCantidad(lineaId, n);
      await refrescarLineas();
      await refrescarPendientes();
    }
    setEditando(null);
    reenfocar();
  }

  async function guardarEdicionDesconocido(codigoNorm: string) {
    const n = parseInt(valorEdicion, 10);
    if (!isNaN(n) && n >= 0) {
      await establecerCantidadDesconocido(meta.conteoId, codigoNorm, n);
      await refrescarLineas();
      await refrescarPendientes();
    }
    setEditando(null);
    reenfocar();
  }

  function onClickTomarFoto(codigoRaw: string, codigoNorm: string) {
    esperandoFotoRef.current = { codigoRaw, codigoNorm };
    fotoInputRef.current?.click();
  }

  // Sacar la foto y completar los datos son un solo paso: apenas se saca
  // la foto se abre el formulario, ahí mismo, sin esperar a que la IA
  // responda — la foto queda en pantalla como referencia para completarlo
  // mirando la caja, pero no se sube ni se manda a ningún lado.
  async function onFotoSeleccionada(e: React.ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    e.target.value = ""; // permite volver a elegir el mismo archivo después
    const esperando = esperandoFotoRef.current;
    esperandoFotoRef.current = null;
    if (!archivo || !esperando) return;

    setSubiendoFoto(true);
    try {
      const comprimida = await comprimirImagen(archivo);
      setFotoCapturada(comprimida);
      setFormCarga({
        nombre: "",
        laboratorio: "",
        concentracionValor: "",
        concentracionUnidad: "mg",
        contenido: "",
        unidad: "",
      });
      setErrorCarga(null);
      setCargandoProducto(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo procesar la foto.");
    } finally {
      setSubiendoFoto(false);
    }
  }

  // crear_producto_y_contar requiere estar online — es una llamada
  // directa igual que "Aceptar" en TarjetaSugerencia, no se encola para
  // sincronizar después.
  async function guardarProductoCargado() {
    if (feedback?.tipo !== "no_encontrado" || !formCarga.nombre.trim()) return;

    setGuardandoProducto(true);
    setErrorCarga(null);
    try {
      const concentracion = formCarga.concentracionValor.trim()
        ? `${formCarga.concentracionValor.trim()} ${formCarga.concentracionUnidad}`
        : null;
      const nuevoProducto: NuevoProductoManual = {
        nombre: formCarga.nombre.trim(),
        laboratorio: formCarga.laboratorio || null,
        concentracion,
        contenido: formCarga.contenido ? Number(formCarga.contenido) : null,
        unidad: formCarga.unidad || null,
      };

      const supabase = createBrowserClient();
      const resultado = await crearProductoYContar(supabase, {
        conteoId: meta.conteoId,
        codigoRaw: feedback.codigoRaw,
        clientUuid: generarUuid(),
        nuevoProducto,
        dispositivo: dispositivoActual(),
      });

      if (!("duplicado" in resultado)) {
        await agregarProductoManualAProductoLocal({
          conteoId: meta.conteoId,
          codigoNorm: feedback.codigoNorm,
          productoId: resultado.productoId,
          nombre: nuevoProducto.nombre,
          laboratorio: nuevoProducto.laboratorio ?? null,
          concentracion,
          contenido: nuevoProducto.contenido ?? null,
          unidad: nuevoProducto.unidad ?? null,
          cantidad: 1,
        });
        const lineaLocal = await db.lineas.get(`${meta.conteoId}:${resultado.productoId}`);
        feedbackEncontrado();
        setFeedback(lineaLocal ? { tipo: "encontrado", linea: lineaLocal, unidadesPorCodigo: 1 } : null);
        await refrescarLineas();
        await refrescarPendientes();
      }

      setCargandoProducto(false);
      setFotoCapturada(null);
    } catch (e) {
      setErrorCarga(e instanceof Error ? e.message : "No se pudo crear el producto.");
    } finally {
      setGuardandoProducto(false);
      reenfocar();
    }
  }

  async function abrirConfirmacionCierre() {
    setErrorCierre(null);
    setCerrando(true);
    // Forzar un último intento de sync antes de dejar cerrar — cerrado
    // el conteo en el servidor, cualquier escaneo que haya quedado en la
    // cola local ya no se va a poder mandar nunca (registrar_escaneos_batch
    // rechaza escrituras sobre un conteo con estado <> 'abierto').
    await sincronizarPendientes(meta.conteoId);
    await sincronizarDesconocidosPendientes(empresaId, meta.conteoId);
    await refrescarPendientes();
    const restantes = await contarPendientes(meta.conteoId);
    setCerrando(false);

    if (restantes > 0) {
      setErrorCierre(
        `Quedan ${restantes} escaneo(s) sin sincronizar (revisá la conexión) — no se puede cerrar hasta que se manden todos.`
      );
      return;
    }
    setConfirmandoCierre(true);
  }

  async function confirmarCierre() {
    setCerrando(true);
    setErrorCierre(null);
    try {
      const supabase = createBrowserClient();
      await cerrarConteo(supabase, meta.conteoId);
      setConfirmandoCierre(false);
      onCerrarConteo();
    } catch (e) {
      setErrorCierre(e instanceof Error ? e.message : "No se pudo cerrar el conteo.");
    } finally {
      setCerrando(false);
    }
  }

  const totalUnidades =
    lineas.reduce((acc, l) => acc + l.cantidad, 0) +
    lineasDesc.reduce((acc, l) => acc + l.cantidad, 0);

  const feedbackEstilo =
    feedback?.tipo === "encontrado" || feedback?.tipo === "desconocido_conocido"
      ? "border-found/30 bg-found-bg"
      : feedback?.tipo === "duplicado"
        ? "border-duplicate/30 bg-duplicate-bg"
        : "border-notfound/30 bg-notfound-bg";

  return (
    <div className="flex flex-1 flex-col p-4">
      <div className="mb-4 flex items-center justify-between text-xs">
        <span className="font-medium text-paper">{meta.nombre}</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${pendientes > 0 ? "bg-duplicate" : "bg-found"}`}
            />
            <span className={pendientes > 0 ? "text-duplicate" : "text-muted"}>
              {pendientes > 0 ? `${pendientes} sin sincronizar` : "sincronizado"}
            </span>
          </span>
          <button onClick={onCerrarConteo} className="text-muted transition-colors hover:text-paper">
            Cambiar
          </button>
        </div>
      </div>

      <TarjetaSugerencia conteoId={meta.conteoId} onResuelto={refrescarLineas} />

      {/* Input real de la cámara — se abre por código, no se ve nunca. */}
      <input
        ref={fotoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFotoSeleccionada}
        className="hidden"
      />

      <input
        ref={inputRef}
        type="text"
        inputMode="none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onChange={onChangeInput}
        onBlur={reenfocar}
        className="mb-5 w-full rounded-md border border-line bg-ink-2 px-4 py-3 text-center font-mono text-sm text-muted outline-none focus:border-brand"
        placeholder="Esperando lectura…"
      />

      <div className="mb-5 text-center">
        <div className="font-mono text-6xl font-semibold tabular-nums text-paper">
          {totalUnidades.toLocaleString("es-BO")}
        </div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-muted">
          unidades contadas
        </div>
      </div>

      {feedback && (
        <div className={`mb-5 rounded-lg border p-4 text-center ${feedbackEstilo}`}>
          {feedback.tipo === "encontrado" && (
            <>
              <p className="text-lg font-semibold text-paper">{feedback.linea.nombre}</p>
              {feedback.linea.presentacion && (
                <p className="text-sm text-muted">{feedback.linea.presentacion}</p>
              )}
              {feedback.unidadesPorCodigo > 1 && (
                <p className="text-xs font-medium text-brand">×{feedback.unidadesPorCodigo} por caja</p>
              )}
              <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-found">
                {feedback.linea.cantidad}
              </p>
            </>
          )}
          {feedback.tipo === "desconocido_conocido" && (
            <>
              <p className="text-sm text-muted">Sin identificar todavía</p>
              {feedback.foto && (
                // eslint-disable-next-line @next/next/no-img-element -- foto local (blob URL), no un asset del sitio
                <img
                  src={urlDeFoto(feedback.foto) ?? undefined}
                  alt=""
                  className="mx-auto my-2 h-24 rounded-md object-cover"
                />
              )}
              <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-found">
                {feedback.linea.cantidad}
              </p>
            </>
          )}
          {feedback.tipo === "duplicado" && (
            <p className="font-medium text-duplicate">Duplicado — {feedback.codigoRaw}</p>
          )}
          {feedback.tipo === "no_encontrado" && !cargandoProducto && (
            <>
              <p className="mb-3 font-medium text-notfound">No encontrado — {feedback.codigoRaw}</p>
              <button
                onClick={() => onClickTomarFoto(feedback.codigoRaw, feedback.codigoNorm)}
                disabled={subiendoFoto}
                className="rounded-md bg-notfound px-5 py-3 text-base font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {subiendoFoto ? "Procesando…" : "Tomar foto"}
              </button>
            </>
          )}
          {feedback.tipo === "no_encontrado" && cargandoProducto && (
            <div className="space-y-2 text-left">
              <p className="mb-1 text-center font-medium text-notfound">{feedback.codigoRaw}</p>
              {fotoCapturada && (
                // eslint-disable-next-line @next/next/no-img-element -- foto local recién sacada, solo de referencia en pantalla (no se sube)
                <img
                  src={urlDeFoto(fotoCapturada) ?? undefined}
                  alt=""
                  className="mx-auto mb-2 h-32 rounded-md object-cover"
                />
              )}
              {errorCarga && <p className="text-sm text-notfound">{errorCarga}</p>}
              <input
                className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand"
                value={formCarga.nombre}
                onChange={(e) => setFormCarga({ ...formCarga, nombre: e.target.value })}
                placeholder="Nombre *"
                autoFocus
              />
              <input
                className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand"
                value={formCarga.laboratorio}
                onChange={(e) => setFormCarga({ ...formCarga, laboratorio: e.target.value })}
                placeholder="Laboratorio"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand"
                  type="number"
                  value={formCarga.concentracionValor}
                  onChange={(e) => setFormCarga({ ...formCarga, concentracionValor: e.target.value })}
                  placeholder="Concentración"
                />
                <select
                  className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand"
                  value={formCarga.concentracionUnidad}
                  onChange={(e) => setFormCarga({ ...formCarga, concentracionUnidad: e.target.value })}
                >
                  {UNIDADES_CONCENTRACION.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand"
                  type="number"
                  value={formCarga.contenido}
                  onChange={(e) => setFormCarga({ ...formCarga, contenido: e.target.value })}
                  placeholder="Contenido"
                />
                <select
                  className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-paper outline-none focus:border-brand"
                  value={formCarga.unidad}
                  onChange={(e) => setFormCarga({ ...formCarga, unidad: e.target.value })}
                >
                  <option value="">Presentación…</option>
                  {UNIDADES_PRESENTACION.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={guardarProductoCargado}
                  disabled={guardandoProducto || !formCarga.nombre.trim()}
                  className="flex-1 rounded-md bg-notfound px-3 py-2 text-sm font-medium text-ink disabled:opacity-50"
                >
                  {guardandoProducto ? "Guardando…" : "Guardar y contar"}
                </button>
                <button
                  onClick={() => {
                    setCargandoProducto(false);
                    setFotoCapturada(null);
                  }}
                  className="text-sm text-muted"
                >
                  Volver
                </button>
              </div>
            </div>
          )}
          {feedback.tipo === "codigo_invalido" && (
            <p className="font-medium text-notfound">Código inválido — {feedback.codigoRaw}</p>
          )}
        </div>
      )}

      <div className="mb-5 flex gap-2.5">
        <button
          onClick={onDeshacer}
          className="flex-1 rounded-md border border-line px-4 py-3 text-sm font-medium text-paper transition-colors hover:border-muted"
        >
          Deshacer
        </button>
        <button
          onClick={() => setMostrarCantidadManual((v) => !v)}
          className="flex-1 rounded-md border border-line px-4 py-3 text-sm font-medium text-paper transition-colors hover:border-muted"
        >
          Cantidad manual
        </button>
      </div>

      <button
        onClick={abrirConfirmacionCierre}
        disabled={cerrando}
        className="mb-5 w-full rounded-md border border-notfound/40 px-4 py-3 text-sm font-medium text-notfound transition-colors hover:bg-notfound-bg disabled:opacity-50"
      >
        {cerrando ? "Sincronizando…" : "Cerrar conteo"}
      </button>

      {errorCierre && !confirmandoCierre && (
        <p className="mb-5 rounded-md border border-notfound/30 bg-notfound-bg px-3.5 py-2.5 text-sm text-notfound">
          {errorCierre}
        </p>
      )}

      {mostrarCantidadManual && (
        <div className="mb-5 space-y-2.5 rounded-lg border border-line bg-ink-2 p-3.5">
          <input
            type="text"
            value={codigoManual}
            onChange={(e) => setCodigoManual(e.target.value)}
            placeholder="Código de barras"
            className="w-full rounded-md border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-brand"
          />
          <input
            type="number"
            min={1}
            value={cantidadManual}
            onChange={(e) => setCantidadManual(e.target.value)}
            className="w-full rounded-md border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-brand"
          />
          <button
            onClick={onCantidadManualSubmit}
            className="w-full rounded-md bg-brand px-3 py-2.5 text-sm font-medium text-ink transition-opacity hover:opacity-90"
          >
            Agregar
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {lineas.length === 0 && lineasDesc.length === 0 && (
          <p className="mt-8 text-center text-sm text-muted">Todavía no escaneaste nada.</p>
        )}
        <ul className="space-y-2">
          {lineas.map((l) => (
            <li
              key={l.id}
              className="flex items-center justify-between rounded-md border border-line bg-ink-2 px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-paper">{l.nombre}</p>
                {l.presentacion && <p className="truncate text-xs text-muted">{l.presentacion}</p>}
              </div>
              {editando === l.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={valorEdicion}
                    onChange={(e) => setValorEdicion(e.target.value)}
                    className="w-16 rounded-md border border-line bg-ink px-2 py-1 text-right text-paper outline-none focus:border-brand"
                    autoFocus
                  />
                  <button onClick={() => guardarEdicionProducto(l.id)} className="text-sm font-medium text-found">
                    OK
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => empezarEdicion(l.id, l.cantidad)}
                  className="shrink-0 rounded-md bg-ink-3 px-3 py-1 font-mono text-lg font-semibold tabular-nums text-paper"
                >
                  {l.cantidad}
                </button>
              )}
            </li>
          ))}

          {lineasDesc.map((l) => (
            <li
              key={l.id}
              className="flex items-center justify-between rounded-md border border-dashed border-line px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-muted">Sin identificar</p>
                <p className="truncate font-mono text-xs text-muted/70">{l.codigoNorm}</p>
              </div>
              {editando === l.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={valorEdicion}
                    onChange={(e) => setValorEdicion(e.target.value)}
                    className="w-16 rounded-md border border-line bg-ink px-2 py-1 text-right text-paper outline-none focus:border-brand"
                    autoFocus
                  />
                  <button
                    onClick={() => guardarEdicionDesconocido(l.codigoNorm)}
                    className="text-sm font-medium text-found"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => empezarEdicion(l.id, l.cantidad)}
                  className="shrink-0 rounded-md bg-ink-3 px-3 py-1 font-mono text-lg font-semibold tabular-nums text-muted"
                >
                  {l.cantidad}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {confirmandoCierre && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-6">
          <div className="w-full max-w-sm rounded-lg border border-line bg-ink-2 p-6 shadow-xl">
            <h2 className="mb-3 text-lg font-semibold text-paper">¿Cerrar este conteo?</h2>
            <p className="mb-2 text-sm text-muted">
              Quedan registradas <strong className="text-paper">{totalUnidades.toLocaleString("es-BO")}</strong>{" "}
              unidades. Una vez cerrado no se puede volver a escanear acá.
            </p>
            {lineasDesc.length > 0 && (
              <p className="mb-4 rounded-md border border-duplicate/30 bg-duplicate-bg px-3 py-2 text-sm text-duplicate">
                Ojo: hay {lineasDesc.length} producto(s) sin identificar todavía.
              </p>
            )}
            {errorCierre && (
              <p className="mb-4 rounded-md border border-notfound/30 bg-notfound-bg px-3 py-2 text-sm text-notfound">
                {errorCierre}
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={confirmarCierre}
                disabled={cerrando}
                className="flex-1 rounded-md bg-notfound px-4 py-3 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {cerrando ? "Cerrando…" : "Sí, cerrar"}
              </button>
              <button
                onClick={() => setConfirmandoCierre(false)}
                disabled={cerrando}
                className="flex-1 rounded-md border border-line px-4 py-3 text-sm font-medium text-paper transition-colors hover:border-muted"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
