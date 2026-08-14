"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient, type CampoPersonalizado } from "@farmacia/db";
import { exportarCatalogoCompleto } from "@/lib/exportar-catalogo";

interface ProductoFila {
  id: string;
  nombre: string;
  laboratorio_id: string | null;
  principio_activo: string | null;
  concentracion: string | null;
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

interface FormState {
  id?: string;
  nombre: string;
  laboratorioNombre: string;
  principioActivo: string;
  concentracion: string;
  contenido: string;
  unidad: string;
  categoria: string;
  fabricante: string;
  requiereReceta: boolean;
  controlado: boolean;
  activo: boolean;
  codigoBarra: string; // solo se usa al crear
  unidadesPorCodigo: string; // solo se usa al crear
  costo: string;
  precio: string;
  stockMinimo: string;
  codigoProveedor: string;
  distribuidor: string;
  loteCatalogo: string;
  loteCatalogo2: string;
  sucursalesDisponibles: string[]; // ids de sucursal — solo informativo, ver productos_sucursales
  camposExtra: Record<string, string>; // clave -> valor, ver campos personalizados
}

const FORM_VACIO: FormState = {
  nombre: "",
  laboratorioNombre: "",
  principioActivo: "",
  concentracion: "",
  contenido: "",
  unidad: "",
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
  sucursalesDisponibles: [],
  camposExtra: {},
};

interface LoteResumen {
  vencimiento: string;
  sucursalNombre: string;
}

interface SucursalOpcion {
  id: string;
  nombre: string;
}

const TAMANO_PAGINA = 50;

// Todas las columnas mostrables de la tabla, aparte de Nombre y Acciones
// (esas dos siempre van fijas). El orden acá es el default — el usuario
// lo puede cambiar con los ↑/↓ del panel "Columnas", y la elección de
// cuáles mostrar/ocultar y en qué orden se persiste en localStorage
// (por navegador, no por empresa — es una preferencia de vista, no un
// dato de negocio, no justifica una columna nueva en la base).
const COLUMNAS_FIJAS: { id: string; label: string }[] = [
  { id: "codigoBarra", label: "Código de barras" },
  { id: "laboratorio", label: "Laboratorio" },
  { id: "presentacion", label: "Presentación" },
  { id: "concentracion", label: "Concentración" },
  { id: "principioActivo", label: "Principio activo" },
  { id: "categoria", label: "Categoría" },
  { id: "fabricante", label: "Fabricante" },
  { id: "disponibleEn", label: "Disponible en" },
  { id: "sucursal", label: "Sucursal (vencimiento)" },
  { id: "vencimiento", label: "Vencimiento" },
  { id: "estado", label: "Estado" },
];

// Default deliberadamente angosto — mostrar las 11 columnas de una era
// justamente la queja de "esto es un asco a nivel diseño". El resto
// sigue a un click en "Columnas", no se pierde nada.
const COLUMNAS_VISIBLES_DEFAULT = ["codigoBarra", "laboratorio", "presentacion", "estado"];

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
  const [sucursales, setSucursales] = useState<SucursalOpcion[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);
  const [prefColumnas, setPrefColumnas] = useState(cargarPreferenciaColumnas);
  const [panelColumnasAbierto, setPanelColumnasAbierto] = useState(false);
  const [camposPersonalizados, setCamposPersonalizados] = useState<CampoPersonalizado[]>([]);

  useEffect(() => {
    window.localStorage.setItem(LOCALSTORAGE_KEY_COLUMNAS, JSON.stringify(prefColumnas));
  }, [prefColumnas]);

  function toggleColumna(id: string) {
    setPrefColumnas((prev) => ({
      ...prev,
      visibles: prev.visibles.includes(id) ? prev.visibles.filter((c) => c !== id) : [...prev.visibles, id],
    }));
  }

  function moverColumna(id: string, direccion: -1 | 1) {
    setPrefColumnas((prev) => {
      const i = prev.orden.indexOf(id);
      const j = i + direccion;
      if (i < 0 || j < 0 || j >= prev.orden.length) return prev;
      const nuevoOrden = [...prev.orden];
      [nuevoOrden[i], nuevoOrden[j]] = [nuevoOrden[j], nuevoOrden[i]];
      return { ...prev, orden: nuevoOrden };
    });
  }

  // Campos personalizados (ver /configuracion) se suman como columnas
  // dinámicas más — id "custom:<clave>" para no chocar con las fijas.
  const todasLasColumnas = useMemo(
    () => [...COLUMNAS_FIJAS, ...camposPersonalizados.map((c) => ({ id: `custom:${c.clave}`, label: c.etiqueta }))],
    [camposPersonalizados]
  );

  // Si aparece una columna nueva (empresa acaba de definir un campo)
  // que el usuario todavía no tiene en su preferencia guardada, se
  // agrega visible al final — mejor que quede oculta silenciosamente la
  // primera vez. Es un ajuste derivado de `todasLasColumnas`, no una
  // sincronización con algo externo, así que se resuelve durante el
  // render (comparando contra el último valor visto) en vez de en un
  // efecto — mismo patrón que ya usa el resto del proyecto para esto.
  const idsColumnasConocidas = todasLasColumnas.map((c) => c.id).join(",");
  const [idsColumnasVistos, setIdsColumnasVistos] = useState(idsColumnasConocidas);
  if (idsColumnasVistos !== idsColumnasConocidas) {
    setIdsColumnasVistos(idsColumnasConocidas);
    const nuevas = todasLasColumnas.map((c) => c.id).filter((id) => !prefColumnas.orden.includes(id));
    if (nuevas.length > 0) {
      setPrefColumnas((prev) => ({ orden: [...prev.orden, ...nuevas], visibles: [...prev.visibles, ...nuevas] }));
    }
  }

  const columnasActivas = prefColumnas.orden
    .filter((id) => prefColumnas.visibles.includes(id))
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
      let query = supabase
        .from("productos")
        .select(
          "id, nombre, laboratorio_id, principio_activo, concentracion, contenido, unidad, categoria, fabricante, requiere_receta, controlado, activo, laboratorios(nombre), codigos_barra(codigo_raw, es_principal)",
          { count: "exact" }
        )
        .order("nombre")
        .range(pagina * TAMANO_PAGINA, pagina * TAMANO_PAGINA + TAMANO_PAGINA - 1);
      if (term.trim()) {
        query = query.ilike("nombre", `%${term.trim()}%`);
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
      laboratorioNombre: p.laboratorios?.nombre ?? "",
      principioActivo: p.principio_activo ?? "",
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
        "costo, precio, stock_minimo, codigo_proveedor, distribuidor, lote_catalogo, lote_catalogo_2, campos_extra"
      )
      .eq("empresa_id", empresaId)
      .eq("producto_id", p.id)
      .maybeSingle();

    const { data: disp } = await supabase
      .from("productos_sucursales")
      .select("sucursal_id")
      .eq("empresa_id", empresaId)
      .eq("producto_id", p.id);

    setForm({
      id: p.id,
      nombre: p.nombre,
      laboratorioNombre: p.laboratorios?.nombre ?? "",
      principioActivo: p.principio_activo ?? "",
      concentracion: p.concentracion ?? "",
      contenido: p.contenido != null ? String(p.contenido) : "",
      unidad: p.unidad ?? "",
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
      sucursalesDisponibles: (disp ?? []).map((d) => d.sucursal_id),
      camposExtra: (pe?.campos_extra as Record<string, string> | null) ?? {},
    });
  }

  async function guardar() {
    if (!form) return;
    setGuardando(true);
    setError(null);
    try {
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
        laboratorio_id: laboratorioId,
        principio_activo: form.principioActivo || null,
        concentracion: form.concentracion || null,
        contenido: form.contenido ? Number(form.contenido) : null,
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

      if (
        form.costo ||
        form.precio ||
        form.stockMinimo ||
        form.codigoProveedor ||
        form.distribuidor ||
        form.loteCatalogo ||
        form.loteCatalogo2 ||
        Object.values(form.camposExtra).some((v) => v)
      ) {
        const { error: peErr } = await supabase.from("productos_empresa").upsert(
          {
            empresa_id: empresaId,
            producto_id: productoId,
            costo: form.costo ? Number(form.costo) : null,
            precio: form.precio ? Number(form.precio) : null,
            stock_minimo: form.stockMinimo ? Number(form.stockMinimo) : null,
            codigo_proveedor: form.codigoProveedor || null,
            distribuidor: form.distribuidor || null,
            lote_catalogo: form.loteCatalogo || null,
            lote_catalogo_2: form.loteCatalogo2 || null,
            campos_extra: form.camposExtra,
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
      case "presentacion":
        return p.contenido != null ? `${p.contenido} ${p.unidad ?? ""}`.trim() : "—";
      case "concentracion":
        return p.concentracion ?? "—";
      case "principioActivo":
        return p.principio_activo ?? "—";
      case "categoria":
        return p.categoria ?? "—";
      case "fabricante":
        return p.fabricante ?? "—";
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
          Buscador por nombre (usa el índice de similitud) y alta/edición manual. El catálogo es global — lo que
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
              placeholder="Buscar por nombre…"
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
                    {prefColumnas.orden.map((id, i) => {
                      const col = todasLasColumnas.find((c) => c.id === id);
                      if (!col) return null;
                      const visible = prefColumnas.visibles.includes(id);
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
                            disabled={i === prefColumnas.orden.length - 1}
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

            <Campo label="Laboratorio">
              <input
                className="input"
                value={form.laboratorioNombre}
                onChange={(e) => setForm({ ...form, laboratorioNombre: e.target.value })}
              />
            </Campo>

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
              <Campo label="Unidad">
                <input
                  className="input"
                  value={form.unidad}
                  onChange={(e) => setForm({ ...form, unidad: e.target.value })}
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
            </div>

            <Campo label="Contenido">
              <input
                type="number"
                className="input"
                value={form.contenido}
                onChange={(e) => setForm({ ...form, contenido: e.target.value })}
              />
            </Campo>

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
              <Campo label="Precio">
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
