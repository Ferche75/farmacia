"use client";

import { useEffect, useMemo, useState } from "react";
import { ajustarStock, createBrowserClient } from "@farmacia/db";

// Pantalla nueva (mudanza, no alta): esto vivía como el bloque
// "Stock actual / Corregir" dentro del modal de editar producto de
// /productos, pegado a los campos de nombre/precio/etc. Pedido explícito
// del usuario: editar los datos de un producto no debe tener al lado un
// campo que toque cuánto hay en el estante, aunque esté auditado — para
// que el flujo normal de stock siga siendo "lo dice el conteo físico".
//
// Esta pantalla sigue siendo la EXCEPCIÓN explícita a esa regla: romper
// una caja, un faltante o un conteo mal cargado se corrigen acá sin
// rehacer el conteo entero, con motivo obligatorio y auditoría completa
// (queda quién/cuándo/por qué — ver ajustar_stock,
// supabase/migrations/20260914000000_ajuste_manual_de_stock.sql). El RPC
// no cambió en nada, ni sus permisos (admin/gerente/superadmin): lo único
// que se movió es DÓNDE vive el botón.

interface ProductoBusqueda {
  id: string;
  nombre: string;
  laboratorios: { nombre: string } | null;
}

interface SucursalOpcion {
  id: string;
  nombre: string;
}

// Calcado de StockSucursal en productos-abm.tsx (que ya no existe ahí —
// se movió acá entero con el resto del bloque).
interface StockSucursal {
  cargando: boolean;
  caja: number | null;
  sueltas: number | null;
  error: string | null;
}

// stock_actual devuelve numeric: casi siempre entero, pero un
// productos.contenido fraccionario puede dejar decimales. No se redondea
// (sería mentir sobre lo que dice la base), solo se recortan los ceros.
// Duplicado a propósito del de productos-abm.tsx: es una función de 1
// línea sin estado, no vale la pena compartirla entre dos rutas.
function formatearStock(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : String(Math.round(valor * 100) / 100);
}

// Los errores de un RPC de Supabase llegan como PostgrestError (un objeto
// plano con .message), NO como una instancia de Error.
function mensajeDeError(e: unknown, fallback: string): string {
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return fallback;
}

export function AjustesStock({ empresaId }: { empresaId: string }) {
  const supabase = useMemo(() => createBrowserClient(), []);

  const [sucursales, setSucursales] = useState<SucursalOpcion[]>([]);

  // Buscador de producto — mismo patrón simple que
  // apps/admin/app/(app)/desconocidos/panel-detalle.tsx (ilike por
  // nombre, debounce de 250ms): acá no hace falta el buscador pesado de
  // /productos (código de barras, SKU, paginación, columnas), es elegir
  // UN producto para corregirle el stock.
  const [terminoBusqueda, setTerminoBusqueda] = useState("");
  const [resultadosBusqueda, setResultadosBusqueda] = useState<ProductoBusqueda[]>([]);
  const [productoElegido, setProductoElegido] = useState<ProductoBusqueda | null>(null);

  // ── Stock del producto elegido (calcado de productos-abm.tsx) ──
  const [stockPorSucursal, setStockPorSucursal] = useState<Map<string, StockSucursal>>(new Map());
  const [ajusteAbierto, setAjusteAbierto] = useState<string | null>(null); // sucursal_id
  const [ajusteCantidad, setAjusteCantidad] = useState("");
  const [ajusteMotivo, setAjusteMotivo] = useState("");
  const [ajustando, setAjustando] = useState(false);
  const [ajusteError, setAjusteError] = useState<string | null>(null);
  const [ajusteOk, setAjusteOk] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("sucursales")
      .select("id, nombre")
      .eq("empresa_id", empresaId)
      .eq("activo", true)
      .order("nombre")
      .then(({ data }) => setSucursales(data ?? []));
  }, [supabase, empresaId]);

  useEffect(() => {
    let cancelado = false;

    async function buscar() {
      if (!terminoBusqueda.trim()) {
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
  }, [terminoBusqueda, supabase]);

  const productoElegidoId = productoElegido?.id;

  // Reset del formulario de ajuste al cambiar de producto elegido —
  // durante el render, no en un efecto (mismo patrón que ya usaba
  // productos-abm.tsx: react-hooks/set-state-in-effect documenta esto
  // como la forma correcta de "resetear estado cuando cambia algo").
  const [prevProductoId, setPrevProductoId] = useState(productoElegidoId);
  if (productoElegidoId !== prevProductoId) {
    setPrevProductoId(productoElegidoId);
    setAjusteAbierto(null);
    setAjusteCantidad("");
    setAjusteMotivo("");
    setAjusteError(null);
    setAjusteOk(null);
    setStockPorSucursal(new Map());
  }

  useEffect(() => {
    if (!productoElegidoId || sucursales.length === 0) return;

    let cancelado = false;

    for (const s of sucursales) {
      void supabase
        .rpc("stock_actual_desglose", {
          p_empresa_id: empresaId,
          p_producto_id: productoElegidoId,
          p_sucursal_id: s.id,
        })
        .then(({ data, error: rpcError }) => {
          if (cancelado) return;
          const fila = data?.[0];
          setStockPorSucursal((prev) =>
            new Map(prev).set(s.id, {
              cargando: false,
              caja: rpcError ? null : Number(fila?.caja ?? 0),
              sueltas: rpcError ? null : Number(fila?.sueltas ?? 0),
              error: rpcError ? rpcError.message : null,
            })
          );
        });
    }

    return () => {
      cancelado = true;
    };
  }, [productoElegidoId, sucursales, supabase, empresaId]);

  async function guardarAjusteStock(sucursalId: string) {
    if (!productoElegidoId) return;
    setAjustando(true);
    setAjusteError(null);
    setAjusteOk(null);
    try {
      const r = await ajustarStock(supabase, {
        empresaId,
        sucursalId,
        productoId: productoElegidoId,
        cantidadNueva: Number(ajusteCantidad),
        motivo: ajusteMotivo,
      });
      setStockPorSucursal((prev) => {
        const sueltas = prev.get(sucursalId)?.sueltas ?? null;
        return new Map(prev).set(sucursalId, {
          cargando: false,
          caja: r.stock_nuevo - (sueltas ?? 0),
          sueltas,
          error: null,
        });
      });
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

  return (
    <div>
      <div className="rounded-lg border border-line bg-surface p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Ajustes de stock</h1>
        <p className="mt-1.5 text-sm text-muted">
          Para corregir una rotura, un faltante o un conteo mal cargado sin rehacer el conteo entero. Elegí un
          producto y corregí el stock de la sucursal que haga falta — queda registrado quién, cuándo y por qué, el
          motivo es obligatorio. Para todo lo demás, el stock lo define el próximo conteo físico.
        </p>

        <div className="mt-6">
          <input
            className="input max-w-md"
            value={terminoBusqueda}
            onChange={(e) => {
              setTerminoBusqueda(e.target.value);
              setProductoElegido(null);
            }}
            placeholder="Buscar producto por nombre…"
            autoFocus
          />

          {!productoElegido && resultadosBusqueda.length > 0 && (
            <ul className="mt-2 max-w-md divide-y divide-line rounded-md border border-line">
              {resultadosBusqueda.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      setProductoElegido(p);
                      setTerminoBusqueda(p.nombre);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-paper"
                  >
                    {p.nombre}{" "}
                    {p.laboratorios?.nombre && <span className="text-muted">· {p.laboratorios.nombre}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!productoElegido && terminoBusqueda.trim() && resultadosBusqueda.length === 0 && (
            <p className="mt-2 text-sm text-muted">Sin resultados.</p>
          )}
        </div>

        {productoElegido && sucursales.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              Stock actual de &ldquo;{productoElegido.nombre}&rdquo;, en unidades sueltas (último conteo cerrado +
              ventas y ajustes posteriores)
            </span>

            {ajusteOk && (
              <p className="mb-2 rounded-md border border-ok/20 bg-ok-soft px-3 py-2 text-sm text-ok">{ajusteOk}</p>
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
                        <span className="font-medium text-ink">
                          {formatearStock(st.caja ?? 0)}
                          {(st.sueltas ?? 0) > 0 && (
                            <span className="ml-1 font-normal text-brand">
                              + {formatearStock(st.sueltas ?? 0)} sueltas
                            </span>
                          )}
                        </span>
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
                          setAjusteCantidad(
                            st?.caja != null ? String(Math.round(st.caja + (st.sueltas ?? 0))) : ""
                          );
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
          </div>
        )}
      </div>
    </div>
  );
}
