"use client";

import { useEffect, useMemo, useState } from "react";
import { ajustarStock, createBrowserClient, type CampoPersonalizado } from "@farmacia/db";
import { exportarCatalogoCompleto } from "@/lib/exportar-catalogo";

interface ProductoFila {
  id: string;
  nombre: string;
  marca: string | null;
  laboratorio_id: string | null;
  principio_activo: string | null;
  concentracion: string | null;
  accion_terapeutica: string | null;
  especialidad: string | null;
  contenido: number | null;
  unidad: string | null;
  categoria: string | null;
  fabricante: string | null;
  requiere_receta: boolean;
  controlado: boolean;
  activo: boolean;
  laboratorios: { nombre: string } | null;
  codigos_barra: { codigo_raw: string; es_principal: boolean }[];
}

// El principal es el que matchea en el conteo/buscar_producto — si por
// algún motivo ninguno quedó marcado, se muestra el primero como fallback
// en vez de dejar la columna vacía cuando en realidad sí hay un código.
function codigoPrincipal(codigos: ProductoFila["codigos_barra"]): string | null {
  if (codigos.length === 0) return null;
  return (codigos.find((c) => c.es_principal) ?? codigos[0]).codigo_raw;
}

interface UmbralSemaforo {
  rojoDias: number;
  amarilloDias: number;
  verdeDias: number;
}

// Umbrales editables por empresa desde /configuracion — ver
// VENCIMIENTO_SEMAFORO_DEFAULT (@farmacia/db) para el default (1/3/6
// meses). resumen_conteo (Fase 6) sigue fijo en 90/180 a propósito, ver
// docs/decisiones.md — es una métrica de reporte distinta, no este badge.
function VencimientoBadge({ fecha, umbral }: { fecha: string; umbral: UmbralSemaforo }) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const dias = Math.round((new Date(fecha).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
  const texto = new Date(fecha).toLocaleDateString("es-BO");
  const color =
    dias < 0 || dias <= umbral.rojoDias
      ? "text-danger"
      : dias <= umbral.amarilloDias
        ? "text-warn"
        : dias <= umbral.verdeDias
          ? "text-ok"
          : "text-muted";
  return <span className={color}>{texto}</span>;
}

// Una fila de la sección "Lotes y vencimientos" del modal. Mapea 1 a 1 con
// una fila de la tabla `lotes` — la MISMA que alimenta el semáforo de
// vencimientos y el desglose que ve pdvlat, no una copia de catálogo (para
// eso ya existen productos_empresa.lote_catalogo / _2, que son otra cosa:
// texto estático del proveedor, ver 20260813000007).
interface LoteForm {
  /** Presente = la fila ya existe en `lotes`. Ausente = alta nueva. */
  id?: string;
  sucursalId: string;
  lote: string; // `lotes.lote` es nullable: vacío se guarda como null
  vencimiento: string; // yyyy-mm-dd, obligatorio (`lotes.vencimiento` es NOT NULL)
  /** La generó un conteo físico cerrado: se muestra pero NO se toca. */
  deConteo: boolean;
  /** Solo para mostrar en las filas de conteo — la carga manual nunca la escribe. */
  cantidad: number;
}

interface FormState {
  id?: string;
  nombre: string;
  marca: string;
  laboratorioNombre: string;
  principioActivo: string;
  concentracion: string;
  accionTerapeutica: string;
  especialidad: string;
  contenido: string;
  unidad: string;
  unidadModoLibre: boolean; // UI: true si "unidad" no está en UNIDADES_PRESENTACION (select en modo "Otro…") — no se persiste
  categoria: string;
  fabricante: string;
  requiereReceta: boolean;
  controlado: boolean;
  activo: boolean;
  codigoBarra: string; // solo se usa al crear
  unidadesPorCodigo: string; // solo se usa al crear
  costo: string;
  precio: string; // precio de la CAJA/envase completo — ver el bloque de fraccionamiento
  stockMinimo: string;
  codigoProveedor: string;
  distribuidor: string;
  loteCatalogo: string;
  loteCatalogo2: string;
  // ── Venta fraccionada (productos_empresa, por empresa) ──────
  fraccionable: boolean;
  unidadesPorBlister: string;
  blistersPorCaja: string;
  precioBlister: string;
  precioUnidad: string;
  /** true si el producto ya tenía fila en productos_empresa al abrirlo.
   * Hace que "borré todos los precios" se guarde de verdad en vez de
   * quedar en nada porque el upsert no llegó a dispararse. */
  tieneFilaEmpresa: boolean;
  sucursalesDisponibles: string[]; // ids de sucursal — solo informativo, ver productos_sucursales
  camposExtra: Record<string, string>; // clave -> valor, ver campos personalizados
  lotes: LoteForm[];
  /** ids de los lotes MANUALES que se cargaron al abrir. Lo que esté acá y
   * ya no esté en `lotes` se borra al guardar. */
  lotesIdsOriginales: string[];
}

const FORM_VACIO: FormState = {
  nombre: "",
  marca: "",
  laboratorioNombre: "",
  principioActivo: "",
  concentracion: "",
  accionTerapeutica: "",
  especialidad: "",
  contenido: "",
  unidad: "",
  unidadModoLibre: false,
  categoria: "",
  fabricante: "",
  requiereReceta: false,
  controlado: false,
  activo: true,
  codigoBarra: "",
  unidadesPorCodigo: "1",
  costo: "",
  precio: "",
  stockMinimo: "",
  codigoProveedor: "",
  distribuidor: "",
  loteCatalogo: "",
  loteCatalogo2: "",
  fraccionable: false,
  unidadesPorBlister: "",
  blistersPorCaja: "",
  precioBlister: "",
  precioUnidad: "",
  tieneFilaEmpresa: false,
  sucursalesDisponibles: [],
  camposExtra: {},
  lotes: [],
  lotesIdsOriginales: [],
};

interface LoteResumen {
  vencimiento: string;
  sucursalNombre: string;
}

interface SucursalOpcion {
  id: string;
  nombre: string;
}

// Stock de UNA sucursal para el producto que se está editando. Se guarda
// por sucursal (y no un único "cargando" global) para que una sucursal
// lenta no tape el número de las demás: el modal abre y cada fila se
// completa cuando llega su respuesta.
interface StockSucursal {
  cargando: boolean;
  /** Unidades individuales — stock_actual ya hace la conversión desde la
   * foto en envases del conteo (ver 20260910000000). Puede tener
   * decimales si productos.contenido los tiene. */
  valor: number | null;
  error: string | null;
}

// stock_actual devuelve numeric: casi siempre entero, pero un
// productos.contenido fraccionario puede dejar decimales. No se redondea
// (sería mentir sobre lo que dice la base), solo se recortan los ceros.
function formatearStock(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : String(Math.round(valor * 100) / 100);
}

// Los errores de un RPC de Supabase llegan como PostgrestError (un objeto
// plano con .message), NO como una instancia de Error — un
// `e instanceof Error` los descartaría y perdería justo el mensaje que
// importa acá ("Escribí por qué se corrige el stock").
function mensajeDeError(e: unknown, fallback: string): string {
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return fallback;
}

// Un choque contra ix_lotes_clave (empresa, sucursal, bodega, producto,
// lote, vencimiento) llega como un 23505 crudo de Postgres, con el nombre
// del índice adentro y nada que le sirva a quien está cargando. El caso
// real es siempre el mismo: ya existe ese lote con esa fecha en esa
// sucursal — muchas veces porque lo dejó un conteo y está justo ahí
// arriba en la lista, en gris.
function errorDeLote(e: { code?: string } | null): Error {
  if (e?.code === "23505") {
    return new Error(
      "Ya existe un lote con ese número y esa fecha de vencimiento en esa sucursal. Fijate en la lista: puede ser uno que cargó un conteo."
    );
  }
  return new Error(mensajeDeError(e, "No se pudieron guardar los lotes."));
}

const TAMANO_PAGINA = 50;

// Mismo vocabulario fijo que ya usa /desconocidos (panel-detalle.tsx) para
// este campo — ver docs/decisiones.md, 2026-08-14. Duplicado a propósito,
// no compartido: cada pantalla de apps/admin ya sigue ese criterio (por eso
// las presentaciones que se agregaron acá el 2026-09-15 NO se replicaron
// allá — /desconocidos resuelve otro problema y su lista es suya).
//
// Convención de la lista: minúsculas, sin acentos, y el valor se muestra
// tal cual como etiqueta del <option>. Por eso "tableta efervescente" va
// con espacio y no con guión bajo: se persiste igual que se lee. Los 7
// valores originales (comprimidos, capsulas, ml, g, unidades, sobres,
// ampollas) siguen escritos exactamente igual — hay productos guardados
// con esos strings y renombrarlos los dejaría en "Otro…".
const UNIDADES_PRESENTACION = [
  "comprimidos",
  "capsulas",
  "tabletas",
  "tableta efervescente",
  "jarabe",
  "suspension",
  "ampollas",
  "vial",
  "gotas",
  "frasco",
  "sobres",
  "polvos",
  "gel",
  "crema",
  "pomada",
  "unguento",
  "aceite",
  "parches",
  "ml",
  "g",
  "unidades",
];

const CONTENIDOS_SUGERIDOS = ["10", "15", "20", "30", "50", "60", "100", "120", "150", "200", "250", "300", "500", "1000"];

// Qué campos extra tiene sentido pedir según la presentación. Vive acá y
// no en la base a propósito: es criterio de formulario (qué se le muestra
// a quien carga), no un dato de negocio que una empresa necesite editar —
// si algún día lo necesita, recién ahí se mueve a empresas.config.
//
// Una presentación que no esté en el mapa (las de texto libre del "Otro…",
// y todas las que no figuran acá) cae en el objeto vacío: el formulario
// queda exactamente como estaba antes de este cambio.
interface CamposPresentacion {
  /** Sólido en blíster: se puede vender caja / blíster / unidad suelta. */
  fraccionable?: boolean;
  /** Líquido: `contenido` se rotula en mililitros, y no hay blísteres. */
  contenidoEnMl?: boolean;
}

const CAMPOS_POR_PRESENTACION: Record<string, CamposPresentacion> = {
  comprimidos: { fraccionable: true },
  capsulas: { fraccionable: true },
  tabletas: { fraccionable: true },
  // "tableta efervescente" queda AFUERA del fraccionamiento a propósito
  // (pedido explícito del usuario): viene en tubo, no en blíster.
  jarabe: { contenidoEnMl: true },
  suspension: { contenidoEnMl: true },
  ampollas: { contenidoEnMl: true },
  vial: { contenidoEnMl: true },
};

function camposDePresentacion(unidad: string): CamposPresentacion {
  return CAMPOS_POR_PRESENTACION[unidad] ?? {};
}

function esUnidadPersonalizada(unidad: string): boolean {
  return unidad !== "" && !UNIDADES_PRESENTACION.includes(unidad);
}

// Todas las columnas mostrables de la tabla, aparte de Nombre y Acciones
// (esas dos siempre van fijas). El orden acá es el default — el usuario
// lo puede cambiar con los ↑/↓ del panel "Columnas", y la elección de
// cuáles mostrar/ocultar y en qué orden se persiste en localStorage
// (por navegador, no por empresa — es una preferencia de vista, no un
// dato de negocio, no justifica una columna nueva en la base).
const COLUMNAS_FIJAS: { id: string; label: string }[] = [
  { id: "codigoBarra", label: "Código de barras" },
  { id: "laboratorio", label: "Laboratorio" },
  { id: "contenido", label: "Contenido" },
  { id: "unidad", label: "Presentación" },
  { id: "concentracion", label: "Concentración" },
  { id: "principioActivo", label: "Principio activo" },
  { id: "categoria", label: "Categoría" },
  { id: "fabricante", label: "Fabricante" },
  { id: "stock", label: "Stock" },
  { id: "disponibleEn", label: "Disponible en" },
  { id: "sucursal", label: "Sucursal (vencimiento)" },
  { id: "vencimiento", label: "Vencimiento" },
  { id: "estado", label: "Estado" },
];

// Default deliberadamente angosto — mostrar las 12 columnas de una era
// justamente la queja de "esto es un asco a nivel diseño". El resto
// sigue a un click en "Columnas", no se pierde nada.
//
// "stock" sí entra al default (y es la única que se sumó desde entonces):
// es el dato que se viene a mirar a esta pantalla, no un detalle de ficha
// como fabricante o principio activo. Quien no lo quiera lo destilda una
// vez y queda guardado. Ojo: a quien ya tenga una preferencia guardada en
// localStorage este default no lo toca — le llega igual, por la
// reconciliación de "columna nueva" de más abajo, que la agrega visible al
// final.
const COLUMNAS_VISIBLES_DEFAULT = ["codigoBarra", "laboratorio", "contenido", "unidad", "stock", "estado"];

const LOCALSTORAGE_KEY_COLUMNAS = "farmacia_productos_columnas_v1";

function cargarPreferenciaColumnas(): { visibles: string[]; orden: string[] } {
  const fallback = {
    visibles: COLUMNAS_VISIBLES_DEFAULT,
    orden: COLUMNAS_FIJAS.map((c) => c.id),
  };
  if (typeof window === "undefined") return fallback;
  try {
    const guardado = window.localStorage.getItem(LOCALSTORAGE_KEY_COLUMNAS);
    if (!guardado) return fallback;
    const parseado = JSON.parse(guardado);
    if (!Array.isArray(parseado.visibles) || !Array.isArray(parseado.orden)) return fallback;
    return parseado;
  } catch {
    return fallback;
  }
}

export function ProductosAbm({
  empresaId,
  umbralVencimiento,
}: {
  empresaId: string;
  umbralVencimiento: UmbralSemaforo;
}) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [term, setTerm] = useState("");
  const [pagina, setPagina] = useState(0);
  const [totalFilas, setTotalFilas] = useState(0);
  const [resultados, setResultados] = useState<ProductoFila[]>([]);
  const [lotesPorProducto, setLotesPorProducto] = useState<Map<string, LoteResumen[]>>(new Map());
  const [disponiblesPorProducto, setDisponiblesPorProducto] = useState<Map<string, string[]>>(new Map());
  const [camposExtraPorProducto, setCamposExtraPorProducto] = useState<Map<string, Record<string, string>>>(
    new Map()
  );
  // Stock de la columna de la lista: una entrada por producto visible, en
  // unidades individuales y sumado sobre TODAS las sucursales/bodegas de
  // la empresa (ver el fetch). Es un mapa distinto de `stockPorSucursal`
  // de más abajo, que es el desglose por sucursal del modal de edición.
  const [stockPorProducto, setStockPorProducto] = useState<Map<string, number>>(new Map());
  const [sucursales, setSucursales] = useState<SucursalOpcion[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);
  const [prefColumnas, setPrefColumnas] = useState(cargarPreferenciaColumnas);
  const [panelColumnasAbierto, setPanelColumnasAbierto] = useState(false);
  const [camposPersonalizados, setCamposPersonalizados] = useState<CampoPersonalizado[]>([]);

  // ── Stock del producto que se está editando ──────────────────
  // Vive fuera de `form` a propósito: no es un campo del producto que se
  // guarde con "Guardar", es un dato calculado (conteo cerrado +
  // movimientos) que se corrige por su propio RPC.
  const [stockPorSucursal, setStockPorSucursal] = useState<Map<string, StockSucursal>>(new Map());
  const [ajusteAbierto, setAjusteAbierto] = useState<string | null>(null); // sucursal_id
  const [ajusteCantidad, setAjusteCantidad] = useState("");
  const [ajusteMotivo, setAjusteMotivo] = useState("");
  const [ajustando, setAjustando] = useState(false);
  const [ajusteError, setAjusteError] = useState<string | null>(null);
  const [ajusteOk, setAjusteOk] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(LOCALSTORAGE_KEY_COLUMNAS, JSON.stringify(prefColumnas));
  }, [prefColumnas]);

  // Parten de `columnasCombinadas` (no de `prefColumnas` crudo) a
  // propósito: si el usuario togglea/reordena una columna que recién se
  // agregó por la reconciliación de arriba, lo que se guarda incluye esa
  // columna también, en vez de partir de un `prefColumnas` que todavía no
  // la tiene.
  function toggleColumna(id: string) {
    setPrefColumnas({
      ...columnasCombinadas,
      visibles: columnasCombinadas.visibles.includes(id)
        ? columnasCombinadas.visibles.filter((c) => c !== id)
        : [...columnasCombinadas.visibles, id],
    });
  }

  function moverColumna(id: string, direccion: -1 | 1) {
    const i = columnasCombinadas.orden.indexOf(id);
    const j = i + direccion;
    if (i < 0 || j < 0 || j >= columnasCombinadas.orden.length) return;
    const nuevoOrden = [...columnasCombinadas.orden];
    [nuevoOrden[i], nuevoOrden[j]] = [nuevoOrden[j], nuevoOrden[i]];
    setPrefColumnas({ ...columnasCombinadas, orden: nuevoOrden });
  }

  // Campos personalizados (ver /configuracion) se suman como columnas
  // dinámicas más — id "custom:<clave>" para no chocar con las fijas.
  const todasLasColumnas = useMemo(
    () => [...COLUMNAS_FIJAS, ...camposPersonalizados.map((c) => ({ id: `custom:${c.clave}`, label: c.etiqueta }))],
    [camposPersonalizados]
  );

  // Vista combinada: `prefColumnas` (lo guardado en localStorage) más
  // cualquier columna que todavía no esté ahí — una fija recién agregada
  // al código, o un campo personalizado que la empresa acaba de definir —
  // agregada visible al final. Todo lo que LEE columnas (la tabla, el
  // panel de abajo) usa esto, nunca `prefColumnas` crudo: así una columna
  // nueva se ve YA, en el primer render, sin depender de que algo la
  // "reconcilie" antes.
  //
  // Cálculo en render, no en efecto: es una proyección pura de
  // `prefColumnas` + `todasLasColumnas`, no hay nada externo con lo que
  // sincronizar. La versión anterior de esto usaba un useEffect que
  // llamaba a setPrefColumnas — además de ser el patrón que
  // react-hooks/set-state-in-effect existe para evitar, tenía un bug real
  // (2026-09-14): comparaba contra un "último valor visto" que se
  // inicializaba con el valor ACTUAL de `todasLasColumnas`, así que
  // cualquier columna fija ya presente desde el montaje (como "stock",
  // recién agregada) nunca disparaba nada — la comparación era contra sí
  // misma desde el primer instante. Un usuario con preferencia vieja en
  // localStorage se quedaba sin forma de ver la columna nueva, ni
  // scrolleando: no estaba en la lista que itera el panel, aunque sí
  // contara en el "X/13" del botón.
  //
  // `toggleColumna`/`moverColumna` parten de este mismo valor combinado
  // (no de `prefColumnas` crudo) y lo escriben tal cual a
  // `prefColumnas`: la primera vez que el usuario toca cualquier columna,
  // lo guardado en localStorage se pone al día solo, de yapa.
  // Sin useMemo a propósito: son un par de .map/.filter sobre ~13
  // columnas, no vale la pena memoizarlo a mano (y el React Compiler de
  // este proyecto se queja si la memoización manual no matchea la que
  // generaría solo — más simple no competir con él acá).
  const nuevasColumnas = todasLasColumnas.map((c) => c.id).filter((id) => !prefColumnas.orden.includes(id));
  const columnasCombinadas =
    nuevasColumnas.length === 0
      ? prefColumnas
      : { orden: [...prefColumnas.orden, ...nuevasColumnas], visibles: [...prefColumnas.visibles, ...nuevasColumnas] };

  const columnasActivas = columnasCombinadas.orden
    .filter((id) => columnasCombinadas.visibles.includes(id))
    .map((id) => todasLasColumnas.find((c) => c.id === id))
    .filter((c): c is (typeof todasLasColumnas)[number] => c !== undefined);

  useEffect(() => {
    supabase
      .from("sucursales")
      .select("id, nombre")
      .eq("empresa_id", empresaId)
      .eq("activo", true)
      .order("nombre")
      .then(({ data }) => setSucursales(data ?? []));

    supabase
      .from("empresas")
      .select("config")
      .eq("id", empresaId)
      .single()
      .then(({ data }) => {
        const raw = (data?.config as Record<string, unknown> | null)?.campos_personalizados;
        setCamposPersonalizados(Array.isArray(raw) ? (raw as CampoPersonalizado[]) : []);
      });
  }, [supabase, empresaId]);

  // Al abrir el modal de un producto QUE YA EXISTE, se pide el stock de
  // cada sucursal en paralelo (un stock_actual por sucursal — no hay
  // wrapper tipado para ese RPC en @farmacia/db porque nunca se llamó
  // desde el panel; se usa .rpc() directo, igual que normalizar_codigo más
  // abajo en este mismo archivo). Un producto nuevo todavía no tiene id ni
  // stock del cual hablar, así que el efecto no hace nada.
  const productoEditandoId = form?.id;

  // Reset del formulario de ajuste al cambiar de producto — durante el
  // render, no en un efecto (react-hooks/set-state-in-effect: el patrón
  // que React mismo documenta para "resetear estado cuando cambia algo",
  // comparando contra el último valor visto y actualizando ahí mismo si
  // difiere). Acá es seguro hacerlo así porque `prevProductoId` es estado
  // PROPIO que queda congelado hasta que se lo pisa a mano — diverge de
  // verdad de `productoEditandoId` en cuanto el usuario abre otro
  // producto, a diferencia de columnasCombinadas de más arriba, donde las
  // dos puntas se recalculaban juntas y nunca podían diferir solas.
  // También limpia `stockPorSucursal` (no solo el formulario de ajuste):
  // sin esto, cambiar de producto de A a B podría mostrar por un instante
  // el stock viejo de A mientras llegan las respuestas de B. Con el mapa
  // arrancando vacío, cada fila cae en el `!st` de abajo ("cargando…")
  // hasta que su propia respuesta llega — no hace falta precargar un
  // estado "cargando: true" a mano (eso era el otro setState síncrono al
  // tope del efecto que señalaba el linter).
  const [prevProductoId, setPrevProductoId] = useState(productoEditandoId);
  if (productoEditandoId !== prevProductoId) {
    setPrevProductoId(productoEditandoId);
    setAjusteAbierto(null);
    setAjusteCantidad("");
    setAjusteMotivo("");
    setAjusteError(null);
    setAjusteOk(null);
    setStockPorSucursal(new Map());
  }

  // El efecto queda con un solo trabajo: pedir el stock real. Ningún
  // setState síncrono en el cuerpo — solo dentro de los .then() de abajo,
  // que es justo el caso que react-hooks/set-state-in-effect permite
  // ("llamar a setState en una función de callback cuando cambia un
  // estado externo").
  useEffect(() => {
    if (!productoEditandoId || sucursales.length === 0) return;

    let cancelado = false;

    for (const s of sucursales) {
      void supabase
        .rpc("stock_actual", {
          p_empresa_id: empresaId,
          p_producto_id: productoEditandoId,
          p_sucursal_id: s.id,
        })
        .then(({ data, error: rpcError }) => {
          if (cancelado) return;
          setStockPorSucursal((prev) =>
            new Map(prev).set(s.id, {
              cargando: false,
              valor: rpcError ? null : Number(data ?? 0),
              error: rpcError ? rpcError.message : null,
            })
          );
        });
    }

    return () => {
      cancelado = true;
    };
  }, [productoEditandoId, sucursales, supabase, empresaId]);

  async function guardarAjusteStock(sucursalId: string) {
    if (!productoEditandoId) return;
    setAjustando(true);
    setAjusteError(null);
    setAjusteOk(null);
    try {
      const r = await ajustarStock(supabase, {
        empresaId,
        sucursalId,
        productoId: productoEditandoId,
        cantidadNueva: Number(ajusteCantidad),
        motivo: ajusteMotivo,
      });
      // El RPC ya devolvió el stock resultante: no hace falta volver a
      // preguntar por stock_actual.
      setStockPorSucursal((prev) =>
        new Map(prev).set(sucursalId, { cargando: false, valor: r.stock_nuevo, error: null })
      );
      const signo = r.delta >= 0 ? "+" : "";
      setAjusteOk(
        `Stock ajustado: ${formatearStock(r.stock_anterior)} → ${formatearStock(r.stock_nuevo)} (${signo}${r.delta})`
      );
      setAjusteAbierto(null);
      setAjusteCantidad("");
      setAjusteMotivo("");
    } catch (e) {
      setAjusteError(mensajeDeError(e, "No se pudo ajustar el stock."));
    } finally {
      setAjustando(false);
    }
  }

  async function exportarCatalogo() {
    setExportando(true);
    try {
      await exportarCatalogoCompleto(supabase, empresaId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo exportar el catálogo.");
    } finally {
      setExportando(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(async () => {
      setBuscando(true);
      const termino = term.trim();

      // El buscador cubre 3 campos que viven en 3 tablas distintas:
      // nombre (productos), código de barras (codigos_barra) y SKU propio
      // de la empresa (productos_empresa.codigo_proveedor). PostgREST
      // puede filtrar por columnas de recursos embebidos dentro de un
      // .or(), pero combinar 2 relaciones embebidas distintas en un solo
      // filtro es frágil — más simple y confiable resolver los ids que
      // matchean por código en 2 consultas chicas aparte, y filtrar la
      // consulta principal por nombre O esos ids.
      let idsPorCodigo: string[] = [];
      if (termino) {
        const [porBarra, porSku] = await Promise.all([
          supabase.from("codigos_barra").select("producto_id").ilike("codigo_raw", `%${termino}%`).limit(50),
          supabase
            .from("productos_empresa")
            .select("producto_id")
            .eq("empresa_id", empresaId)
            .ilike("codigo_proveedor", `%${termino}%`)
            .limit(50),
        ]);
        idsPorCodigo = [
          ...new Set([
            ...(porBarra.data ?? []).map((r) => r.producto_id),
            ...(porSku.data ?? []).map((r) => r.producto_id),
          ]),
        ];
      }

      let query = supabase
        .from("productos")
        .select(
          "id, nombre, marca, laboratorio_id, principio_activo, concentracion, accion_terapeutica, especialidad, contenido, unidad, categoria, fabricante, requiere_receta, controlado, activo, laboratorios(nombre), codigos_barra(codigo_raw, es_principal)",
          { count: "exact" }
        )
        .order("nombre")
        .range(pagina * TAMANO_PAGINA, pagina * TAMANO_PAGINA + TAMANO_PAGINA - 1);
      if (termino) {
        const filtro = idsPorCodigo.length
          ? `nombre.ilike.%${termino}%,id.in.(${idsPorCodigo.join(",")})`
          : `nombre.ilike.%${termino}%`;
        query = query.or(filtro);
      }
      const { data, count } = await query;
      const productos = (data ?? []) as unknown as ProductoFila[];
      setResultados(productos);
      setTotalFilas(count ?? 0);

      // Vencimiento/sucursal: viven en `lotes` (por empresa+sucursal, se
      // alimenta al cerrar un conteo — ver
      // supabase/migrations/20260812000003_lotes_vencimiento.sql), no en
      // `productos` (que es el catálogo global). Se consulta aparte,
      // acotado a los productos visibles en esta página.
      const idsVisibles = productos.map((p) => p.id);
      const { data: lotesData } = idsVisibles.length
        ? await supabase
            .from("lotes")
            .select("producto_id, vencimiento, sucursales(nombre)")
            .eq("empresa_id", empresaId)
            .in("producto_id", idsVisibles)
            .gt("cantidad", 0)
            .order("vencimiento", { ascending: true })
        : { data: [] };

      const porProducto = new Map<string, LoteResumen[]>();
      for (const l of lotesData ?? []) {
        const sucursalNombre = (l.sucursales as unknown as { nombre: string } | null)?.nombre ?? "—";
        const arr = porProducto.get(l.producto_id) ?? [];
        arr.push({ vencimiento: l.vencimiento, sucursalNombre });
        porProducto.set(l.producto_id, arr);
      }
      setLotesPorProducto(porProducto);

      // Disponibilidad por sucursal: puramente informativo (no es de
      // dónde hay stock — eso lo sigue definiendo `lotes` arriba). Se
      // carga la sucursal directo (join), no hace falta cruzar con la
      // lista de `sucursales` del estado.
      const { data: dispData } = idsVisibles.length
        ? await supabase
            .from("productos_sucursales")
            .select("producto_id, sucursales(nombre)")
            .eq("empresa_id", empresaId)
            .in("producto_id", idsVisibles)
        : { data: [] };

      const dispPorProducto = new Map<string, string[]>();
      for (const d of dispData ?? []) {
        const nombre = (d.sucursales as unknown as { nombre: string } | null)?.nombre;
        if (!nombre) continue;
        const arr = dispPorProducto.get(d.producto_id) ?? [];
        arr.push(nombre);
        dispPorProducto.set(d.producto_id, arr);
      }
      setDisponiblesPorProducto(dispPorProducto);

      // Campos personalizados: a diferencia de costo/precio/distribuidor
      // (que no se muestran en esta lista, ver comentario histórico de
      // esta pantalla), estos SÍ son "columnas" en el sentido literal que
      // pidió el usuario — vale el round-trip extra por página.
      const { data: extraData } = idsVisibles.length
        ? await supabase
            .from("productos_empresa")
            .select("producto_id, campos_extra")
            .eq("empresa_id", empresaId)
            .in("producto_id", idsVisibles)
        : { data: [] };

      const extraPorProducto = new Map<string, Record<string, string>>();
      for (const e of extraData ?? []) {
        extraPorProducto.set(e.producto_id, (e.campos_extra as Record<string, string>) ?? {});
      }
      setCamposExtraPorProducto(extraPorProducto);

      // Stock de toda la página en UNA llamada: stock_actual_lote
      // (20260908000000, reescrita en 20260910000000), la versión batch de
      // la que usa el modal. Un stock_actual por fila serían 50
      // round-trips por tecla del buscador — el mismo N+1 que ya se evitó
      // en /api/pdvlat/catalogo, que llama a esta misma función.
      //
      // p_sucursal_id: null a propósito — esta lista no está parada en
      // ninguna sucursal (el desglose por sucursal es cosa del modal), así
      // que se muestra el total de la empresa: sin sucursal, la función
      // agrega todos los ámbitos (sucursal/bodega).
      const { data: stockData } = idsVisibles.length
        ? await supabase.rpc("stock_actual_lote", {
            p_empresa_id: empresaId,
            p_producto_ids: idsVisibles,
            p_sucursal_id: null,
          })
        : { data: [] };

      const stockDeProducto = new Map<string, number>();
      for (const s of stockData ?? []) {
        stockDeProducto.set(s.producto_id, Number(s.stock));
      }
      setStockPorProducto(stockDeProducto);

      setBuscando(false);
    }, 300);
    return () => clearTimeout(t);
  }, [term, pagina, supabase, empresaId]);

  function irAPagina(valor: string) {
    const totalPaginas = Math.max(1, Math.ceil(totalFilas / TAMANO_PAGINA));
    const n = Math.min(totalPaginas, Math.max(1, Math.round(Number(valor)) || 1));
    setPagina(n - 1);
  }

  function abrirNuevo() {
    setError(null);
    setForm(FORM_VACIO);
  }

  // "Duplicar como variante": en Bolivia, una presentación distinta (otros
  // mg, otro tamaño de envase) es directamente OTRO producto con su propio
  // código de barras — no un sub-ítem de un "producto padre". Esto solo
  // agiliza el alta de esa variante precargando lo que casi siempre se
  // repite (nombre, laboratorio, principio activo, categoría) y dejando en
  // blanco lo que sí cambia (código, concentración, contenido, unidad).
  function abrirDuplicar(p: ProductoFila) {
    setError(null);
    setForm({
      ...FORM_VACIO,
      nombre: p.nombre,
      // marca/acción terapéutica/especialidad viajan con el nombre: una
      // variante de "Tafirol 500" sigue siendo "Tafirol" y sigue siendo un
      // analgésico. El fraccionamiento NO viaja — depende del tamaño del
      // envase, que es justamente lo que cambia en una variante.
      marca: p.marca ?? "",
      laboratorioNombre: p.laboratorios?.nombre ?? "",
      principioActivo: p.principio_activo ?? "",
      accionTerapeutica: p.accion_terapeutica ?? "",
      especialidad: p.especialidad ?? "",
      categoria: p.categoria ?? "",
      fabricante: p.fabricante ?? "",
      requiereReceta: p.requiere_receta,
      controlado: p.controlado,
    });
  }

  async function abrirEditar(p: ProductoFila) {
    setError(null);
    const { data: pe } = await supabase
      .from("productos_empresa")
      .select(
        "costo, precio, stock_minimo, codigo_proveedor, distribuidor, lote_catalogo, lote_catalogo_2, campos_extra, fraccionable, unidades_por_blister, blisters_por_caja, precio_blister, precio_unidad"
      )
      .eq("empresa_id", empresaId)
      .eq("producto_id", p.id)
      .maybeSingle();

    const { data: disp } = await supabase
      .from("productos_sucursales")
      .select("sucursal_id")
      .eq("empresa_id", empresaId)
      .eq("producto_id", p.id);

    // Lotes reales del producto en esta empresa. Se traen TODOS, no solo
    // los manuales: mostrar también los que dejó un conteo (en gris, sin
    // editar) es lo que evita que alguien cargue a mano un lote que ya
    // existe y se coma un choque contra ix_lotes_clave sin entender por
    // qué. Se ordenan por vencimiento, igual que el resto de la pantalla.
    const { data: lotesData } = await supabase
      .from("lotes")
      .select("id, sucursal_id, lote, vencimiento, cantidad, actualizado_en_conteo_id")
      .eq("empresa_id", empresaId)
      .eq("producto_id", p.id)
      .order("vencimiento", { ascending: true });

    const lotes: LoteForm[] = (lotesData ?? []).map((l) => ({
      id: l.id,
      sucursalId: l.sucursal_id,
      lote: l.lote ?? "",
      vencimiento: l.vencimiento,
      deConteo: l.actualizado_en_conteo_id !== null,
      cantidad: l.cantidad,
    }));

    setForm({
      id: p.id,
      nombre: p.nombre,
      marca: p.marca ?? "",
      laboratorioNombre: p.laboratorios?.nombre ?? "",
      principioActivo: p.principio_activo ?? "",
      concentracion: p.concentracion ?? "",
      accionTerapeutica: p.accion_terapeutica ?? "",
      especialidad: p.especialidad ?? "",
      contenido: p.contenido != null ? String(p.contenido) : "",
      unidad: p.unidad ?? "",
      unidadModoLibre: esUnidadPersonalizada(p.unidad ?? ""),
      categoria: p.categoria ?? "",
      fabricante: p.fabricante ?? "",
      requiereReceta: p.requiere_receta,
      controlado: p.controlado,
      activo: p.activo,
      codigoBarra: "",
      unidadesPorCodigo: "1",
      costo: pe?.costo != null ? String(pe.costo) : "",
      precio: pe?.precio != null ? String(pe.precio) : "",
      stockMinimo: pe?.stock_minimo != null ? String(pe.stock_minimo) : "",
      codigoProveedor: pe?.codigo_proveedor ?? "",
      distribuidor: pe?.distribuidor ?? "",
      loteCatalogo: pe?.lote_catalogo ?? "",
      loteCatalogo2: pe?.lote_catalogo_2 ?? "",
      fraccionable: pe?.fraccionable ?? false,
      unidadesPorBlister: pe?.unidades_por_blister != null ? String(pe.unidades_por_blister) : "",
      blistersPorCaja: pe?.blisters_por_caja != null ? String(pe.blisters_por_caja) : "",
      precioBlister: pe?.precio_blister != null ? String(pe.precio_blister) : "",
      precioUnidad: pe?.precio_unidad != null ? String(pe.precio_unidad) : "",
      tieneFilaEmpresa: pe != null,
      sucursalesDisponibles: (disp ?? []).map((d) => d.sucursal_id),
      camposExtra: (pe?.campos_extra as Record<string, string> | null) ?? {},
      lotes,
      lotesIdsOriginales: lotes.filter((l) => !l.deConteo && l.id).map((l) => l.id as string),
    });
  }

  // ── Presentación → qué campos extra se muestran ──────────────
  // Calculado en render (no en estado): es una proyección pura de
  // `form.unidad` + `form.fraccionable`, mismo criterio que
  // `columnasCombinadas` de más arriba. Lo leen tanto el JSX como
  // `guardar`, así que vive una sola vez acá y no se duplica.
  //
  // `fraccionaAhora` exige LAS DOS cosas: que la presentación admita
  // blísteres Y que el checkbox esté tildado. Así, si alguien tenía un
  // producto fraccionable y le cambia la presentación a "jarabe", el
  // bloque desaparece y al guardar se limpian las columnas — no queda un
  // jarabe con blísteres colgado en la base.
  const camposPresentacion = form ? camposDePresentacion(form.unidad) : {};
  const fraccionaAhora = !!form && camposPresentacion.fraccionable === true && form.fraccionable;
  // blísteres × unidades. El `|| ""` cubre el caso "todavía no cargó
  // ninguno de los dos" (0 no es un contenido válido, es un campo vacío).
  const contenidoDerivado =
    form && fraccionaAhora ? String(Number(form.blistersPorCaja) * Number(form.unidadesPorBlister) || "") : "";
  const contenidoEfectivo = fraccionaAhora ? contenidoDerivado : (form?.contenido ?? "");

  function actualizarLote(i: number, cambios: Partial<LoteForm>) {
    if (!form) return;
    setForm({ ...form, lotes: form.lotes.map((l, j) => (j === i ? { ...l, ...cambios } : l)) });
  }

  async function guardar() {
    if (!form) return;
    setGuardando(true);
    setError(null);
    try {
      // ── Validaciones del bloque de fraccionamiento ─────────────
      // Solo el formulario valida esto: la base no lleva CHECK a
      // propósito (ver 20260918000000). Si el bloque no se está
      // mostrando, `fraccionaAhora` es false y nada de esto aplica.
      if (fraccionaAhora) {
        const upb = Number(form.unidadesPorBlister);
        const bpc = Number(form.blistersPorCaja);
        if (!Number.isFinite(upb) || upb <= 0 || !Number.isFinite(bpc) || bpc <= 0) {
          throw new Error(
            "Un producto fraccionable necesita cuántas unidades trae el blíster y cuántos blísteres la caja (ambos mayores a 0)."
          );
        }
        if (!form.precio.trim()) {
          throw new Error("Cargá al menos el precio de la caja: es la base de los otros dos niveles.");
        }
      }

      // Lotes: mismas reglas que la tabla. `vencimiento` es NOT NULL y
      // `sucursal_id` es FK, así que se chequean acá antes de gastar
      // round-trips — el error de Postgres sería mucho menos legible.
      for (const l of form.lotes) {
        if (l.deConteo) continue;
        if (!l.sucursalId || !l.vencimiento) {
          throw new Error("Cada lote necesita sucursal y fecha de vencimiento. Borrá la fila que quedó incompleta.");
        }
      }

      let laboratorioId: string | null = null;
      if (form.laboratorioNombre.trim()) {
        const { data: lab, error: labErr } = await supabase
          .from("laboratorios")
          .upsert({ nombre: form.laboratorioNombre.trim() }, { onConflict: "nombre" })
          .select("id")
          .single();
        if (labErr) throw labErr;
        laboratorioId = lab.id;
      }

      const payload = {
        nombre: form.nombre.trim(),
        marca: form.marca || null,
        laboratorio_id: laboratorioId,
        principio_activo: form.principioActivo || null,
        concentracion: form.concentracion || null,
        accion_terapeutica: form.accionTerapeutica || null,
        especialidad: form.especialidad || null,
        // OJO — LIMITACIÓN CONOCIDA Y ACEPTADA (ver el comentario largo de
        // 20260918000000_fraccionamiento_marca_y_lotes_manuales.sql):
        // `contenido` vive en `productos`, que es el catálogo GLOBAL
        // compartido por todas las empresas, pero blísteres/caja son datos
        // POR EMPRESA (productos_empresa). Cuando el producto es
        // fraccionable, acá se escribe el contenido DERIVADO
        // (blisters_por_caja × unidades_por_blister) en esa columna global
        // — que es la que stock_actual/stock_actual_lote ya usan como
        // factor envase→unidad y cuyo contrato esta pantalla no toca.
        // Consecuencia: si dos empresas venden el mismo producto global con
        // desgloses distintos (una 3×10, otra 2×15), se pisan el
        // `contenido` entre ellas y gana la última que guarde. No se
        // resuelve en esta pasada; resolverlo sería mover `contenido` a
        // productos_empresa y reescribir las funciones de stock.
        contenido: contenidoEfectivo ? Number(contenidoEfectivo) : null,
        unidad: form.unidad || null,
        categoria: form.categoria || null,
        fabricante: form.fabricante || null,
        requiere_receta: form.requiereReceta,
        controlado: form.controlado,
        activo: form.activo,
      };

      let productoId = form.id;

      if (productoId) {
        const { error: updErr } = await supabase.from("productos").update(payload).eq("id", productoId);
        if (updErr) throw updErr;
      } else {
        if (!form.codigoBarra.trim()) {
          throw new Error("Un producto nuevo necesita al menos un código de barras.");
        }

        const { data: nuevo, error: insErr } = await supabase
          .from("productos")
          .insert({ ...payload, origen: "manual" })
          .select("id")
          .single();
        if (insErr) throw insErr;
        productoId = nuevo.id;

        const { data: normalizado } = await supabase.rpc("normalizar_codigo", {
          p_codigo: form.codigoBarra.trim(),
        });
        const codigoNorm = normalizado?.codigo_norm ?? form.codigoBarra.trim();

        const { error: cbErr } = await supabase.from("codigos_barra").insert({
          producto_id: productoId,
          codigo_norm: codigoNorm,
          codigo_raw: form.codigoBarra.trim(),
          es_principal: true,
          unidades_por_codigo: Number(form.unidadesPorCodigo) || 1,
        });
        if (cbErr) throw cbErr;
      }

      // `tieneFilaEmpresa` en el OR: si el producto YA tenía fila en
      // productos_empresa, se reescribe siempre, aunque el usuario haya
      // dejado todo en blanco. Sin eso, "le saqué el precio a este
      // producto" o "lo destildé de fraccionable" no se guardaba nunca —
      // la condición daba false y el upsert ni se disparaba, dejando el
      // valor viejo en la base y al usuario mirando un formulario que
      // decía otra cosa.
      if (
        form.tieneFilaEmpresa ||
        form.costo ||
        form.precio ||
        form.stockMinimo ||
        form.codigoProveedor ||
        form.distribuidor ||
        form.loteCatalogo ||
        form.loteCatalogo2 ||
        fraccionaAhora ||
        Object.values(form.camposExtra).some((v) => v)
      ) {
        const { error: peErr } = await supabase.from("productos_empresa").upsert(
          {
            empresa_id: empresaId,
            producto_id: productoId,
            costo: form.costo ? Number(form.costo) : null,
            // Precio de la CAJA/envase completo. Los otros dos niveles
            // (blíster y unidad suelta) van abajo y NO son este número
            // dividido: el vendedor fija los tres por separado, y suelto
            // sale más caro por unidad que llevarse la caja entera.
            precio: form.precio ? Number(form.precio) : null,
            stock_minimo: form.stockMinimo ? Number(form.stockMinimo) : null,
            codigo_proveedor: form.codigoProveedor || null,
            distribuidor: form.distribuidor || null,
            lote_catalogo: form.loteCatalogo || null,
            lote_catalogo_2: form.loteCatalogo2 || null,
            campos_extra: form.camposExtra,
            // Todo el bloque de fraccionamiento se limpia de una cuando
            // `fraccionaAhora` es false — sea porque se destildó el
            // checkbox o porque la presentación pasó a una que no admite
            // blísteres. Es la contracara de que el bloque desaparezca de
            // la pantalla: lo que no se ve, no queda guardado.
            fraccionable: fraccionaAhora,
            unidades_por_blister: fraccionaAhora ? Number(form.unidadesPorBlister) : null,
            blisters_por_caja: fraccionaAhora ? Number(form.blistersPorCaja) : null,
            precio_blister: fraccionaAhora && form.precioBlister ? Number(form.precioBlister) : null,
            precio_unidad: fraccionaAhora && form.precioUnidad ? Number(form.precioUnidad) : null,
          },
          { onConflict: "empresa_id,producto_id" }
        );
        if (peErr) throw peErr;
      }

      // Disponibilidad por sucursal: reemplaza el set completo (delete +
      // insert) en vez de tratar de diffear — son a lo sumo unas pocas
      // sucursales por empresa, no vale la pena la complejidad de un
      // upsert selectivo acá.
      const { error: delDispErr } = await supabase
        .from("productos_sucursales")
        .delete()
        .eq("empresa_id", empresaId)
        .eq("producto_id", productoId);
      if (delDispErr) throw delDispErr;

      if (form.sucursalesDisponibles.length > 0) {
        const { error: insDispErr } = await supabase.from("productos_sucursales").insert(
          form.sucursalesDisponibles.map((sucursalId) => ({
            empresa_id: empresaId,
            producto_id: productoId,
            sucursal_id: sucursalId,
          }))
        );
        if (insDispErr) throw insDispErr;
      }

      // ── Lotes y vencimientos ───────────────────────────────────
      // Se sincroniza la lista contra `lotes` con altas/cambios/bajas en
      // vez del delete+insert que usa `productos_sucursales` acá arriba:
      // ahí las filas son descartables (tres columnas, todas de la fila),
      // acá NO — borrar y reinsertar le cambiaría el id a cada lote y, lo
      // que importa de verdad, un delete masivo pasaría por arriba de las
      // filas que dejó un conteo físico, que son intocables (la policy de
      // DELETE ni siquiera las ve, así que el borrado fallaría a medias).
      //
      // Las filas con `deConteo` se saltean enteras en los tres caminos:
      // son la foto de un recuento real y esta pantalla solo las muestra.
      const lotesAlta = form.lotes.filter((l) => !l.deConteo && !l.id);
      const lotesCambio = form.lotes.filter((l) => !l.deConteo && l.id);
      const lotesBaja = form.lotesIdsOriginales.filter((id) => !form.lotes.some((l) => l.id === id));

      if (lotesBaja.length > 0) {
        const { error: delLoteErr } = await supabase.from("lotes").delete().in("id", lotesBaja);
        if (delLoteErr) throw delLoteErr;
      }

      for (const l of lotesCambio) {
        const { error: updLoteErr } = await supabase
          .from("lotes")
          .update({
            sucursal_id: l.sucursalId,
            lote: l.lote.trim() || null,
            vencimiento: l.vencimiento,
            updated_at: new Date().toISOString(),
          })
          .eq("id", l.id as string);
        if (updLoteErr) throw errorDeLote(updLoteErr);
      }

      if (lotesAlta.length > 0) {
        // `cantidad` se deja en su default (0) y `actualizado_en_conteo_id`
        // en null a propósito: esta carga declara "este lote existe y vence
        // tal día", NO "hay tantas unidades". La existencia física sale
        // exclusivamente de cerrar un conteo, y ese límite no se difumina
        // desde una pantalla de catálogo. `bodega_id` también queda null =
        // "la sucursal entera", igual que en toda empresa sin bodegas.
        const { error: insLoteErr } = await supabase.from("lotes").insert(
          lotesAlta.map((l) => ({
            empresa_id: empresaId,
            sucursal_id: l.sucursalId,
            producto_id: productoId,
            lote: l.lote.trim() || null,
            vencimiento: l.vencimiento,
          }))
        );
        if (insLoteErr) throw errorDeLote(insLoteErr);
      }

      setForm(null);
      setTerm((t) => t); // re-dispara la búsqueda vía el useEffect
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar el producto.");
    } finally {
      setGuardando(false);
    }
  }

  function renderCelda(columnaId: string, p: ProductoFila) {
    if (columnaId.startsWith("custom:")) {
      const clave = columnaId.slice("custom:".length);
      return camposExtraPorProducto.get(p.id)?.[clave] || "—";
    }
    switch (columnaId) {
      case "codigoBarra":
        return (
          <>
            {codigoPrincipal(p.codigos_barra) ?? "—"}
            {p.codigos_barra.length > 1 && <span className="ml-1 text-line">+{p.codigos_barra.length - 1}</span>}
          </>
        );
      case "laboratorio":
        return p.laboratorios?.nombre ?? "—";
      case "contenido":
        return p.contenido != null ? String(p.contenido) : "—";
      case "unidad":
        return p.unidad ?? "—";
      case "concentracion":
        return p.concentracion ?? "—";
      case "principioActivo":
        return p.principio_activo ?? "—";
      case "categoria":
        return p.categoria ?? "—";
      case "fabricante":
        return p.fabricante ?? "—";
      case "stock": {
        // 0 es un dato REAL y hay que mostrarlo como 0: significa "no hay
        // existencia" (nunca se contó, o se vendió todo), no "no sé". El
        // "—" queda solo como red de seguridad: stock_actual_lote devuelve
        // una fila por producto pedido, incluidos los que no tienen
        // ninguna historia, así que en la práctica no debería faltar
        // ninguna.
        const stock = stockPorProducto.get(p.id);
        if (stock === undefined) return "—";
        return <span className={stock > 0 ? "text-ink" : "text-muted"}>{formatearStock(stock)}</span>;
      }
      case "disponibleEn": {
        const disp = disponiblesPorProducto.get(p.id);
        if (!disp || disp.length === 0) return "—";
        return disp.length > 1 ? `${disp[0]} +${disp.length - 1}` : disp[0];
      }
      case "sucursal": {
        const lotes = lotesPorProducto.get(p.id);
        if (!lotes || lotes.length === 0) return "—";
        const nombres = [...new Set(lotes.map((l) => l.sucursalNombre))];
        return nombres.length > 1 ? `${nombres[0]} +${nombres.length - 1}` : nombres[0];
      }
      case "vencimiento": {
        const lotes = lotesPorProducto.get(p.id);
        if (!lotes || lotes.length === 0) return <span className="text-muted">—</span>;
        // Ordenados por vencimiento asc en la consulta: el primero es el más próximo.
        return <VencimientoBadge fecha={lotes[0].vencimiento} umbral={umbralVencimiento} />;
      }
      case "estado":
        return p.activo ? <span className="text-ok">activo</span> : <span className="text-muted">inactivo</span>;
      default:
        return null;
    }
  }

  return (
    <div>
      <div className="rounded-lg border border-line bg-surface p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Catálogo de productos</h1>
        <p className="mt-1.5 text-sm text-muted">
          Buscador por nombre, código de barras o SKU, y alta/edición manual. El catálogo es global — lo que
          edités acá lo ven todas las empresas.
        </p>

        <div className="mt-6 flex items-center gap-3">
          <div className="relative w-72">
            <IconBuscar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={term}
              onChange={(e) => {
                setTerm(e.target.value);
                setPagina(0);
              }}
              placeholder="Buscar por nombre, código de barras o SKU…"
              className="input pl-9"
            />
          </div>
          {buscando && <span className="text-xs text-muted">buscando…</span>}
          <div className="relative ml-auto">
            <button
              onClick={() => setPanelColumnasAbierto((v) => !v)}
              className="flex items-center gap-1.5 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper"
            >
              Columnas ({columnasActivas.length}/{todasLasColumnas.length})
            </button>
            {panelColumnasAbierto && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPanelColumnasAbierto(false)} />
                <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-line bg-surface p-3 shadow-xl">
                  <p className="mb-2 px-1 text-xs font-medium text-muted">
                    Mostrar/ocultar y ordenar — se guarda en este navegador.
                  </p>
                  <ul className="max-h-80 space-y-0.5 overflow-y-auto">
                    {columnasCombinadas.orden.map((id, i) => {
                      const col = todasLasColumnas.find((c) => c.id === id);
                      if (!col) return null;
                      const visible = columnasCombinadas.visibles.includes(id);
                      return (
                        <li key={id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-paper">
                          <input
                            type="checkbox"
                            className="accent-brand"
                            checked={visible}
                            onChange={() => toggleColumna(id)}
                          />
                          <span className={`flex-1 text-sm ${visible ? "text-ink" : "text-muted"}`}>{col.label}</span>
                          <button
                            type="button"
                            onClick={() => moverColumna(id, -1)}
                            disabled={i === 0}
                            className="px-1 text-muted hover:text-ink disabled:opacity-30"
                            aria-label={`Mover ${col.label} arriba`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => moverColumna(id, 1)}
                            disabled={i === columnasCombinadas.orden.length - 1}
                            className="px-1 text-muted hover:text-ink disabled:opacity-30"
                            aria-label={`Mover ${col.label} abajo`}
                          >
                            ↓
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </div>
          <button
            onClick={exportarCatalogo}
            disabled={exportando}
            className="flex items-center gap-1.5 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-50"
          >
            <IconDescargar className="h-4 w-4" />
            {exportando ? "Exportando…" : "Exportar catálogo"}
          </button>
          <button
            onClick={abrirNuevo}
            className="flex items-center gap-1.5 rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            <IconMas className="h-4 w-4" />
            Nuevo producto
          </button>
        </div>

        {error && !form && (
          <p className="mt-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="mt-6 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted whitespace-nowrap">
                <th className="px-4 py-2.5 font-medium">Nombre</th>
                {columnasActivas.map((c) => (
                  <th key={c.id} className="px-4 py-2.5 font-medium">
                    {c.label}
                  </th>
                ))}
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {resultados.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 whitespace-nowrap hover:bg-paper">
                  <td className="px-4 py-2.5 text-ink">{p.nombre}</td>
                  {columnasActivas.map((c) => (
                    <td key={c.id} className="px-4 py-2.5 text-muted">
                      {renderCelda(c.id, p)}
                    </td>
                  ))}
                  <td className="px-4 py-2.5">
                    <button onClick={() => abrirEditar(p)} className="font-medium text-brand hover:underline">
                      Editar
                    </button>
                    <button
                      onClick={() => abrirDuplicar(p)}
                      className="ml-3 font-medium text-muted hover:text-ink hover:underline"
                    >
                      Duplicar
                    </button>
                  </td>
                </tr>
              ))}
              {resultados.length === 0 && !buscando && (
                <tr>
                  <td colSpan={columnasActivas.length + 2} className="py-16">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <IconCajaVacia className="h-10 w-10 text-line" />
                      <p className="font-medium text-ink">Sin resultados.</p>
                      <p className="text-sm text-muted">
                        {term.trim() ? "Probá con otro término de búsqueda." : "Todavía no hay productos cargados."}
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalFilas > TAMANO_PAGINA && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <p className="text-muted">
              {pagina * TAMANO_PAGINA + 1}–{Math.min((pagina + 1) * TAMANO_PAGINA, totalFilas)} de {totalFilas}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPagina((p) => Math.max(0, p - 1))}
                disabled={pagina === 0}
                className="rounded-md border border-line px-3 py-1.5 font-medium text-ink transition-colors hover:bg-paper disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="flex items-center gap-1.5 text-muted">
                Página
                <input
                  key={pagina}
                  type="number"
                  min={1}
                  max={Math.max(1, Math.ceil(totalFilas / TAMANO_PAGINA))}
                  defaultValue={pagina + 1}
                  onKeyDown={(e) => e.key === "Enter" && irAPagina((e.target as HTMLInputElement).value)}
                  onBlur={(e) => irAPagina(e.target.value)}
                  className="input w-16 px-2 py-1 text-center"
                />
                de {Math.max(1, Math.ceil(totalFilas / TAMANO_PAGINA))}
              </span>
              <button
                onClick={() => setPagina((p) => (p + 1) * TAMANO_PAGINA < totalFilas ? p + 1 : p)}
                disabled={(pagina + 1) * TAMANO_PAGINA >= totalFilas}
                className="rounded-md border border-line px-3 py-1.5 font-medium text-ink transition-colors hover:bg-paper disabled:opacity-40"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>

      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6">
        <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-surface p-8 shadow-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">{form.id ? "Editar producto" : "Nuevo producto"}</h2>
            <button onClick={() => setForm(null)} aria-label="Cerrar" className="text-muted transition-colors hover:text-ink">
              <IconX className="h-5 w-5" />
            </button>
          </div>

          {error && (
            <p className="mt-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
          )}

          <div className="mt-5 space-y-4">
            <Campo label="Nombre *">
              <input
                className="input"
                value={form.nombre}
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              />
            </Campo>

            {!form.id && (
              <Campo label="Código de barras *">
                <input
                  className="input"
                  value={form.codigoBarra}
                  onChange={(e) => setForm({ ...form, codigoBarra: e.target.value })}
                />
              </Campo>
            )}

            {!form.id && (
              <Campo label="Unidades por código">
                <input
                  type="number"
                  min={1}
                  className="input"
                  value={form.unidadesPorCodigo}
                  onChange={(e) => setForm({ ...form, unidadesPorCodigo: e.target.value })}
                />
                <p className="mt-1 text-xs text-muted">
                  Si este código es de una caja/blíster, cuántas unidades sueltas contiene. Al escanearlo en el
                  conteo, suma esa cantidad de una — dejalo en 1 si es la unidad suelta.
                </p>
              </Campo>
            )}

            <div className="grid grid-cols-2 gap-4">
              <Campo label="Marca">
                <input
                  className="input"
                  value={form.marca}
                  onChange={(e) => setForm({ ...form, marca: e.target.value })}
                />
                <p className="mt-1 text-xs text-muted">
                  El nombre comercial con el que se vende (ej. &quot;Tafirol&quot;). No reemplaza al Nombre de arriba
                  ni se usa para buscar — es un dato más de la ficha.
                </p>
              </Campo>
              <Campo label="Laboratorio">
                <input
                  className="input"
                  value={form.laboratorioNombre}
                  onChange={(e) => setForm({ ...form, laboratorioNombre: e.target.value })}
                />
              </Campo>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Campo label="Principio activo">
                <input
                  className="input"
                  value={form.principioActivo}
                  onChange={(e) => setForm({ ...form, principioActivo: e.target.value })}
                />
              </Campo>
              <Campo label="Concentración">
                <input
                  className="input"
                  value={form.concentracion}
                  onChange={(e) => setForm({ ...form, concentracion: e.target.value })}
                />
              </Campo>
              <Campo label="Categoría / línea">
                <input
                  className="input"
                  value={form.categoria}
                  onChange={(e) => setForm({ ...form, categoria: e.target.value })}
                />
              </Campo>
              <Campo label="Fabricante">
                <input
                  className="input"
                  value={form.fabricante}
                  onChange={(e) => setForm({ ...form, fabricante: e.target.value })}
                />
              </Campo>
              {/* Texto libre, igual que Categoría: el vocabulario todavía
                  no está cerrado y un select adivinado envejecería mal. */}
              <Campo label="Acción terapéutica">
                <input
                  className="input"
                  value={form.accionTerapeutica}
                  onChange={(e) => setForm({ ...form, accionTerapeutica: e.target.value })}
                />
              </Campo>
              <Campo label="Especialidad">
                <input
                  className="input"
                  value={form.especialidad}
                  onChange={(e) => setForm({ ...form, especialidad: e.target.value })}
                />
              </Campo>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Con fraccionable tildado, Contenido pasa a ser DERIVADO
                  (blísteres × unidades) y se muestra de solo lectura: son
                  el mismo número y dejar los dos editables habilitaba
                  cargar una caja de 3×10 que dijera contener 24. */}
              <Campo label={camposPresentacion.contenidoEnMl ? "Contenido (mililitros)" : "Contenido"}>
                <input
                  type="number"
                  className="input"
                  list="contenido-sugerencias"
                  value={contenidoEfectivo}
                  readOnly={fraccionaAhora}
                  disabled={fraccionaAhora}
                  onChange={(e) => setForm({ ...form, contenido: e.target.value })}
                />
                <datalist id="contenido-sugerencias">
                  {CONTENIDOS_SUGERIDOS.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
                <p className="mt-1 text-xs text-muted">
                  {fraccionaAhora
                    ? "Se calcula solo: blísteres por caja × unidades por blíster."
                    : camposPresentacion.contenidoEnMl
                      ? "Mililitros que trae el envase, sin la unidad. Ej: un jarabe de 150 ml → escribí 150."
                      : "Cantidad numérica del envase, sin la unidad. Ej: un jarabe de 150 ml → escribí 150 acá y elegí “ml” en Presentación."}
                </p>
              </Campo>
              <Campo label="Presentación">
                <select
                  className="input"
                  value={form.unidadModoLibre ? "__otro__" : form.unidad}
                  onChange={(e) => {
                    const valor = e.target.value;
                    if (valor === "__otro__") {
                      setForm({ ...form, unidad: "", unidadModoLibre: true });
                    } else {
                      setForm({ ...form, unidad: valor, unidadModoLibre: false });
                    }
                  }}
                >
                  <option value="">Presentación…</option>
                  {UNIDADES_PRESENTACION.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                  <option value="__otro__">Otro…</option>
                </select>
                {form.unidadModoLibre && (
                  <input
                    className="input mt-2"
                    value={form.unidad}
                    onChange={(e) => setForm({ ...form, unidad: e.target.value })}
                    placeholder="Escribí la presentación"
                  />
                )}
              </Campo>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={form.requiereReceta}
                  onChange={(e) => setForm({ ...form, requiereReceta: e.target.checked })}
                />
                Requiere receta
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={form.controlado}
                  onChange={(e) => setForm({ ...form, controlado: e.target.checked })}
                />
                Controlado
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={form.activo}
                  onChange={(e) => setForm({ ...form, activo: e.target.checked })}
                />
                Activo
              </label>
            </div>

            <div className="flex items-center gap-1.5 border-t border-line pt-4 text-xs font-medium text-muted">
              <IconEmpresa className="h-3.5 w-3.5" />
              Costo/precio — solo para tu empresa
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Campo label="Costo">
                <input
                  type="number"
                  className="input"
                  value={form.costo}
                  onChange={(e) => setForm({ ...form, costo: e.target.value })}
                />
              </Campo>
              <Campo label={fraccionaAhora ? "Precio (caja) *" : "Precio"}>
                <input
                  type="number"
                  className="input"
                  value={form.precio}
                  onChange={(e) => setForm({ ...form, precio: e.target.value })}
                />
              </Campo>
              <Campo label="Stock mínimo">
                <input
                  type="number"
                  className="input"
                  value={form.stockMinimo}
                  onChange={(e) => setForm({ ...form, stockMinimo: e.target.value })}
                />
              </Campo>
            </div>

            {/* Venta fraccionada: solo para las presentaciones que vienen
                en blíster (ver CAMPOS_POR_PRESENTACION). Es por EMPRESA —
                el mismo producto global puede venderse fraccionado en una
                farmacia y solo por caja en otra. */}
            {camposPresentacion.fraccionable && (
              <div className="rounded-md border border-line bg-paper p-4">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    checked={form.fraccionable}
                    onChange={(e) => setForm({ ...form, fraccionable: e.target.checked })}
                  />
                  Se vende fraccionado (por blíster y/o por unidad suelta)
                </label>

                {form.fraccionable && (
                  <>
                    <div className="mt-4 grid grid-cols-2 gap-4">
                      <Campo label="Unidades por blíster *">
                        <input
                          type="number"
                          min={1}
                          className="input"
                          value={form.unidadesPorBlister}
                          onChange={(e) => setForm({ ...form, unidadesPorBlister: e.target.value })}
                        />
                      </Campo>
                      <Campo label="Blísteres por caja *">
                        <input
                          type="number"
                          min={1}
                          className="input"
                          value={form.blistersPorCaja}
                          onChange={(e) => setForm({ ...form, blistersPorCaja: e.target.value })}
                        />
                      </Campo>
                      <Campo label="Precio por blíster">
                        <input
                          type="number"
                          className="input"
                          value={form.precioBlister}
                          onChange={(e) => setForm({ ...form, precioBlister: e.target.value })}
                        />
                      </Campo>
                      <Campo label="Precio por unidad">
                        <input
                          type="number"
                          className="input"
                          value={form.precioUnidad}
                          onChange={(e) => setForm({ ...form, precioUnidad: e.target.value })}
                        />
                      </Campo>
                    </div>

                    <p className="mt-2 text-xs text-muted">
                      Los tres precios son independientes: llevar un blíster suelto suele salir más caro por unidad
                      que llevarse la caja entera. No se calculan dividiendo el precio de la caja.
                      {contenidoDerivado && ` Esta caja queda en ${contenidoDerivado} unidades.`}
                    </p>

                    {/* Aviso, no bloqueo: se puede guardar el desglose hoy
                        y poner los precios sueltos mañana. Lo único
                        obligatorio es el precio de la caja, que es el que
                        ya usa el resto del sistema. */}
                    {(!form.precioBlister || !form.precioUnidad) && (
                      <p className="mt-2 text-xs text-warn">
                        Te falta cargar {!form.precioBlister && !form.precioUnidad
                          ? "el precio por blíster y el precio por unidad"
                          : !form.precioBlister
                            ? "el precio por blíster"
                            : "el precio por unidad"}
                        . Se puede guardar igual, pero hasta que estén no se puede cobrar ese nivel.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Campo label="Código de proveedor">
                <input
                  className="input"
                  value={form.codigoProveedor}
                  onChange={(e) => setForm({ ...form, codigoProveedor: e.target.value })}
                />
              </Campo>
              <Campo label="Distribuidor">
                <input
                  className="input"
                  value={form.distribuidor}
                  onChange={(e) => setForm({ ...form, distribuidor: e.target.value })}
                />
              </Campo>
              <Campo label="Lote">
                <input
                  className="input"
                  value={form.loteCatalogo}
                  onChange={(e) => setForm({ ...form, loteCatalogo: e.target.value })}
                />
              </Campo>
              <Campo label="Lote 2">
                <input
                  className="input"
                  value={form.loteCatalogo2}
                  onChange={(e) => setForm({ ...form, loteCatalogo2: e.target.value })}
                />
              </Campo>
            </div>

            {camposPersonalizados.length > 0 && (
              <div className="grid grid-cols-2 gap-4">
                {camposPersonalizados.map((c) => (
                  <Campo key={c.clave} label={c.etiqueta}>
                    <input
                      className="input"
                      value={form.camposExtra[c.clave] ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, camposExtra: { ...form.camposExtra, [c.clave]: e.target.value } })
                      }
                    />
                  </Campo>
                ))}
              </div>
            )}

            {sucursales.length > 0 && (
              <div>
                <span className="mb-1.5 block text-xs font-medium text-muted">
                  Disponible en (solo informativo, no afecta el conteo)
                </span>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {sucursales.map((s) => (
                    <label key={s.id} className="flex items-center gap-1.5 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="accent-brand"
                        checked={form.sucursalesDisponibles.includes(s.id)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            sucursalesDisponibles: e.target.checked
                              ? [...form.sucursalesDisponibles, s.id]
                              : form.sucursalesDisponibles.filter((id) => id !== s.id),
                          })
                        }
                      />
                      {s.nombre}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Stock: solo al EDITAR. Un producto que todavía no existe no
                tiene stock del cual hablar, y el RPC necesita su id. */}
            {form.id && sucursales.length > 0 && (
              <div className="border-t border-line pt-4">
                <span className="mb-1.5 block text-xs font-medium text-muted">
                  Stock actual, en unidades sueltas (último conteo cerrado + ventas y ajustes posteriores)
                </span>

                {ajusteOk && (
                  <p className="mb-2 rounded-md border border-ok/20 bg-ok-soft px-3 py-2 text-sm text-ok">
                    {ajusteOk}
                  </p>
                )}
                {ajusteError && (
                  <p className="mb-2 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
                    {ajusteError}
                  </p>
                )}

                <ul className="space-y-1.5">
                  {sucursales.map((s) => {
                    const st = stockPorSucursal.get(s.id);
                    const abierto = ajusteAbierto === s.id;
                    return (
                      <li key={s.id} className="rounded-md border border-line px-3 py-2">
                        <div className="flex items-center gap-3 text-sm">
                          <span className="flex-1 text-ink">{s.nombre}</span>
                          {!st || st.cargando ? (
                            <span className="text-muted">cargando…</span>
                          ) : st.error ? (
                            <span className="text-danger">no se pudo leer</span>
                          ) : (
                            <span className="font-medium text-ink">{formatearStock(st.valor ?? 0)}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setAjusteError(null);
                              setAjusteOk(null);
                              if (abierto) {
                                setAjusteAbierto(null);
                                return;
                              }
                              setAjusteAbierto(s.id);
                              setAjusteCantidad(st?.valor != null ? String(Math.round(st.valor)) : "");
                              setAjusteMotivo("");
                            }}
                            className="font-medium text-brand hover:underline"
                          >
                            {abierto ? "Cancelar" : "Corregir"}
                          </button>
                        </div>

                        {abierto && (
                          <div className="mt-2 flex flex-wrap items-end gap-2">
                            <label className="block">
                              <span className="mb-1 block text-xs font-medium text-muted">Cantidad real</span>
                              <input
                                type="number"
                                min={0}
                                className="input w-28"
                                value={ajusteCantidad}
                                onChange={(e) => setAjusteCantidad(e.target.value)}
                              />
                            </label>
                            <label className="block min-w-48 flex-1">
                              <span className="mb-1 block text-xs font-medium text-muted">Motivo *</span>
                              <input
                                className="input"
                                value={ajusteMotivo}
                                onChange={(e) => setAjusteMotivo(e.target.value)}
                                placeholder="Ej: se rompió una caja"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => guardarAjusteStock(s.id)}
                              disabled={ajustando || !ajusteMotivo.trim() || ajusteCantidad.trim() === ""}
                              className="rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                            >
                              {ajustando ? "Guardando…" : "Guardar"}
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>

                <p className="mt-1.5 text-xs text-muted">
                  Para corregir una rotura, un faltante o un conteo mal cargado sin rehacer el conteo entero. Queda
                  registrado quién, cuándo y por qué — el motivo es obligatorio.
                </p>
              </div>
            )}

            {/* Lotes y vencimientos: igual que el stock de arriba, solo al
                EDITAR — un producto que todavía no existe no tiene a qué
                colgarle un lote. Escribe la tabla `lotes` REAL, la misma
                que alimenta el semáforo de vencimientos y el desglose que
                ve pdvlat, no una copia de catálogo. */}
            {form.id && sucursales.length > 0 && (
              <div className="border-t border-line pt-4">
                <span className="mb-1.5 block text-xs font-medium text-muted">Lotes y vencimientos</span>

                {form.lotes.length === 0 && (
                  <p className="text-sm text-muted">Todavía no hay lotes cargados para este producto.</p>
                )}

                <ul className="space-y-1.5">
                  {form.lotes.map((l, i) =>
                    l.deConteo ? (
                      // Filas que dejó un conteo físico cerrado: se ven
                      // pero no se tocan, ni acá ni en la base (las
                      // policies de UPDATE/DELETE de `lotes` ni siquiera
                      // las alcanzan). Se muestran igual porque son las
                      // que chocan contra la llave única si alguien carga
                      // el mismo lote a mano sin saber que ya existía.
                      <li
                        key={l.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-paper px-3 py-2 text-sm"
                      >
                        <span className="text-ink">{sucursales.find((s) => s.id === l.sucursalId)?.nombre ?? "—"}</span>
                        <span className="text-muted">{l.lote || "sin nº de lote"}</span>
                        <VencimientoBadge fecha={l.vencimiento} umbral={umbralVencimiento} />
                        <span className="ml-auto text-xs text-muted">
                          {l.cantidad} en el último conteo · no editable
                        </span>
                      </li>
                    ) : (
                      <li key={l.id ?? `nuevo-${i}`} className="rounded-md border border-line px-3 py-2">
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="block min-w-40 flex-1">
                            <span className="mb-1 block text-xs font-medium text-muted">Sucursal *</span>
                            <select
                              className="input"
                              value={l.sucursalId}
                              onChange={(e) => actualizarLote(i, { sucursalId: e.target.value })}
                            >
                              {sucursales.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.nombre}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block min-w-32 flex-1">
                            <span className="mb-1 block text-xs font-medium text-muted">Nº de lote</span>
                            <input
                              className="input"
                              value={l.lote}
                              onChange={(e) => actualizarLote(i, { lote: e.target.value })}
                              placeholder="Opcional"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-medium text-muted">Vencimiento *</span>
                            <input
                              type="date"
                              className="input"
                              value={l.vencimiento}
                              onChange={(e) => actualizarLote(i, { vencimiento: e.target.value })}
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => setForm({ ...form, lotes: form.lotes.filter((_, j) => j !== i) })}
                            className="py-2 text-sm font-medium text-danger hover:underline"
                          >
                            Quitar
                          </button>
                        </div>
                      </li>
                    )
                  )}
                </ul>

                <button
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      lotes: [
                        ...form.lotes,
                        { sucursalId: sucursales[0].id, lote: "", vencimiento: "", deConteo: false, cantidad: 0 },
                      ],
                    })
                  }
                  className="mt-2 flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-paper"
                >
                  <IconMas className="h-3.5 w-3.5" />
                  Agregar lote
                </button>

                <p className="mt-1.5 text-xs text-muted">
                  Sirve para vigilar vencimientos sin esperar al próximo conteo físico. No declara cuánto hay: la
                  existencia sale del conteo y de los ajustes, nunca de acá.
                </p>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center gap-4">
            <button
              onClick={guardar}
              disabled={guardando || !form.nombre.trim()}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {guardando ? "Guardando…" : "Guardar"}
            </button>
            <button onClick={() => setForm(null)} className="text-sm text-muted hover:text-ink">
              Cancelar
            </button>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function IconBuscar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconDescargar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 4v11m0 0-4-4m4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconMas({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconX({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconEmpresa({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M8 21V8.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V21M4 21h16M10 11h1M13 11h1M10 14h1M13 14h1M10 17h1M13 17h1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCajaVacia({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M3 9.5 12 5l9 4.5M3 9.5V18l9 4.5 9-4.5V9.5M3 9.5 12 14l9-4.5M12 14v8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
