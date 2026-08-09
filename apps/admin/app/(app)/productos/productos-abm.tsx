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
  forma: string | null;
  contenido: number | null;
  unidad: string | null;
  requiere_receta: boolean;
  controlado: boolean;
  activo: boolean;
  laboratorios: { nombre: string } | null;
}

interface FormState {
  id?: string;
  nombre: string;
  laboratorioNombre: string;
  principioActivo: string;
  concentracion: string;
  forma: string;
  contenido: string;
  unidad: string;
  requiereReceta: boolean;
  controlado: boolean;
  activo: boolean;
  codigoBarra: string; // solo se usa al crear
  costo: string;
  precio: string;
  stockMinimo: string;
}

const FORM_VACIO: FormState = {
  nombre: "",
  laboratorioNombre: "",
  principioActivo: "",
  concentracion: "",
  forma: "",
  contenido: "",
  unidad: "",
  requiereReceta: false,
  controlado: false,
  activo: true,
  codigoBarra: "",
  costo: "",
  precio: "",
  stockMinimo: "",
};

export function ProductosAbm({ empresaId }: { empresaId: string }) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [term, setTerm] = useState("");
  const [resultados, setResultados] = useState<ProductoFila[]>([]);
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
          "id, nombre, laboratorio_id, principio_activo, concentracion, forma, contenido, unidad, requiere_receta, controlado, activo, laboratorios(nombre)"
        )
        .order("nombre")
        .limit(50);
      if (term.trim()) {
        query = query.ilike("nombre", `%${term.trim()}%`);
      }
      const { data } = await query;
      setResultados((data ?? []) as unknown as ProductoFila[]);
      setBuscando(false);
    }, 300);
    return () => clearTimeout(t);
  }, [term, supabase]);

  function abrirNuevo() {
    setError(null);
    setForm(FORM_VACIO);
  }

  async function abrirEditar(p: ProductoFila) {
    setError(null);
    const { data: pe } = await supabase
      .from("productos_empresa")
      .select("costo, precio, stock_minimo")
      .eq("empresa_id", empresaId)
      .eq("producto_id", p.id)
      .maybeSingle();

    setForm({
      id: p.id,
      nombre: p.nombre,
      laboratorioNombre: p.laboratorios?.nombre ?? "",
      principioActivo: p.principio_activo ?? "",
      concentracion: p.concentracion ?? "",
      forma: p.forma ?? "",
      contenido: p.contenido != null ? String(p.contenido) : "",
      unidad: p.unidad ?? "",
      requiereReceta: p.requiere_receta,
      controlado: p.controlado,
      activo: p.activo,
      codigoBarra: "",
      costo: pe?.costo != null ? String(pe.costo) : "",
      precio: pe?.precio != null ? String(pe.precio) : "",
      stockMinimo: pe?.stock_minimo != null ? String(pe.stock_minimo) : "",
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
        forma: form.forma || null,
        contenido: form.contenido ? Number(form.contenido) : null,
        unidad: form.unidad || null,
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

      if (form.costo || form.precio || form.stockMinimo) {
        const { error: peErr } = await supabase.from("productos_empresa").upsert(
          {
            empresa_id: empresaId,
            producto_id: productoId,
            costo: form.costo ? Number(form.costo) : null,
            precio: form.precio ? Number(form.precio) : null,
            stock_minimo: form.stockMinimo ? Number(form.stockMinimo) : null,
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
    <div className={`grid gap-6 ${form ? "grid-cols-[1fr_440px]" : "grid-cols-1"}`}>
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
              onChange={(e) => setTerm(e.target.value)}
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

        <div className="mt-6 overflow-hidden rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-2.5 font-medium">Nombre</th>
                <th className="px-4 py-2.5 font-medium">Laboratorio</th>
                <th className="px-4 py-2.5 font-medium">Forma</th>
                <th className="px-4 py-2.5 font-medium">Concentración</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {resultados.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-4 py-2.5 text-ink">{p.nombre}</td>
                  <td className="px-4 py-2.5 text-muted">{p.laboratorios?.nombre ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{p.forma ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{p.concentracion ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {p.activo ? <span className="text-ok">activo</span> : <span className="text-muted">inactivo</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => abrirEditar(p)} className="font-medium text-brand hover:underline">
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
              {resultados.length === 0 && !buscando && (
                <tr>
                  <td colSpan={6} className="py-16">
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
      </div>

      {form && (
        <div className="h-fit rounded-lg border border-line bg-surface p-8">
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
              <Campo label="Forma">
                <input
                  className="input"
                  value={form.forma}
                  onChange={(e) => setForm({ ...form, forma: e.target.value })}
                />
              </Campo>
              <Campo label="Unidad">
                <input
                  className="input"
                  value={form.unidad}
                  onChange={(e) => setForm({ ...form, unidad: e.target.value })}
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
