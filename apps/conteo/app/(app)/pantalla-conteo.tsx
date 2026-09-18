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
  subirFotoAltaManual,
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
import { UNIDADES_PRESENTACION, UNIDADES_CONCENTRACION, camposDePresentacion } from "@/lib/campos-producto";
import { obtenerPresentacionesFrecuentes, registrarUsoPresentacion } from "@/lib/uso-presentaciones";
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

/** El precio del alta manual es obligatorio y tiene que ser un número
 * POSITIVO. Vive suelto acá arriba porque lo miran dos lugares que tienen
 * que coincidir sí o sí: el `disabled` del botón "Guardar y contar" y el
 * guard de guardarProductoCargado. Si divergieran, el botón se habilitaría
 * para un valor que el guard después rebota en silencio.
 *
 * `limpiarNumeroDecimal` ya filtró lo tipeado, pero igual pueden quedar un
 * "." suelto o un "0" mientras se escribe: Number(".") es NaN y 0 no es un
 * precio de venta válido para un producto que se está dando de alta. */
function precioValido(valor: string): boolean {
  const n = Number(valor);
  return valor.trim() !== "" && Number.isFinite(n) && n > 0;
}

/** Cuánto trae el blíster y cuántos blísteres la caja: los dos son
 * obligatorios (y > 0) apenas se tilda "se vende fraccionado", porque de
 * ellos sale el CONTENIDO derivado de la caja. Los dos precios sueltos
 * pueden faltar y se cargan después desde el panel — mismo criterio que el
 * ABM de apps/admin, que los avisa pero no los bloquea.
 *
 * Duplica a propósito la validación que crear_producto_y_contar hace en el
 * servidor (20260928000000): es preferible frenar el paso del wizard que
 * dejar avanzar y que el alta reviente recién al apretar "Guardar y
 * contar", con todo el formulario ya completo. */
function fraccionamientoValido(unidadesPorBlister: string, blistersPorCaja: string): boolean {
  return Number(unidadesPorBlister) > 0 && Number(blistersPorCaja) > 0;
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
  // Cronómetro del alta manual: Date.now() del momento en que apareció el
  // paso 1 del formulario. Va en un ref y no en estado porque nada de la
  // pantalla depende de él — si fuera estado, cada alta dispararía un
  // render de más para guardar un número que nadie mira hasta el guardado.
  const inicioFormularioRef = useRef<number | null>(null);

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
  // caja). `fotoCapturada` se muestra desde el Blob local mientras se
  // completa el form y, al guardar, se sube al bucket 'altas-manuales'
  // para el log de auditoría que lee apps/admin (20260929000000) — el
  // operario nunca la vuelve a leer desde el servidor.
  const [cargandoProducto, setCargandoProducto] = useState(false);
  const [fotoCapturada, setFotoCapturada] = useState<Blob | null>(null);
  const [formCarga, setFormCarga] = useState({
    nombre: "",
    // Obligatorio, igual que `nombre`
    // (20260923000000_precio_obligatorio_y_visible_en_conteo.sql): un
    // producto no entra al sistema sin precio de venta, y crear_producto_y_contar
    // rechaza el alta si no llega. Que lo cargue un operario es una decisión
    // explícita del usuario — el que cuenta tiene la caja en la mano y sabe
    // a cuánto se vende. El COSTO de compra sigue sin existir en esta app.
    precio: "",
    laboratorio: "",
    sku: "",
    concentracionValor: "",
    concentracionUnidad: "mg",
    contenido: "",
    unidad: "",
    principioActivo: "",
    accionTerapeutica: "",
    // Venta fraccionada (productos_empresa, por empresa) — mismos cinco
    // campos que el ABM de apps/admin. Todos como texto porque son inputs
    // controlados filtrados a mano, igual que `precio`/`contenido`.
    fraccionable: false,
    unidadesPorBlister: "",
    blistersPorCaja: "",
    precioBlister: "",
    precioUnidad: "",
  });
  // El formulario de alta manual son 3 pasos y no una lista larga de todos
  // los campos de una: en un teléfono, con el teclado abierto, obliga a
  // scrollear a ciegas con la caja del producto en la otra mano. Sólo
  // el paso 1 tiene campos obligatorios (nombre, precio, presentación); los
  // otros dos se pueden pasar de largo.
  const [pasoFormulario, setPasoFormulario] = useState<1 | 2 | 3>(1);
  const [guardandoProducto, setGuardandoProducto] = useState(false);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  // Botones rápidos de presentación del paso 1 — se recalculan cada vez que
  // se abre el formulario (ver onFotoSeleccionada), no acá: el valor
  // inicial es solo el placeholder de la primera vez que este componente
  // renderiza, antes de que se haya abierto ningún alta manual. Lectura de
  // localStorage diferida a ese momento, no al render, por las dudas de
  // hidratación server/client.
  const [presentacionesFrecuentes, setPresentacionesFrecuentes] = useState<string[]>([
    "comprimidos",
    "capsulas",
    "jarabe",
    "ampollas",
  ]);
  // Texto del buscador de "otra presentación" del paso 1 — separado de
  // formCarga.unidad porque no es el VALOR elegido, es lo que se está
  // tipeando para filtrar la lista completa (UNIDADES_PRESENTACION).
  const [busquedaPresentacion, setBusquedaPresentacion] = useState("");

  // Qué pide el paso 2 depende de la presentación elegida en el paso 1 —
  // por eso la presentación es obligatoria para avanzar. Mismo criterio y
  // misma fuente que el ABM de apps/admin (CAMPOS_POR_PRESENTACION).
  const camposPresentacion = camposDePresentacion(formCarga.unidad);
  // Las DOS condiciones, igual que en el ABM: si alguien tilda el checkbox
  // y después vuelve al paso 1 a cambiar la presentación por una que no se
  // fracciona, el desglose deja de correr aunque el booleano siga en true.
  //
  // Dos MODOS de fraccionamiento, mutuamente excluyentes (ver
  // CamposPresentacion en @farmacia/db): el completo (caja → blíster →
  // unidad, para comprimidos/cápsulas/ampollas/etc.) y el simple (caja →
  // unidad directo, para el cajón genérico "unidades" — jeringas y
  // similares, que no vienen en blíster). `fraccionaAhora` es la unión de
  // los dos: todo lo que deriva `contenido` o arma el payload del RPC no
  // necesita distinguir cuál es, solo si HAY fraccionamiento activo.
  const fraccionaCompleto = camposPresentacion.fraccionable === true && formCarga.fraccionable;
  const fraccionaSimple = camposPresentacion.fraccionableSimple === true && formCarga.fraccionable;
  const fraccionaAhora = fraccionaCompleto || fraccionaSimple;

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
        precio: "",
        laboratorio: "",
        sku: "",
        concentracionValor: "",
        concentracionUnidad: "mg",
        contenido: "",
        unidad: "",
        principioActivo: "",
        accionTerapeutica: "",
        fraccionable: false,
        unidadesPorBlister: "",
        blistersPorCaja: "",
        precioBlister: "",
        precioUnidad: "",
      });
      setPasoFormulario(1);
      // Recalculado en cada apertura, no una sola vez al montar el
      // componente: si el uso cambió desde la última vez (se cargaron
      // productos con otra presentación), los botones rápidos tienen que
      // reflejarlo apenas se abre un alta nueva, no recién en el próximo
      // refresh de página.
      setPresentacionesFrecuentes(obtenerPresentacionesFrecuentes());
      setBusquedaPresentacion("");
      setErrorCarga(null);
      // El cronómetro arranca ACÁ y no antes: lo que se quiere medir es
      // cuánto le lleva al operario LLENAR el formulario, no cuánto tardó
      // la cámara nativa del teléfono en abrirse ni cuánto estuvo
      // buscándole el ángulo a la caja. Ese tiempo es del aparato, no del
      // proceso que el dueño quiere entender. Decisión explícita del
      // usuario.
      //
      // No se resetea al cancelar: si el operario vuelve al formulario,
      // pasa de nuevo por acá y lo pisa antes de que pueda guardar nada.
      inicioFormularioRef.current = Date.now();
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
    // Mismo criterio que el `disabled` del botón — ver precioValido.
    if (!precioValido(formCarga.precio)) return;

    // Tiempo de LLENADO del wizard: desde que apareció el paso 1 (ver
    // inicioFormularioRef en onFotoSeleccionada) hasta que el operario
    // apretó guardar. Se corta ACÁ, antes del upload de la foto y de la
    // llamada al RPC: lo que se está midiendo es cuánto le lleva a una
    // persona cargar un producto, no cuánto tarda la red del depósito en
    // subir un JPEG. Con la medición al final, un conteo con mala señal
    // parecería un equipo lento.
    const duracionSegundos = inicioFormularioRef.current
      ? Math.round((Date.now() - inicioFormularioRef.current) / 1000)
      : null;

    setGuardandoProducto(true);
    setErrorCarga(null);
    try {
      const supabase = createBrowserClient();

      // La foto va al bucket ANTES de crear el producto porque el RPC
      // necesita la ruta en el mismo payload (no hay un segundo paso
      // donde adjuntarla). Todo el bloque es best-effort: si el upload
      // falla —red del depósito, permiso, lo que sea— se sigue con
      // foto_path null y el producto se crea igual. La foto es de
      // auditoría; perderla es molesto, perder el alta es peor.
      let fotoPath: string | null = null;
      if (fotoCapturada) {
        try {
          fotoPath = await subirFotoAltaManual(supabase, {
            empresaId,
            conteoId: meta.conteoId,
            codigoNorm: feedback.codigoNorm,
            blob: fotoCapturada,
          });
        } catch (e) {
          // A la consola y nada más: mostrarle un error al operario por
          // algo que no le impide seguir solo lo confundiría. Del lado
          // del admin, la fila del log queda con foto_path y
          // foto_borrada_at los dos en null, que es exactamente la señal
          // de "nunca se pudo subir".
          console.warn("No se pudo subir la foto del alta manual:", e);
        }
      }

      const concentracion = formCarga.concentracionValor.trim()
        ? `${formCarga.concentracionValor.trim()} ${formCarga.concentracionUnidad}`
        : null;
      // "Unidades" (fraccionamiento simple, sin blíster): si no se tipeó un
      // precio por unidad, se DERIVA dividiendo precio de caja ÷ unidades
      // por caja — pedido explícito del usuario ("que divida"). En el modo
      // completo (blíster) no se auto-completa nada: ahí los tres precios
      // son independientes a propósito (ver el comentario del bloque de
      // fraccionamiento del ABM), no hay una división "correcta" única.
      const precioUnidadCalculado =
        fraccionaSimple && Number(formCarga.unidadesPorBlister) > 0
          ? Number(formCarga.precio) / Number(formCarga.unidadesPorBlister)
          : null;
      const nuevoProducto: NuevoProductoManual = {
        nombre: formCarga.nombre.trim(),
        // Requerido por el tipo y por el RPC. El guard de arriba ya
        // garantizó que esto es un número > 0.
        precio: Number(formCarga.precio),
        laboratorio: formCarga.laboratorio || null,
        principio_activo: formCarga.principioActivo.trim() || null,
        accion_terapeutica: formCarga.accionTerapeutica.trim() || null,
        concentracion,
        // Con fraccionamiento el contenido es DERIVADO (blísteres ×
        // unidades) y lo calcula el RPC; se manda igual el mismo número
        // para que el snapshot local de abajo no quede con otro valor que
        // el del servidor.
        //
        // Sin fraccionamiento va lo tipeado: el input filtra a mano (ver
        // limpiarNumeroDecimal), así que puede quedar un "." suelto
        // mientras se tipea — Number(".") es NaN.
        contenido: fraccionaAhora
          ? Number(formCarga.blistersPorCaja) * Number(formCarga.unidadesPorBlister)
          : Number.isFinite(Number(formCarga.contenido)) && formCarga.contenido
            ? Number(formCarga.contenido)
            : null,
        unidad: formCarga.unidad || null,
        codigo_proveedor: formCarga.sku.trim() || null,
        // Sin fraccionamiento no se manda nada a medio tipear: si el
        // operario abrió el bloque, escribió un número y después destildó
        // el checkbox, ese número no es un dato confirmado. Va todo en
        // null y el RPC ni mira el resto.
        fraccionable: fraccionaAhora,
        unidades_por_blister: fraccionaAhora ? Number(formCarga.unidadesPorBlister) : null,
        // En modo simple, blistersPorCaja va forzado en "1" desde que se
        // tilda el checkbox (ver el onChange más abajo): no hay blíster,
        // la "caja" ES el nivel de arriba.
        blisters_por_caja: fraccionaAhora ? Number(formCarga.blistersPorCaja) : null,
        // Modo completo: los dos precios sueltos pueden quedar vacíos (se
        // completan después desde el panel), igual que en el ABM. Modo
        // simple: no hay campo de "precio por blíster" en el formulario —
        // se refleja acá el mismo precio de caja del paso 1, para que
        // productos_empresa.precio_blister no quede vacío con
        // blisters_por_caja = 1 (confundiría a quien mire el ABM después).
        precio_blister: fraccionaCompleto
          ? (formCarga.precioBlister ? Number(formCarga.precioBlister) : null)
          : fraccionaSimple
            ? Number(formCarga.precio)
            : null,
        precio_unidad: fraccionaCompleto
          ? (formCarga.precioUnidad ? Number(formCarga.precioUnidad) : null)
          : fraccionaSimple
            ? (formCarga.precioUnidad.trim() ? Number(formCarga.precioUnidad) : precioUnidadCalculado)
            : null,
        // No es un dato del producto: lo guarda el log de auditoría
        // (altas_manuales_conteo), no `productos` ni
        // `productos_empresa`.
        foto_path: fotoPath,
        duracion_segundos: duracionSegundos,
      };

      const resultado = await crearProductoYContar(supabase, {
        conteoId: meta.conteoId,
        codigoRaw: feedback.codigoRaw,
        clientUuid: generarUuid(),
        nuevoProducto,
        dispositivo: dispositivoActual(),
      });

      if (!("duplicado" in resultado)) {
        // Uso real, no una elección a medio tipear: acá el alta ya se
        // confirmó contra el servidor. Alimenta los botones rápidos del
        // paso 1 (ver lib/uso-presentaciones.ts) para la próxima vez que
        // se abra este formulario, en este mismo dispositivo.
        registrarUsoPresentacion(nuevoProducto.unidad);
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
                        setPicadoValor("");
                        setPicadoAbierto(true);
                      }}
                      className="mt-2 rounded-full bg-brand px-3 py-1 text-[0.6875rem] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90"
                    >
                      + Unidades sueltas
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
                <div className="mt-3 rounded-lg border border-line-light bg-surface p-2.5">
                  {/* La confusión real (reportada por el dueño): el operario
                      pone el TOTAL (ej. 110) en vez de solo lo suelto (10),
                      porque las 100 de la caja ya están contadas por otro
                      lado y no se ve. Esta línea + el cálculo en vivo de
                      abajo son la aclaración explícita para que no haga esa
                      cuenta mal. */}
                  <p className="text-[0.6875rem] leading-snug text-soft">
                    Contá <strong className="text-strong">solo las unidades sueltas</strong>, fuera de la caja. Las{" "}
                    <strong className="text-strong">{feedback.linea.cantidad}</strong> de la caja ya están contadas
                    — no las repitas acá.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={picadoValor}
                      placeholder="ej: 10"
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
                  {/* Cálculo en vivo: si tipea 110 pensando en el total, acá
                      va a ver "100 + 110 = 210" y no "110" — la señal de que
                      algo está mal antes de confirmar, no después. */}
                  {parseInt(picadoValor, 10) > 0 && (
                    <p className="mt-1.5 text-[0.6875rem] text-soft">
                      {feedback.linea.cantidad} de caja + {parseInt(picadoValor, 10)} sueltas ={" "}
                      <strong className="text-strong">
                        {feedback.linea.cantidad + parseInt(picadoValor, 10)} en total
                      </strong>
                    </p>
                  )}
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
              {/* El número de paso no es decorativo: sin él, un formulario
                  que aparece con tres campos parece TODO el formulario y
                  nadie busca el botón de seguir. */}
              <p className="text-center text-[0.6875rem] font-semibold uppercase tracking-wide text-soft">
                Paso {pasoFormulario} de 3
              </p>
              {errorCarga && <p className="text-sm text-danger">{errorCarga}</p>}

              {/* ── Paso 1: lo único obligatorio ──────────────────── */}
              {pasoFormulario === 1 && (
                <>
                  <input
                    className={CAMPO}
                    value={formCarga.nombre}
                    onChange={(e) => setFormCarga({ ...formCarga, nombre: e.target.value })}
                    placeholder="Nombre *"
                    autoFocus
                  />
                  {/* Precio: obligatorio igual que el nombre, y por eso va
                      pegado a él y no abajo con el resto de los opcionales.
                      Numérico como `contenido`: type="text" + inputMode, que en
                      varios teclados de Android es la única forma de poder
                      tipear los dígitos (ver limpiarNumeroDecimal). */}
                  <input
                    className={CAMPO}
                    type="text"
                    inputMode="decimal"
                    value={formCarga.precio}
                    onChange={(e) => setFormCarga({ ...formCarga, precio: limpiarNumeroDecimal(e.target.value) })}
                    placeholder="Precio *"
                  />
                  {/* La presentación pasó a ser obligatoria (antes iba
                      suelta al lado del contenido): de ella depende qué
                      campos tiene sentido pedir en el paso 2, así que sin
                      elegirla el wizard no puede armar el paso siguiente.
                      Ya no es un <select>: son botones rápidos con las
                      presentaciones que MÁS se usan en este dispositivo
                      (dinámico, ver lib/uso-presentaciones.ts) + un
                      buscador para el resto — pedido explícito del
                      usuario, un desplegable de ~28 opciones obligaba a
                      leer la lista entera para algo que en la práctica
                      son siempre las mismas 3 o 4. */}
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-soft">Presentación *</p>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {presentacionesFrecuentes.map((u) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => {
                            setFormCarga({ ...formCarga, unidad: u });
                            setBusquedaPresentacion("");
                          }}
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                            formCarga.unidad === u
                              ? "bg-brand text-white"
                              : "bg-surface-soft text-strong ring-1 ring-line-light hover:bg-line-light"
                          }`}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                    <input
                      className={CAMPO}
                      value={busquedaPresentacion}
                      onChange={(e) => setBusquedaPresentacion(e.target.value)}
                      placeholder="Buscar otra presentación…"
                    />
                    {/* Filtra por substring, no solo por prefijo: alcanza con
                        tipear 3 letras de cualquier parte del nombre (ej.
                        "vas" encuentra "envase") para acotar la lista de
                        ~28 opciones a un puñado. */}
                    {busquedaPresentacion.trim() &&
                      (() => {
                        const coincidencias = UNIDADES_PRESENTACION.filter((u) =>
                          u.includes(busquedaPresentacion.trim().toLowerCase())
                        );
                        return (
                          <ul className="mt-1.5 max-h-40 overflow-auto rounded-lg border border-line-light bg-surface">
                            {coincidencias.length === 0 && (
                              <li className="px-3 py-2 text-sm text-soft">Sin coincidencias</li>
                            )}
                            {coincidencias.map((u) => (
                              <li key={u}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setFormCarga({ ...formCarga, unidad: u });
                                    setBusquedaPresentacion("");
                                  }}
                                  className="block w-full px-3 py-2 text-left text-sm text-strong hover:bg-surface-soft"
                                >
                                  {u}
                                </button>
                              </li>
                            ))}
                          </ul>
                        );
                      })()}
                    {formCarga.unidad && (
                      <p className="mt-1.5 text-xs text-soft">
                        Elegida: <strong className="text-strong">{formCarga.unidad}</strong>
                      </p>
                    )}
                  </div>
                </>
              )}

              {/* ── Paso 2: lo que depende de la presentación ─────── */}
              {pasoFormulario === 2 && (
                <>
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

                  {/* Es el mismo campo `contenido` de siempre, rotulado en
                      mililitros porque la presentación es líquida. No se
                      muestra cuando además se fracciona (ampollas, vial):
                      ahí `contenido` pasa a ser el derivado del desglose y
                      los ml de cada ampolla van en la concentración — ver
                      el comentario de CAMPOS_POR_PRESENTACION. */}
                  {camposPresentacion.contenidoEnMl && !fraccionaAhora && (
                    <input
                      className={CAMPO}
                      type="text"
                      inputMode="decimal"
                      value={formCarga.contenido}
                      onChange={(e) => setFormCarga({ ...formCarga, contenido: limpiarNumeroDecimal(e.target.value) })}
                      placeholder="Mililitros"
                    />
                  )}

                  {/* Venta fraccionada: mismos campos, mismo orden y mismos
                      rótulos que el bloque del ABM de apps/admin, para que
                      un admin que ya conoce esa pantalla reconozca esto sin
                      leer. Es por EMPRESA, no del catálogo global. */}
                  {camposPresentacion.fraccionable && (
                    <div className="rounded-lg border border-line-light bg-surface p-3">
                      <label className="flex items-center gap-2 text-sm text-strong">
                        <input
                          type="checkbox"
                          className="accent-brand"
                          checked={formCarga.fraccionable}
                          onChange={(e) => setFormCarga({ ...formCarga, fraccionable: e.target.checked })}
                        />
                        Se vende fraccionado (por blíster y/o por unidad suelta)
                      </label>

                      {formCarga.fraccionable && (
                        <div className="mt-3 space-y-2">
                          {/* Enteros: acá no hay decimales posibles (media
                              unidad por blíster no existe), así que alcanza
                              con el mismo filtro de dígitos que usan las
                              cantidades del resto de la pantalla. */}
                          <input
                            className={CAMPO}
                            type="text"
                            inputMode="numeric"
                            value={formCarga.unidadesPorBlister}
                            onChange={(e) =>
                              setFormCarga({ ...formCarga, unidadesPorBlister: e.target.value.replace(/\D/g, "") })
                            }
                            placeholder="Unidades por blíster *"
                          />
                          <input
                            className={CAMPO}
                            type="text"
                            inputMode="numeric"
                            value={formCarga.blistersPorCaja}
                            onChange={(e) =>
                              setFormCarga({ ...formCarga, blistersPorCaja: e.target.value.replace(/\D/g, "") })
                            }
                            placeholder="Blísteres por caja *"
                          />
                          <input
                            className={CAMPO}
                            type="text"
                            inputMode="decimal"
                            value={formCarga.precioBlister}
                            onChange={(e) =>
                              setFormCarga({ ...formCarga, precioBlister: limpiarNumeroDecimal(e.target.value) })
                            }
                            placeholder="Precio por blíster"
                          />
                          <input
                            className={CAMPO}
                            type="text"
                            inputMode="decimal"
                            value={formCarga.precioUnidad}
                            onChange={(e) =>
                              setFormCarga({ ...formCarga, precioUnidad: limpiarNumeroDecimal(e.target.value) })
                            }
                            placeholder="Precio por unidad"
                          />
                          <p className="text-[0.6875rem] text-soft">
                            Los tres precios son independientes: llevar un blíster suelto suele salir más caro por
                            unidad que llevarse la caja entera. No se calculan dividiendo el precio de la caja.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Fraccionamiento SIMPLE (caja → unidad, sin blíster) —
                      el cajón genérico "unidades", donde caen productos
                      como jeringas: la caja trae N y se vende suelta o
                      entera, pero no hay ninguna sub-unidad física entre
                      medio. Ver fraccionableSimple en @farmacia/db. */}
                  {camposPresentacion.fraccionableSimple && (
                    <div className="rounded-lg border border-line-light bg-surface p-3">
                      <label className="flex items-center gap-2 text-sm text-strong">
                        <input
                          type="checkbox"
                          className="accent-brand"
                          checked={formCarga.fraccionable}
                          onChange={(e) =>
                            setFormCarga({
                              ...formCarga,
                              fraccionable: e.target.checked,
                              // Sin blíster: la caja ES el nivel de arriba.
                              // Forzarlo acá evita mostrarle al operario un
                              // concepto ("blíster") que no existe para esta
                              // presentación.
                              blistersPorCaja: e.target.checked ? "1" : "",
                            })
                          }
                        />
                        Se vende también por unidad suelta (no solo la caja completa)
                      </label>

                      {formCarga.fraccionable && (
                        <div className="mt-3 space-y-2">
                          <input
                            className={CAMPO}
                            type="text"
                            inputMode="numeric"
                            value={formCarga.unidadesPorBlister}
                            onChange={(e) =>
                              setFormCarga({ ...formCarga, unidadesPorBlister: e.target.value.replace(/\D/g, "") })
                            }
                            placeholder="Unidades por caja *"
                          />
                          <input
                            className={CAMPO}
                            type="text"
                            inputMode="decimal"
                            value={formCarga.precioUnidad}
                            onChange={(e) =>
                              setFormCarga({ ...formCarga, precioUnidad: limpiarNumeroDecimal(e.target.value) })
                            }
                            placeholder="Precio por unidad (opcional)"
                          />
                          {/* "Que divida" — pedido explícito del usuario: sin
                              precio por unidad tipeado, se calcula solo
                              (precio de caja ÷ unidades por caja) y ASÍ se
                              guarda si no se lo cambia — mismo cálculo que
                              hace guardarProductoCargado al armar el alta. */}
                          {!formCarga.precioUnidad.trim() &&
                            precioValido(formCarga.precio) &&
                            Number(formCarga.unidadesPorBlister) > 0 && (
                              <p className="text-[0.6875rem] text-soft">
                                Sin precio por unidad, se calcula solo: Bs{" "}
                                {(Number(formCarga.precio) / Number(formCarga.unidadesPorBlister)).toFixed(2)}{" "}
                                (precio de caja ÷ unidades por caja).
                              </p>
                            )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* ── Paso 3: todo opcional, nada gatea el guardado ─── */}
              {pasoFormulario === 3 && (
                <>
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
                </>
              )}

              {/* "Volver" (cancelar todo el alta) está en los tres pasos y
                  siempre en el mismo lugar: si sólo apareciera en el último,
                  quien se arrepiente en el paso 1 no tendría salida más que
                  completar el wizard entero. */}
              <div className="flex items-center gap-3 pt-1">
                {pasoFormulario > 1 && (
                  <button
                    onClick={() => setPasoFormulario((p) => (p === 3 ? 2 : 1))}
                    className="rounded-full bg-surface px-4 py-2.5 text-sm font-semibold text-strong ring-1 ring-line-light"
                  >
                    Atrás
                  </button>
                )}
                {pasoFormulario < 3 ? (
                  <button
                    onClick={() => setPasoFormulario((p) => (p === 1 ? 2 : 3))}
                    disabled={
                      pasoFormulario === 1
                        ? // Mismo criterio que el `disabled` de "Guardar y
                          // contar" (ver precioValido) más la presentación,
                          // que es de la que depende el paso 2.
                          !formCarga.nombre.trim() || !precioValido(formCarga.precio) || formCarga.unidad === ""
                        : // El paso 2 no exige nada… salvo que se haya
                          // tildado el fraccionamiento, que sin el desglose
                          // completo lo rebota el RPC igual.
                          fraccionaAhora &&
                          !fraccionamientoValido(formCarga.unidadesPorBlister, formCarga.blistersPorCaja)
                    }
                    className="flex-1 rounded-full bg-danger px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    Siguiente
                  </button>
                ) : (
                  <button
                    onClick={guardarProductoCargado}
                    disabled={
                      guardandoProducto || !formCarga.nombre.trim() || !precioValido(formCarga.precio)
                    }
                    className="flex-1 rounded-full bg-danger px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {guardandoProducto ? "Guardando…" : "Guardar y contar"}
                  </button>
                )}
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
          empresa marcó como obligatorios — nunca `costo`, que no entra en
          apps/conteo por ninguna vía. `precio` sí puede aparecer acá desde
          20260923000000, si la empresa lo tiene entre sus obligatorios: no
          hace falta nada especial en este JSX, que se arma solo a partir de
          `completando.faltantes` + LABEL_CAMPO + CAMPOS_NUMERICOS (que ya
          sabe que precio es numérico y le pone inputMode="decimal"). */}
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
