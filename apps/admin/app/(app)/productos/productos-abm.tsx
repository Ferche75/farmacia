"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@farmacia/db";
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

// Mismos umbrales de 90/180 días que ya usa resumen_conteo (Fase 6) y la
// página /vencimientos.
function VencimientoBadge({ fecha }: { fecha: string }) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const dias = Math.round((new Date(fecha).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
  const texto = new Date(fecha).toLocaleDateString("es-BO");
  const color = dias < 0 || dias <= 90 ? "text-danger" : dias <= 180 ? "text-warn" : "text-muted";
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
  requiereReceta: boolean;
  controlado: boolean;
  activo: boolean;
  codigoBarra: string; // solo se usa al crear
  costo: string;
  precio: string;
  stockMinimo: string;
  codigoProveedor: string;
}

const FORM_VACIO: FormState = {
  nombre: "",
  laboratorioNombre: "",
  principioActivo: "",
  concentracion: "",
  contenido: "",
  unidad: "",
  categoria: "",
  requiereReceta: false,
  controlado: false,
  activo: true,
  codigoBarra: "",
  costo: "",
  precio: "",
  stockMinimo: "",
  codigoProveedor: "",
};

interface LoteResumen {
  vencimiento: string;
  sucursalNombre: string;
}

const TAMANO_PAGINA = 50;

export function ProductosAbm({ empresaId }: { empresaId: string }) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [term, setTerm] = useState("");
  const [pagina, setPagina] = useState(0);
  const [totalFilas, setTotalFilas] = useState(0);
  const [resultados, setResultados] = useState<ProductoFila[]>([]);
  const [lotesPorProducto, setLotesPorProducto] = useState<Map<string, LoteResumen[]>>(new Map());
  const [buscando, setBuscando] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);

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
          "id, nombre, laboratorio_id, principio_activo, concentracion, contenido, unidad, categoria, requiere_receta, controlado, activo, laboratorios(nombre), codigos_barra(codigo_raw, es_principal)",
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
      requiereReceta: p.requiere_receta,
      controlado: p.controlado,
    });
  }

  async function abrirEditar(p: ProductoFila) {
    setError(null);
    const { data: pe } = await supabase
      .from("productos_empresa")
      .select("costo, precio, stock_minimo, codigo_proveedor")
      .eq("empresa_id", empresaId)
      .eq("producto_id", p.id)
      .maybeSingle();

    setForm({
      id: p.id,
      nombre: p.nombre,
      laboratorioNombre: p.laboratorios?.nombre ?? "",
      principioActivo: p.principio_activo ?? "",
      concentracion: p.concentracion ?? "",
      contenido: p.contenido != null ? String(p.contenido) : "",
      unidad: p.unidad ?? "",
      categoria: p.categoria ?? "",
      requiereReceta: p.requiere_receta,
      controlado: p.controlado,
      activo: p.activo,
      codigoBarra: "",
      costo: pe?.costo != null ? String(pe.costo) : "",
      precio: pe?.precio != null ? String(pe.precio) : "",
      stockMinimo: pe?.stock_minimo != null ? String(pe.stock_minimo) : "",
      codigoProveedor: pe?.codigo_proveedor ?? "",
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
        });
        if (cbErr) throw cbErr;
      }

      if (form.costo || form.precio || form.stockMinimo || form.codigoProveedor) {
        const { error: peErr } = await supabase.from("productos_empresa").upsert(
          {
            empresa_id: empresaId,
            producto_id: productoId,
            costo: form.costo ? Number(form.costo) : null,
            precio: form.precio ? Number(form.precio) : null,
            stock_minimo: form.stockMinimo ? Number(form.stockMinimo) : null,
            codigo_proveedor: form.codigoProveedor || null,
          },
          { onConflict: "empresa_id,producto_id" }
        );
        if (peErr) throw peErr;
      }

      setForm(null);
      setTerm((t) => t); // re-dispara la búsqueda vía el useEffect
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar el producto.");
    } finally {
      setGuardando(false);
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
          <button
            onClick={exportarCatalogo}
            disabled={exportando}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-50"
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
          <table className="w-full min-w-[1400px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted whitespace-nowrap">
                <th className="px-4 py-2.5 font-medium">Nombre</th>
                <th className="px-4 py-2.5 font-medium">Código de barras</th>
                <th className="px-4 py-2.5 font-medium">Laboratorio</th>
                <th className="px-4 py-2.5 font-medium">Presentación</th>
                <th className="px-4 py-2.5 font-medium">Concentración</th>
                <th className="px-4 py-2.5 font-medium">Principio activo</th>
                <th className="px-4 py-2.5 font-medium">Categoría</th>
                <th className="px-4 py-2.5 font-medium">Sucursal</th>
                <th className="px-4 py-2.5 font-medium">Vencimiento</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {resultados.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 whitespace-nowrap hover:bg-paper">
                  <td className="px-4 py-2.5 text-ink">{p.nombre}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">
                    {codigoPrincipal(p.codigos_barra) ?? "—"}
                    {p.codigos_barra.length > 1 && (
                      <span className="ml-1 text-line">+{p.codigos_barra.length - 1}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.laboratorios?.nombre ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {p.contenido != null ? `${p.contenido} ${p.unidad ?? ""}`.trim() : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.concentracion ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{p.principio_activo ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{p.categoria ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {(() => {
                      const lotes = lotesPorProducto.get(p.id);
                      if (!lotes || lotes.length === 0) return "—";
                      const sucursales = [...new Set(lotes.map((l) => l.sucursalNombre))];
                      return sucursales.length > 1 ? `${sucursales[0]} +${sucursales.length - 1}` : sucursales[0];
                    })()}
                  </td>
                  <td className="px-4 py-2.5">
                    {(() => {
                      const lotes = lotesPorProducto.get(p.id);
                      if (!lotes || lotes.length === 0) return <span className="text-muted">—</span>;
                      // Ordenados por vencimiento asc en la consulta: el primero es el más próximo.
                      return <VencimientoBadge fecha={lotes[0].vencimiento} />;
                    })()}
                  </td>
                  <td className="px-4 py-2.5">
                    {p.activo ? <span className="text-ok">activo</span> : <span className="text-muted">inactivo</span>}
                  </td>
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
                  <td colSpan={11} className="py-16">
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
            <Campo label="Código de proveedor">
              <input
                className="input"
                value={form.codigoProveedor}
                onChange={(e) => setForm({ ...form, codigoProveedor: e.target.value })}
              />
            </Campo>
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
