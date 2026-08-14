"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient, resolverDesconocido } from "@farmacia/db";
import type { DesconocidoItem } from "./tipos";

interface FormEdicion {
  nombre: string;
  laboratorio: string;
  concentracionValor: string;
  concentracionUnidad: string;
  contenido: string;
  unidad: string;
}

interface ProductoBusqueda {
  id: string;
  nombre: string;
  laboratorios: { nombre: string } | null;
}

// Mismo vocabulario que el prompt de Gemini en n8n/flujo-desconocidos-ia.json
// (sección "unidad: uno de comprimidos|capsulas|ml|g|unidades|sobres|ampollas")
// — así lo que sugiere la IA cae siempre en una opción real del selector.
const UNIDADES_PRESENTACION = ["comprimidos", "capsulas", "ml", "g", "unidades", "sobres", "ampollas"];
const UNIDADES_CONCENTRACION = ["mg", "ml", "mcg", "%"];

// Parseo best-effort de lo que devuelve la IA (ej. "400 mg") a
// valor+unidad separados para los 2 inputs. Notaciones compuestas tipo
// "500 mg/5 ml" no entran enteras en un numérico — se recorta a la
// primera cantidad+unidad reconocida y el resto se pierde; es una
// simplificación a propósito (la mayoría de los productos son
// concentración simple), corregible a mano si hace falta más precisión.
function parseConcentracion(texto: string | undefined): { valor: string; unidad: string } {
  const match = texto?.match(/(\d+(?:[.,]\d+)?)\s*(mg|ml|mcg|%)/i);
  if (!match) return { valor: "", unidad: "mg" };
  return { valor: match[1].replace(",", "."), unidad: match[2].toLowerCase() };
}

function formVacio(item: DesconocidoItem | null): FormEdicion {
  const ia = item?.ia_respuesta;
  const { valor, unidad } = parseConcentracion(ia?.concentracion);
  return {
    nombre: ia?.nombre ?? "",
    laboratorio: ia?.laboratorio ?? "",
    concentracionValor: valor,
    concentracionUnidad: unidad,
    contenido: ia?.contenido ? String(ia.contenido) : "",
    unidad: ia?.unidad ?? "",
  };
}

const inputClase = "input";
const selectClase = "input";

// laboratorios solo lo puede escribir admin/gerente/superadmin (RLS) —
// que es exactamente quién tiene acceso a esta pantalla, así que un
// insert directo del cliente es seguro acá (mismo patrón que
// productos-abm.tsx: upsert por nombre, sin pantalla de elegir/crear).
async function resolverLaboratorioId(
  supabase: ReturnType<typeof createBrowserClient>,
  nombre: string
): Promise<string | null> {
  const limpio = nombre.trim();
  if (!limpio) return null;
  const { data, error } = await supabase
    .from("laboratorios")
    .upsert({ nombre: limpio }, { onConflict: "nombre" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

function IconChispa({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 3 13.8 9.2 20 11 13.8 12.8 12 19 10.2 12.8 4 11 10.2 9.2 12 3Z" />
    </svg>
  );
}

function IconDocumento({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden>
      <rect x="13" y="4" width="22" height="28" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M18 13h12M18 19h12M18 25h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconBandejaEntrada({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden>
      <path d="M6 24 11 8h26l5 16" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <path
        d="M6 24v12a2 2 0 0 0 2 2h32a2 2 0 0 0 2-2V24H30l-2.5 4h-11L14 24H6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PanelDetalle({
  item,
  onAnterior,
  onSiguiente,
  onResuelto,
}: {
  item: DesconocidoItem | null;
  onAnterior: () => void;
  onSiguiente: () => void;
  onResuelto: () => void;
}) {
  const supabase = useMemo(() => createBrowserClient(), []);

  const [form, setForm] = useState<FormEdicion>(formVacio(null));
  const [itemIdInicializado, setItemIdInicializado] = useState<string | null>(null);
  const [modo, setModo] = useState<"crear" | "vincular">("crear");
  const [fotoUrl, setFotoUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [terminoBusqueda, setTerminoBusqueda] = useState("");
  const [resultadosBusqueda, setResultadosBusqueda] = useState<ProductoBusqueda[]>([]);
  const [productoElegido, setProductoElegido] = useState<ProductoBusqueda | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset al cambiar de item — durante el render, no en un efecto (mismo
  // criterio que apps/conteo/app/(app)/tarjeta-sugerencia.tsx: evita el
  // render en cascada que marca react-hooks/set-state-in-effect).
  if (item && item.id !== itemIdInicializado) {
    setForm(formVacio(item));
    setModo("crear");
    setProductoElegido(null);
    setTerminoBusqueda("");
    setResultadosBusqueda([]);
    setError(null);
    setItemIdInicializado(item.id);
  }

  useEffect(() => {
    let cancelado = false;

    async function cargarFoto() {
      if (!item?.foto_path) {
        setFotoUrl(null);
        return;
      }
      const { data } = await supabase.storage
        .from("desconocidos")
        .createSignedUrl(item.foto_path, 60 * 30);
      if (!cancelado) setFotoUrl(data?.signedUrl ?? null);
    }

    cargarFoto();
    return () => {
      cancelado = true;
    };
  }, [item?.foto_path, supabase]);

  useEffect(() => {
    let cancelado = false;

    async function buscar() {
      if (modo !== "vincular" || !terminoBusqueda.trim()) {
        setResultadosBusqueda([]);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
      if (cancelado) return;

      const { data } = await supabase
        .from("productos")
        .select("id, nombre, laboratorios(nombre)")
        .ilike("nombre", `%${terminoBusqueda.trim()}%`)
        .limit(20);
      if (!cancelado) setResultadosBusqueda((data ?? []) as unknown as ProductoBusqueda[]);
    }

    buscar();
    return () => {
      cancelado = true;
    };
  }, [terminoBusqueda, modo, supabase]);

  async function guardar() {
    if (!item || guardando) return;
    if (modo === "vincular" && !productoElegido) return;
    if (modo === "crear" && !form.nombre.trim()) return;

    setGuardando(true);
    setError(null);
    try {
      if (modo === "vincular" && productoElegido) {
        await resolverDesconocido(supabase, item.id, { productoId: productoElegido.id });
      } else {
        const laboratorioId = await resolverLaboratorioId(supabase, form.laboratorio);
        const concentracion = form.concentracionValor.trim()
          ? `${form.concentracionValor.trim()} ${form.concentracionUnidad}`
          : null;
        await resolverDesconocido(supabase, item.id, {
          nuevoProducto: {
            nombre: form.nombre.trim(),
            laboratorio_id: laboratorioId,
            concentracion,
            contenido: form.contenido ? Number(form.contenido) : null,
            unidad: form.unidad || null,
            origen: item.ia_respuesta ? "ia" : "manual",
          },
        });
      }
      // Sacar el item de la lista ya dispara la selección automática del
      // siguiente (ver bandeja.tsx) — no hace falta llamar onSiguiente acá.
      onResuelto();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo resolver.");
    } finally {
      setGuardando(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const enElemento = e.target as HTMLElement;
    const esCampoDeTexto = enElemento.tagName === "INPUT" || enElemento.tagName === "TEXTAREA";

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      guardar();
      return;
    }
    if (!esCampoDeTexto && e.key === "ArrowDown") {
      e.preventDefault();
      onSiguiente();
    }
    if (!esCampoDeTexto && e.key === "ArrowUp") {
      e.preventDefault();
      onAnterior();
    }
  }

  if (!item) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-line bg-surface px-8 py-10 text-center">
        <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-brand-soft">
          <IconDocumento className="absolute left-1/2 top-2 h-10 w-10 -translate-x-1/2 text-line" />
          <IconBandejaEntrada className="absolute bottom-2 left-1/2 h-14 w-14 -translate-x-1/2 text-brand" />
          <IconChispa className="absolute -right-1 top-1 h-3.5 w-3.5 text-brand-bright/70" />
          <IconChispa className="absolute -left-1.5 bottom-3 h-2.5 w-2.5 text-brand-bright/40" />
        </div>
        <div>
          <p className="font-medium text-ink">Elegí un desconocido de la lista.</p>
          <p className="mt-1 text-sm text-muted">
            Seleccioná un código de la lista para ver el detalle y vincularlo a un producto o crear uno nuevo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 gap-5 overflow-auto rounded-lg border border-line bg-surface p-4"
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="w-72 shrink-0">
        {fotoUrl ? (
          <button onClick={() => setZoom(true)} className="block w-full">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto de Storage vía signed URL, no un asset del sitio */}
            <img src={fotoUrl} alt="" className="w-full rounded-md border border-line object-cover" />
          </button>
        ) : (
          <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-line text-sm text-muted">
            Sin foto
          </div>
        )}

        <p className="mt-2.5 font-mono text-sm text-muted">{item.codigo_norm}</p>

        {item.ia_respuesta && (
          <div className="mt-3 rounded-md border border-brand/20 bg-brand-soft p-2 text-xs text-brand">
            Sugerencia IA — confianza {Math.round((item.ia_confianza ?? 0) * 100)}%
          </div>
        )}
        {item.estado === "no_reconocido" && (
          <div className="mt-3 rounded-md border border-line bg-paper p-2 text-xs text-muted">
            La IA no pudo identificarlo — completá a mano.
          </div>
        )}

        {zoom && fotoUrl && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6"
            onClick={() => setZoom(false)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- foto de Storage vía signed URL */}
            <img src={fotoUrl} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        )}
      </div>

      <div className="flex-1">
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => setModo("crear")}
            className={
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
              (modo === "crear" ? "bg-brand text-paper" : "border border-line text-ink hover:bg-paper")
            }
          >
            Crear producto nuevo
          </button>
          <button
            onClick={() => setModo("vincular")}
            className={
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
              (modo === "vincular" ? "bg-brand text-paper" : "border border-line text-ink hover:bg-paper")
            }
          >
            Vincular a uno existente
          </button>
        </div>

        {error && (
          <p className="mb-3 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
        )}

        {modo === "crear" ? (
          <div className="space-y-3">
            <input
              className={inputClase}
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              placeholder="Nombre *"
              autoFocus
            />
            <input
              className={inputClase}
              value={form.laboratorio}
              onChange={(e) => setForm({ ...form, laboratorio: e.target.value })}
              placeholder="Laboratorio"
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                className={inputClase}
                type="number"
                value={form.concentracionValor}
                onChange={(e) => setForm({ ...form, concentracionValor: e.target.value })}
                placeholder="Concentración"
              />
              <select
                className={selectClase}
                value={form.concentracionUnidad}
                onChange={(e) => setForm({ ...form, concentracionUnidad: e.target.value })}
              >
                {UNIDADES_CONCENTRACION.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <input
                className={inputClase}
                type="number"
                value={form.contenido}
                onChange={(e) => setForm({ ...form, contenido: e.target.value })}
                placeholder="Contenido"
              />
              <select
                className={selectClase}
                value={form.unidad}
                onChange={(e) => setForm({ ...form, unidad: e.target.value })}
              >
                <option value="">Presentación…</option>
                {UNIDADES_PRESENTACION.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div>
            <input
              className={inputClase}
              value={terminoBusqueda}
              onChange={(e) => {
                setTerminoBusqueda(e.target.value);
                setProductoElegido(null);
              }}
              placeholder="Buscar producto por nombre…"
              autoFocus
            />
            {productoElegido ? (
              <p className="mt-2 rounded-md border border-ok/20 bg-ok-soft px-3 py-2 text-sm text-ok">
                Elegido: {productoElegido.nombre}
              </p>
            ) : (
              resultadosBusqueda.length > 0 && (
                <ul className="mt-2 max-h-48 overflow-auto rounded-md border border-line">
                  {resultadosBusqueda.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => setProductoElegido(p)}
                        className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-paper"
                      >
                        {p.nombre}{" "}
                        {p.laboratorios?.nombre && (
                          <span className="text-muted">· {p.laboratorios.nombre}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={guardar}
            disabled={guardando || (modo === "vincular" ? !productoElegido : !form.nombre.trim())}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {guardando ? "Guardando…" : "Guardar (Enter)"}
          </button>
          <span className="text-xs text-muted">↑ / ↓ para navegar la lista</span>
        </div>
      </div>
    </div>
  );
}
