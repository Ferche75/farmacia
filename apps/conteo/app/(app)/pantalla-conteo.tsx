"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownUp,
  Calendar,
  EllipsisVertical,
  Package,
  Pencil,
  RefreshCw,
  ScanBarcode,
  Search,
  Trash2,
} from "lucide-react";
import {
  createBrowserClient,
  cerrarConteo,
  crearProductoYContar,
  normalizarCodigo,
  type NuevoProductoManual,
} from "@farmacia/db";
import { db, type LineaLocal, type LineaDesconocidoLocal, type MetaConteo, type ProductoLocal } from "@/lib/db";
import {
  CAMPOS_NUMERICOS,
  LABEL_CAMPO,
  type CampoCompletable,
} from "@/lib/campos-obligatorios";
import { sinConexion, verificarDatosEnServidor, guardarDatosFaltantes } from "@/lib/completar-datos";
import {
  procesarEscaneo,
  deshacerUltimoEscaneo,
  establecerCantidad,
  sumarUnidadesSueltas,
  generarUuid,
  generarCodigoInterno,
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
  obtenerFallados,
  type ItemFallado,
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

// Clase compartida de los inputs del formulario de carga manual — son
// muchos y todos iguales; tenerla suelta evita repetir la cadena entera
// ocho veces y que se desincronicen.
const CAMPO =
  "w-full rounded-lg border border-line-light bg-surface px-3 py-2 text-sm text-strong outline-none focus:border-brand";

type Feedback =
  | { tipo: "encontrado"; linea: LineaLocal; unidadesPorCodigo: number }
  | { tipo: "desconocido_conocido"; linea: LineaDesconocidoLocal; foto: Blob | null }
  | { tipo: "no_encontrado"; codigoRaw: string; codigoNorm: string; origenInterno?: boolean }
  /** El producto existe pero le faltan datos obligatorios y NO se pudo
   * abrir el popup para completarlos (sin conexión, o el servidor falló).
   * El escaneo queda sin contar a propósito: dejarlo pasar sería
   * saltearse el control justo cuando no hay forma de verificarlo. */
  | { tipo: "datos_bloqueado"; nombre: string; codigoRaw: string; mensaje: string }
  | { tipo: "duplicado"; codigoRaw: string }
  | { tipo: "codigo_invalido"; codigoRaw: string }
  | null;

function urlDeFoto(blob: Blob | null): string | null {
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

/** Cuadradito con ícono de caja donde el diseño muestra la foto del
 * producto. No hay foto real que poner: `productos` no tiene ninguna
 * columna de imagen (ni imagen_url ni foto_url), así que esto es un
 * placeholder a propósito, no una imagen rota. */
function Miniatura({ chico = false }: { chico?: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-lg bg-surface-soft text-soft ${
        chico ? "h-11 w-11" : "h-14 w-14"
      }`}
    >
      <Package size={chico ? 18 : 22} strokeWidth={1.8} />
    </span>
  );
}

// Los campos numéricos van como type="text" + inputMode (en varios
// teclados de Android, un type="number" solo deja cambiar el valor con
// las flechitas y no acepta que se tipeen los dígitos), así que el
// filtrado del valor se hace a mano acá.
function limpiarNumeroDecimal(valor: string): string {
  const limpio = valor.replace(/[^0-9.]/g, "");
  const primerPunto = limpio.indexOf(".");
  if (primerPunto === -1) return limpio;
  return limpio.slice(0, primerPunto + 1) + limpio.slice(primerPunto + 1).replace(/\./g, "");
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
  const [editando, setEditando] = useState<string | null>(null);
  const [valorEdicion, setValorEdicion] = useState("");
  // PICADO: el control inline que se abre sobre la tarjeta del producto
  // recién escaneado para sumarle unidades sueltas (caja ya abierta).
  const [picadoAbierto, setPicadoAbierto] = useState(false);
  const [picadoValor, setPicadoValor] = useState("1");
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
    sku: "",
    concentracionValor: "",
    concentracionUnidad: "mg",
    contenido: "",
    unidad: "",
    principioActivo: "",
    accionTerapeutica: "",
  });
  const [guardandoProducto, setGuardandoProducto] = useState(false);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  // Popup de "completar datos obligatorios": se abre cuando se escanea un
  // producto que YA está en el catálogo pero al que le falta algo que esta
  // empresa marcó como obligatorio (Configuración → "Campos obligatorios
  // al importar"). Frena el escaneo: el conteo se aplica recién cuando se
  // guardan los datos, y una sola vez por producto en todo el sistema (se
  // escriben en el catálogo global/por empresa, así que ningún otro
  // dispositivo lo vuelve a preguntar).
  const [completando, setCompletando] = useState<{
    producto: ProductoLocal;
    codigoRaw: string;
    delta: number;
    faltantes: CampoCompletable[];
  } | null>(null);
  const [valoresCompletar, setValoresCompletar] = useState<Record<string, string>>({});
  const [verificandoDatos, setVerificandoDatos] = useState(false);
  const [guardandoCompletar, setGuardandoCompletar] = useState(false);
  const [errorCompletar, setErrorCompletar] = useState<string | null>(null);

  const [fallados, setFallados] = useState<ItemFallado[]>([]);
  const [reintentando, setReintentando] = useState(false);

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
    setFallados(await obtenerFallados(meta.conteoId));
  }, [meta.conteoId]);

  async function reintentarSync() {
    setReintentando(true);
    await sincronizarPendientes(meta.conteoId);
    await sincronizarDesconocidosPendientes(empresaId, meta.conteoId);
    await refrescarPendientes();
    setReintentando(false);
  }

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

  // El input principal se reenfoca solo cuando pierde el foco por
  // accidente (para que el lector físico no se quede "mudo" si alguien
  // clickea afuera) — pero si lo que pasó fue que el foco se fue al
  // formulario de cargar producto, a editar una cantidad o al control de
  // PICADO, hay que dejarlo ahí: si reenfocamos igual, ningún otro input
  // de la pantalla deja escribir un solo carácter.
  function onBlurPrincipal() {
    if (cargandoProducto || editando !== null || picadoAbierto || completando !== null) return;
    reenfocar();
  }

  useEffect(() => {
    reenfocar();
  }, []);

  /** El producto está en el catálogo pero le faltan datos obligatorios.
   *
   * Antes de molestar al operario se le pregunta al servidor cómo está el
   * producto AHORA (una lectura, no escribe nada): el snapshot local puede
   * tener horas y los campos de productos_empresa no llegan por realtime,
   * así que es muy posible que alguien ya los haya cargado desde el panel.
   * Si efectivamente ya está completo, el escaneo sigue derecho y el
   * operario ni se entera.
   *
   * Sin conexión no hay forma de verificar ni de guardar, así que el
   * escaneo se frena con un mensaje — mismo criterio que
   * crear_producto_y_contar / guardarProductoCargado, que también exigen
   * estar online y lo dicen. */
  async function manejarDatosIncompletos(producto: ProductoLocal, codigoRaw: string, delta: number): Promise<void> {
    if (sinConexion()) {
      feedbackNoEncontrado();
      setFeedback({
        tipo: "datos_bloqueado",
        nombre: producto.nombre,
        codigoRaw,
        mensaje:
          "Le faltan datos obligatorios y necesitás conexión para completarlos. No se contó: volvé a escanearlo cuando tengas señal.",
      });
      return;
    }

    setVerificandoDatos(true);
    try {
      const faltantes = await verificarDatosEnServidor(producto.productoId);
      if (faltantes.length === 0) {
        // El catálogo local estaba viejo: ya lo completó alguien más.
        // verificarDatosEnServidor dejó la fila local al día, así que este
        // reintento pasa el gate. saltarDebounce porque es el MISMO código
        // que se acaba de leer, no una lectura nueva del lector.
        await ejecutarEscaneo(codigoRaw, delta, true);
        return;
      }
      setValoresCompletar({});
      setErrorCompletar(null);
      setCompletando({ producto, codigoRaw, delta, faltantes });
    } catch (e) {
      feedbackNoEncontrado();
      setFeedback({
        tipo: "datos_bloqueado",
        nombre: producto.nombre,
        codigoRaw,
        mensaje: e instanceof Error ? e.message : "No se pudieron consultar los datos del producto.",
      });
    } finally {
      setVerificandoDatos(false);
    }
  }

  /** Guarda lo que se tipeó en el popup y recién ahí aplica el escaneo que
   * había quedado frenado — el operario no tiene que volver a pasar el
   * lector por el código. */
  async function guardarDatosCompletar(): Promise<void> {
    if (!completando) return;

    const enBlanco = completando.faltantes.filter((c) => !(valoresCompletar[c] ?? "").trim());
    if (enBlanco.length > 0) {
      setErrorCompletar("Completá todos los campos para poder contar este producto.");
      return;
    }

    setGuardandoCompletar(true);
    setErrorCompletar(null);
    try {
      const restantes = await guardarDatosFaltantes(completando.producto.productoId, valoresCompletar);

      // El servidor re-valida todo y solo llena huecos, así que lo que
      // manda es lo que ÉL dice que quedó, no lo que se tipeó acá.
      if (restantes.length > 0) {
        setCompletando({ ...completando, faltantes: restantes });
        setErrorCompletar("Todavía faltan datos — revisá los campos marcados.");
        return;
      }

      const { codigoRaw, delta } = completando;
      setCompletando(null);
      setValoresCompletar({});
      await ejecutarEscaneo(codigoRaw, delta, true);
      reenfocar();
    } catch (e) {
      setErrorCompletar(e instanceof Error ? e.message : "No se pudieron guardar los datos.");
    } finally {
      setGuardandoCompletar(false);
    }
  }

  async function ejecutarEscaneo(codigoRaw: string, delta = 1, saltarDebounce = false): Promise<ResultadoEscaneo> {
    // La tarjeta pasa a ser otro producto: el picado a medio tipear era
    // para el anterior, se descarta.
    setPicadoAbierto(false);
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

      case "datos_incompletos":
        // Gate nuevo, INSERTADO antes del "encontrado" de siempre: no se
        // aplica ninguna cantidad hasta que los datos estén completos.
        await manejarDatosIncompletos(resultado.producto, resultado.codigoRaw, delta);
        break;

      case "duplicado":
        feedbackDuplicado();
        setFeedback({ tipo: "duplicado", codigoRaw: resultado.codigoRaw });
        break;

      case "codigo_invalido":
        feedbackCodigoInvalido();
        setFeedback({ tipo: "codigo_invalido", codigoRaw: resultado.codigoRaw });
        break;
    }

    return resultado;
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

  // PICADO: suma unidades sueltas a la línea de la tarjeta. Es aditivo —
  // cada confirmación suma lo tipeado a lo que ya había, no lo reemplaza
  // (el operario carga lo que ve en el cajón en ese momento).
  async function confirmarPicado(lineaId: string) {
    const n = parseInt(picadoValor, 10);
    if (!n || n <= 0) return;

    await sumarUnidadesSueltas(lineaId, n);
    // La tarjeta muestra una copia de la línea, no la de IndexedDB: hay
    // que releerla para que el contador de sueltas se actualice al toque
    // (local, sin esperar al servidor — igual que cualquier escaneo).
    const actualizada = await db.lineas.get(lineaId);
    if (actualizada) {
      setFeedback((f) => (f?.tipo === "encontrado" ? { ...f, linea: actualizada } : f));
    }
    setPicadoAbierto(false);
    setPicadoValor("1");
    await refrescarLineas();
    await refrescarPendientes();
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
      // La tarjeta de feedback muestra una copia de la línea: si se editó
      // desde ahí, hay que releerla para que el número no quede viejo.
      const actualizada = await db.lineas.get(lineaId);
      if (actualizada) {
        setFeedback((f) => (f?.tipo === "encontrado" && f.linea.id === lineaId ? { ...f, linea: actualizada } : f));
      }
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

  // "Producto sin código de barras": mismo circuito que "Tomar foto" desde
  // un "No encontrado" (foto opcional de referencia + formulario), pero
  // sin haber escaneado nada antes — acá se genera un código interno
  // propio (rango 20-29, reservado por GS1 para uso interno/en tienda, no
  // choca nunca con un código real de fábrica) para que el producto quede
  // matcheable la próxima vez igual que cualquier otro, por ejemplo si se
  // le pega una etiqueta impresa con ese mismo código.
  function onClickSinCodigo() {
    const codigoRaw = generarCodigoInterno();
    const codigoNorm = normalizarCodigo(codigoRaw).codigoNorm ?? codigoRaw;
    setFeedback({ tipo: "no_encontrado", codigoRaw, codigoNorm, origenInterno: true });
    onClickTomarFoto(codigoRaw, codigoNorm);
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
        sku: "",
        concentracionValor: "",
        concentracionUnidad: "mg",
        contenido: "",
        unidad: "",
        principioActivo: "",
        accionTerapeutica: "",
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
        principio_activo: formCarga.principioActivo.trim() || null,
        accion_terapeutica: formCarga.accionTerapeutica.trim() || null,
        concentracion,
        // El input filtra a mano (ver limpiarNumeroDecimal), así que puede
        // quedar un "." suelto mientras se tipea — Number(".") es NaN.
        contenido: Number.isFinite(Number(formCarga.contenido)) && formCarga.contenido
          ? Number(formCarga.contenido)
          : null,
        unidad: formCarga.unidad || null,
        codigo_proveedor: formCarga.sku.trim() || null,
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

  // Aparte del total y NO sumado a él: son unidades distintas (envases vs.
  // comprimidos sueltos). Mezclarlas en un solo número sería sumar cajas
  // con pastillas — el servidor las guarda en columnas separadas por el
  // mismo motivo.
  const totalSueltas = lineas.reduce((acc, l) => acc + (l.unidadesSueltas ?? 0), 0);

  const feedbackEstilo =
    feedback?.tipo === "encontrado" || feedback?.tipo === "desconocido_conocido"
      ? "bg-surface-mint"
      : feedback?.tipo === "duplicado"
        ? "bg-duplicate/10"
        : "bg-surface-danger";

  return (
    <div className="flex flex-1 flex-col bg-surface-2 p-4 text-strong">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight tracking-tight">Conteo de inventario</h1>
          {/* No hay campo de fecha propio en el conteo local: meta.nombre
              es lo que identifica al conteo y por default ya viene con la
              fecha del día ("Conteo 16/9/2026"), así que es lo que va acá
              en vez de inventar un dato nuevo. */}
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-soft">
            <Calendar size={13} className="shrink-0" aria-hidden />
            <span className="truncate">{meta.nombre}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${
              pendientes > 0 ? "bg-duplicate/15 text-duplicate" : "bg-surface-mint text-brand"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${pendientes > 0 ? "bg-duplicate" : "bg-brand"}`}
            />
            {pendientes > 0 ? `${pendientes} sin sincronizar` : "Sincronizado"}
          </span>
          <button
            onClick={onCerrarConteo}
            className="flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[0.6875rem] font-medium text-strong ring-1 ring-line-light transition-colors hover:bg-surface-soft"
          >
            <RefreshCw size={12} aria-hidden />
            Cambiar
          </button>
        </div>
      </header>

      {fallados.length > 0 && (
        <div className="mb-4 rounded-xl bg-surface-danger p-3.5">
          <p className="text-sm font-semibold text-danger">
            {fallados.length === 1
              ? "1 escaneo no se pudo guardar en el servidor."
              : `${fallados.length} escaneos no se pudieron guardar en el servidor.`}
          </p>
          <p className="mt-1 text-xs text-danger/80">{fallados[0].ultimoError}</p>
          <button
            onClick={reintentarSync}
            disabled={reintentando}
            className="mt-2.5 rounded-full bg-danger px-3.5 py-1.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {reintentando ? "Reintentando…" : "Reintentar ahora"}
          </button>
        </div>
      )}

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

      <div className="mb-4 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={17}
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-soft"
          />
          <input
            ref={inputRef}
            type="text"
            // inputMode="none" a propósito: el input es para el lector
            // físico, no para el teclado en pantalla (que taparía media
            // pantalla en cada escaneo).
            inputMode="none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onKeyDown={onKeyDown}
            onChange={onChangeInput}
            onBlur={onBlurPrincipal}
            className="w-full rounded-full border border-line-light bg-surface py-3 pl-10 pr-4 font-mono text-sm text-strong outline-none placeholder:font-sans placeholder:text-soft focus:border-brand"
            placeholder="Escaneá o buscá un producto…"
          />
        </div>
        <button
          type="button"
          onClick={reenfocar}
          aria-label="Volver a enfocar el lector"
          className="flex h-[2.875rem] w-[2.875rem] shrink-0 items-center justify-center rounded-xl border border-line-light bg-surface text-strong transition-colors hover:bg-surface-soft"
        >
          <ScanBarcode size={19} aria-hidden />
        </button>
      </div>

      {feedback && (
        <div className={`mb-3 rounded-2xl p-3.5 ${feedbackEstilo}`}>
          {feedback.tipo === "encontrado" && (
            <>
              <div className="flex gap-3">
                <Miniatura />
                <div className="min-w-0 flex-1">
                  <p className="text-[0.9375rem] font-bold leading-snug text-strong">{feedback.linea.nombre}</p>
                  {feedback.linea.presentacion && (
                    <p className="mt-0.5 text-xs text-soft">{feedback.linea.presentacion}</p>
                  )}
                  <p className="mt-0.5 font-mono text-[0.6875rem] text-soft">{feedback.linea.codigoNorm}</p>
                  {feedback.unidadesPorCodigo > 1 && (
                    <p className="mt-0.5 text-[0.6875rem] font-semibold text-brand">
                      ×{feedback.unidadesPorCodigo} por caja
                    </p>
                  )}
                  {/* PICADO: la caja abierta de la que ya se vendió suelto.
                      Va acá, en la tarjeta del producto recién escaneado, y no
                      en otra pantalla: el operario lo tiene en la mano justo
                      en ese momento. Suma unidades sueltas, que se cuentan
                      aparte de los envases (nunca se mezclan). */}
                  {!picadoAbierto && (
                    <button
                      onClick={() => {
                        setPicadoValor("1");
                        setPicadoAbierto(true);
                      }}
                      className="mt-2 rounded-full bg-brand px-3 py-1 text-[0.6875rem] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90"
                    >
                      Picado
                    </button>
                  )}
                </div>

                <div className="w-[5.75rem] shrink-0 rounded-xl bg-surface px-2 py-2.5 text-center">
                  <p className="text-[0.625rem] font-semibold uppercase tracking-wide text-soft">Cantidad</p>
                  {/* El id de edición va prefijado: la misma línea está
                      también en la lista de abajo y, sin prefijo, tocar
                      "Editar" acá abriría DOS inputs a la vez (los dos con
                      autoFocus) peleándose el foco. Guardar usa el id real. */}
                  {editando === `tarjeta:${feedback.linea.id}` ? (
                    <div className="mt-1 space-y-1.5">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={valorEdicion}
                        onChange={(e) => setValorEdicion(e.target.value.replace(/\D/g, ""))}
                        className="w-full rounded-md border border-line-light bg-surface px-1.5 py-1 text-center font-mono text-base text-strong outline-none focus:border-brand"
                        autoFocus
                        onFocus={(e) => e.target.select()}
                      />
                      <button
                        onClick={() => guardarEdicionProducto(feedback.linea.id)}
                        className="w-full rounded-md bg-brand py-1 text-xs font-bold text-white"
                      >
                        OK
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="font-mono text-3xl font-bold leading-tight tabular-nums text-strong">
                        {feedback.linea.cantidad}
                      </p>
                      {(feedback.linea.unidadesSueltas ?? 0) > 0 && (
                        <p className="font-mono text-[0.6875rem] font-semibold tabular-nums text-brand">
                          {feedback.linea.unidadesSueltas} sueltas
                        </p>
                      )}
                      <button
                        onClick={() => empezarEdicion(`tarjeta:${feedback.linea.id}`, feedback.linea.cantidad)}
                        className="mt-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-soft transition-colors hover:text-strong"
                      >
                        <Pencil size={11} aria-hidden />
                        Editar
                      </button>
                    </>
                  )}
                </div>
              </div>

              {picadoAbierto && (
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={picadoValor}
                    onChange={(e) => setPicadoValor(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        confirmarPicado(feedback.linea.id);
                      }
                    }}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    className="w-20 shrink-0 rounded-lg border border-line-light bg-surface px-3 py-2.5 text-center font-mono text-base text-strong outline-none focus:border-brand"
                  />
                  <button
                    onClick={() => confirmarPicado(feedback.linea.id)}
                    disabled={!parseInt(picadoValor, 10)}
                    className="flex-1 rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    Sumar sueltas
                  </button>
                  <button
                    onClick={() => {
                      setPicadoAbierto(false);
                      reenfocar();
                    }}
                    className="shrink-0 px-1 text-sm text-soft"
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </>
          )}
          {feedback.tipo === "desconocido_conocido" && (
            <div className="flex items-center gap-3">
              {feedback.foto ? (
                // eslint-disable-next-line @next/next/no-img-element -- foto local (blob URL), no un asset del sitio
                <img
                  src={urlDeFoto(feedback.foto) ?? undefined}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <Miniatura />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-bold leading-snug text-strong">Sin identificar todavía</p>
                <p className="mt-0.5 font-mono text-[0.6875rem] text-soft">{feedback.linea.codigoNorm}</p>
              </div>
              <div className="w-[5.75rem] shrink-0 rounded-xl bg-surface px-2 py-2.5 text-center">
                <p className="text-[0.625rem] font-semibold uppercase tracking-wide text-soft">Cantidad</p>
                <p className="font-mono text-3xl font-bold leading-tight tabular-nums text-strong">
                  {feedback.linea.cantidad}
                </p>
              </div>
            </div>
          )}
          {feedback.tipo === "duplicado" && (
            <p className="text-sm font-semibold text-duplicate">Duplicado — {feedback.codigoRaw}</p>
          )}
          {feedback.tipo === "no_encontrado" && !cargandoProducto && (
            <div className="text-center">
              <p className="mb-3 text-sm font-semibold text-danger">
                {feedback.origenInterno
                  ? "Código de barras interno asignado"
                  : `No encontrado — ${feedback.codigoRaw}`}
              </p>
              <button
                onClick={() => onClickTomarFoto(feedback.codigoRaw, feedback.codigoNorm)}
                disabled={subiendoFoto}
                className="rounded-full bg-danger px-5 py-3 text-base font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {subiendoFoto ? "Procesando…" : "Tomar foto"}
              </button>
            </div>
          )}
          {feedback.tipo === "no_encontrado" && cargandoProducto && (
            <div className="space-y-2 text-left">
              <p className="mb-1 text-center text-sm font-semibold text-danger">
                {feedback.origenInterno
                  ? `Código de barras interno: ${feedback.codigoRaw}`
                  : feedback.codigoRaw}
              </p>
              {fotoCapturada && (
                // eslint-disable-next-line @next/next/no-img-element -- foto local recién sacada, solo de referencia en pantalla (no se sube)
                <img
                  src={urlDeFoto(fotoCapturada) ?? undefined}
                  alt=""
                  className="mx-auto mb-2 h-32 rounded-lg object-cover"
                />
              )}
              {errorCarga && <p className="text-sm text-danger">{errorCarga}</p>}
              <input
                className={CAMPO}
                value={formCarga.nombre}
                onChange={(e) => setFormCarga({ ...formCarga, nombre: e.target.value })}
                placeholder="Nombre *"
                autoFocus
              />
              <input
                className={CAMPO}
                value={formCarga.laboratorio}
                onChange={(e) => setFormCarga({ ...formCarga, laboratorio: e.target.value })}
                placeholder="Laboratorio"
              />
              <input
                className={CAMPO}
                value={formCarga.principioActivo}
                onChange={(e) => setFormCarga({ ...formCarga, principioActivo: e.target.value })}
                placeholder="Principio activo"
              />
              <input
                className={CAMPO}
                value={formCarga.accionTerapeutica}
                onChange={(e) => setFormCarga({ ...formCarga, accionTerapeutica: e.target.value })}
                placeholder="Acción terapéutica"
              />
              <input
                className={CAMPO}
                value={formCarga.sku}
                onChange={(e) => setFormCarga({ ...formCarga, sku: e.target.value })}
                placeholder="SKU / código de proveedor (opcional)"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={CAMPO}
                  type="text"
                  inputMode="decimal"
                  value={formCarga.concentracionValor}
                  onChange={(e) =>
                    setFormCarga({ ...formCarga, concentracionValor: limpiarNumeroDecimal(e.target.value) })
                  }
                  placeholder="Concentración"
                />
                <select
                  className={CAMPO}
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
                  className={CAMPO}
                  type="text"
                  inputMode="decimal"
                  value={formCarga.contenido}
                  onChange={(e) => setFormCarga({ ...formCarga, contenido: limpiarNumeroDecimal(e.target.value) })}
                  placeholder="Contenido"
                />
                <select
                  className={CAMPO}
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
                  className="flex-1 rounded-full bg-danger px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {guardandoProducto ? "Guardando…" : "Guardar y contar"}
                </button>
                <button
                  onClick={() => {
                    setCargandoProducto(false);
                    setFotoCapturada(null);
                  }}
                  className="text-sm text-soft"
                >
                  Volver
                </button>
              </div>
            </div>
          )}
          {feedback.tipo === "datos_bloqueado" && (
            <div>
              <p className="text-sm font-semibold text-danger">Sin contar — {feedback.nombre}</p>
              <p className="mt-1 font-mono text-[0.6875rem] text-danger/80">{feedback.codigoRaw}</p>
              <p className="mt-1.5 text-xs text-danger/90">{feedback.mensaje}</p>
            </div>
          )}
          {feedback.tipo === "codigo_invalido" && (
            <p className="text-sm font-semibold text-danger">Código inválido — {feedback.codigoRaw}</p>
          )}
        </div>
      )}

      <div className="mb-3 flex gap-2.5">
        <button
          onClick={onDeshacer}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-danger px-4 py-3 text-sm font-semibold text-danger transition-opacity hover:opacity-90"
        >
          <Trash2 size={16} aria-hidden />
          Deshacer
        </button>
        <button
          onClick={onClickSinCodigo}
          disabled={subiendoFoto || cargandoProducto}
          aria-label="Producto sin código de barras"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-soft px-3 py-3 text-center text-[0.8125rem] font-semibold leading-tight text-strong transition-colors hover:bg-line-light disabled:opacity-50"
        >
          <ScanBarcode size={16} className="shrink-0" aria-hidden />
          Sin código de barras
        </button>
      </div>

      <button
        onClick={abrirConfirmacionCierre}
        disabled={cerrando}
        className="mb-3 w-full rounded-full bg-surface-danger px-4 py-3 text-sm font-semibold text-danger transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {cerrando ? "Sincronizando…" : "Cerrar conteo"}
      </button>

      {errorCierre && !confirmandoCierre && (
        <p className="mb-3 rounded-lg bg-surface-danger px-3.5 py-2.5 text-sm text-danger">{errorCierre}</p>
      )}

      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-strong">Productos contados</h2>
          {/* Decorativo por ahora: la lista SÍ está ordenada por último
              escaneo (ver refrescarLineas), pero todavía no hay otro
              orden para elegir — cuando lo haya, esto pasa a ser un
              selector. */}
          <p className="mt-0.5 flex items-center gap-1 text-xs text-soft">
            <ArrowDownUp size={12} aria-hidden />
            Más recientes
          </p>
        </div>
        <span className="shrink-0 text-xs text-soft">
          Total:{" "}
          <strong className="font-semibold tabular-nums text-strong">
            {totalUnidades.toLocaleString("es-BO")}
          </strong>
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {lineas.length === 0 && lineasDesc.length === 0 && (
          <p className="mt-8 text-center text-sm text-soft">Todavía no escaneaste nada.</p>
        )}
        <ul className="space-y-2">
          {lineas.map((l) => (
            <li
              key={l.id}
              className="flex items-center gap-3 rounded-xl border border-line-light bg-surface p-2.5"
            >
              <Miniatura chico />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-strong">{l.nombre}</p>
                {l.presentacion && <p className="truncate text-xs text-soft">{l.presentacion}</p>}
                <p className="truncate font-mono text-[0.6875rem] text-soft">{l.codigoNorm}</p>
              </div>
              {editando === l.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={valorEdicion}
                    onChange={(e) => setValorEdicion(e.target.value.replace(/\D/g, ""))}
                    className="w-16 rounded-lg border border-line-light bg-surface px-2 py-1 text-right font-mono text-strong outline-none focus:border-brand"
                    autoFocus
                  />
                  <button
                    onClick={() => guardarEdicionProducto(l.id)}
                    className="text-sm font-bold text-brand"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-0.5">
                  {/* Los dos números a la vista de un vistazo: envases
                      arriba, picado abajo. La edición inline sigue siendo
                      solo de envases; las sueltas se cargan desde el botón
                      PICADO de la tarjeta (o se deshacen con Deshacer). */}
                  <div className="flex flex-col items-end">
                    <button
                      onClick={() => empezarEdicion(l.id, l.cantidad)}
                      className="rounded-full bg-surface-mint px-3 py-1 font-mono text-base font-bold tabular-nums text-brand"
                    >
                      {l.cantidad}
                    </button>
                    {(l.unidadesSueltas ?? 0) > 0 && (
                      <span className="mt-0.5 font-mono text-[0.6875rem] font-semibold tabular-nums text-brand">
                        + {l.unidadesSueltas} sueltas
                      </span>
                    )}
                  </div>
                  {/* El "⋮" del diseño: por ahora no abre un menú con
                      varias opciones, hace lo mismo que tocar el número
                      (editar la cantidad), que es la única acción que
                      existe hoy para una línea. */}
                  <button
                    onClick={() => empezarEdicion(l.id, l.cantidad)}
                    aria-label={`Editar cantidad de ${l.nombre}`}
                    className="p-1 text-soft transition-colors hover:text-strong"
                  >
                    <EllipsisVertical size={16} aria-hidden />
                  </button>
                </div>
              )}
            </li>
          ))}

          {lineasDesc.map((l) => (
            <li
              key={l.id}
              className="flex items-center gap-3 rounded-xl border border-dashed border-line-light bg-surface/60 p-2.5"
            >
              <Miniatura chico />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-soft">Sin identificar</p>
                <p className="truncate font-mono text-[0.6875rem] text-soft">{l.codigoNorm}</p>
              </div>
              {editando === l.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={valorEdicion}
                    onChange={(e) => setValorEdicion(e.target.value.replace(/\D/g, ""))}
                    className="w-16 rounded-lg border border-line-light bg-surface px-2 py-1 text-right font-mono text-strong outline-none focus:border-brand"
                    autoFocus
                  />
                  <button
                    onClick={() => guardarEdicionDesconocido(l.codigoNorm)}
                    className="text-sm font-bold text-brand"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => empezarEdicion(l.id, l.cantidad)}
                    className="rounded-full bg-surface-soft px-3 py-1 font-mono text-base font-bold tabular-nums text-soft"
                  >
                    {l.cantidad}
                  </button>
                  <button
                    onClick={() => empezarEdicion(l.id, l.cantidad)}
                    aria-label="Editar cantidad del producto sin identificar"
                    className="p-1 text-soft transition-colors hover:text-strong"
                  >
                    <EllipsisVertical size={16} aria-hidden />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {verificandoDatos && !completando && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-strong/50 p-6">
          <div className="rounded-2xl bg-surface px-6 py-5 text-sm text-strong shadow-xl">
            Revisando los datos del producto…
          </div>
        </div>
      )}

      {/* Completar datos obligatorios. Es un bloqueo: mientras esto está
          abierto no se contó nada, y el escaneo se aplica recién al
          guardar. Solo se piden los campos que REALMENTE faltan (contra el
          dato fresco del servidor, no contra el snapshot local) y que esta
          empresa marcó como obligatorios — nunca costo ni precio, que no
          entran en apps/conteo por ninguna vía. */}
      {completando && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-strong/50 p-4">
          <div className="max-h-full w-full max-w-sm overflow-auto rounded-2xl bg-surface p-5 shadow-xl">
            <h2 className="text-base font-bold text-strong">Completar datos del producto</h2>
            <p className="mt-1 text-sm font-semibold text-strong">{completando.producto.nombre}</p>
            <p className="mt-0.5 font-mono text-[0.6875rem] text-soft">{completando.producto.codigoNorm}</p>
            <p className="mt-2 text-xs text-soft">
              Tu farmacia pide estos datos y a este producto le faltan. Se cargan una sola vez: cuando los
              guardes, no se vuelven a pedir en ningún dispositivo.
            </p>

            <div className="mt-4 space-y-2.5">
              {completando.faltantes.map((campo) => (
                <label key={campo} className="block">
                  <span className="mb-1 block text-xs font-semibold text-soft">{LABEL_CAMPO[campo]}</span>
                  <input
                    className={CAMPO}
                    value={valoresCompletar[campo] ?? ""}
                    inputMode={CAMPOS_NUMERICOS.includes(campo) ? "decimal" : "text"}
                    onChange={(e) =>
                      setValoresCompletar((prev) => ({
                        ...prev,
                        [campo]: CAMPOS_NUMERICOS.includes(campo)
                          ? limpiarNumeroDecimal(e.target.value)
                          : e.target.value,
                      }))
                    }
                    placeholder={LABEL_CAMPO[campo]}
                  />
                </label>
              ))}
            </div>

            {errorCompletar && <p className="mt-3 text-sm text-danger">{errorCompletar}</p>}

            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={guardarDatosCompletar}
                disabled={guardandoCompletar}
                className="flex-1 rounded-full bg-brand px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {guardandoCompletar ? "Guardando…" : "Guardar y contar"}
              </button>
              {/* Salida de emergencia. NO cuenta el escaneo (que es lo que
                  el bloqueo protege): simplemente lo abandona, para que
                  alguien que no tiene el dato a mano no quede con la
                  pantalla trabada. El producto sigue incompleto y vuelve a
                  pedirlo el próximo escaneo. */}
              <button
                onClick={() => {
                  setCompletando(null);
                  setValoresCompletar({});
                  setErrorCompletar(null);
                  reenfocar();
                }}
                disabled={guardandoCompletar}
                className="shrink-0 px-1 text-sm text-soft disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmandoCierre && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-strong/50 p-6">
          <div className="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl">
            <h2 className="mb-3 text-lg font-semibold text-strong">¿Cerrar este conteo?</h2>
            <p className="mb-2 text-sm text-soft">
              Quedan registradas <strong className="text-strong">{totalUnidades.toLocaleString("es-BO")}</strong>{" "}
              unidades
              {totalSueltas > 0 && (
                <>
                  {" "}
                  y <strong className="text-strong">{totalSueltas.toLocaleString("es-BO")}</strong> unidades
                  sueltas (picado)
                </>
              )}
              . Una vez cerrado no se puede volver a escanear acá.
            </p>
            {lineasDesc.length > 0 && (
              <p className="mb-4 rounded-lg bg-duplicate/10 px-3 py-2 text-sm text-duplicate">
                Ojo: hay {lineasDesc.length} producto(s) sin identificar todavía.
              </p>
            )}
            {errorCierre && (
              <p className="mb-4 rounded-lg bg-surface-danger px-3 py-2 text-sm text-danger">{errorCierre}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={confirmarCierre}
                disabled={cerrando}
                className="flex-1 rounded-full bg-danger px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {cerrando ? "Cerrando…" : "Sí, cerrar"}
              </button>
              <button
                onClick={() => setConfirmandoCierre(false)}
                disabled={cerrando}
                className="flex-1 rounded-full bg-surface-soft px-4 py-3 text-sm font-semibold text-strong transition-colors hover:bg-line-light"
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
