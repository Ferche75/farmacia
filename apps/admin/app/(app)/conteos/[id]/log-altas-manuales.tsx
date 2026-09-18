"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@farmacia/db";
import { hace } from "./estado-dispositivos";

// Lo que se perdía: desde que el operario da de alta el producto completo
// desde el celular (crear_producto_y_contar), el alta no pasa por la
// bandeja de desconocidos y el admin se encontraba productos nuevos en el
// catálogo sin saber quién los cargó ni contra qué caja física. Esto es el
// rastro: qué foto se sacó, qué se cargó y quién lo hizo.
// Ver supabase/migrations/20260929000000_log_altas_manuales_conteo.sql
//
// La foto vive 7 días (la borra el barrido de
// /api/mantenimiento/borrar-fotos-vencidas); el resto de la fila, para
// siempre.

interface AltaManual {
  id: string;
  producto_id: string;
  usuario_id: string | null;
  dispositivo: string | null;
  codigo_raw: string;
  foto_path: string | null;
  foto_borrada_at: string | null;
  duracion_segundos: number | null;
  datos: Record<string, unknown>;
  creado_at: string;
  perfiles: { nombre: string } | null;
}

/** "3 min 20 s". Duplicado a propósito del formatearDuracion de
 * resumen-gerencial.tsx (que trabaja en horas y llega hasta "2 h 45
 * min"): son dos escalas distintas —un alta manual se mide en minutos, un
 * conteo en horas— y compartir un helper obligaría a un formateador
 * genérico con más opciones que usos. Dos componentes, dos formatos.
 *
 * null es el caso normal, no un error: el cronómetro es best-effort y
 * las altas anteriores a 20260930000000 no lo tienen. */
function formatearSegundos(segundos: number | null): string {
  if (segundos === null || segundos < 0) return "—";
  if (segundos < 60) return `${segundos} s`;
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

// Mapa local y a propósito: hoy no hay un archivo de labels compartido
// entre apps/admin y apps/conteo, y crear uno para seis etiquetas de una
// sola pantalla sería más acoplamiento del que resuelve. Si algún día hace
// falta en tres lugares, ahí sí.
const LABELS: Record<string, string> = {
  laboratorio: "Laboratorio",
  principio_activo: "Principio activo",
  accion_terapeutica: "Acción terapéutica",
  concentracion: "Concentración",
  contenido: "Contenido",
  codigo_proveedor: "Código de proveedor",
  unidades_por_blister: "Unidades por blíster",
  blisters_por_caja: "Blísteres por caja",
  precio_blister: "Precio del blíster",
  precio_unidad: "Precio por unidad",
};

const CAMPOS_BASE = [
  "laboratorio",
  "principio_activo",
  "accion_terapeutica",
  "concentracion",
  "contenido",
  "codigo_proveedor",
];

const CAMPOS_FRACCIONAMIENTO = [
  "unidades_por_blister",
  "blisters_por_caja",
  "precio_blister",
  "precio_unidad",
];

/** `datos` es el jsonb crudo que mandó el celular: cualquier key puede
 * faltar, venir en null o venir como número. Se muestra solo lo que tiene
 * algo cargado — una grilla llena de guiones no dice nada. */
function texto(datos: Record<string, unknown>, campo: string): string | null {
  const valor = datos[campo];
  if (valor === null || valor === undefined || valor === "") return null;
  return String(valor);
}

/** Miniatura con click-to-zoom, mismo patrón que la bandeja de
 * desconocidos (apps/admin/app/(app)/desconocidos/panel-detalle.tsx). La
 * signed URL se pide por fila: el bucket es privado y no hay URL pública
 * que cachear. */
function FotoAlta({ fotoPath, fotoBorradaAt }: { fotoPath: string | null; fotoBorradaAt: string | null }) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    let cancelado = false;

    async function cargar() {
      if (!fotoPath) {
        setUrl(null);
        return;
      }
      const { data } = await supabase.storage.from("altas-manuales").createSignedUrl(fotoPath, 60 * 30);
      if (!cancelado) setUrl(data?.signedUrl ?? null);
    }

    cargar();
    return () => {
      cancelado = true;
    };
  }, [fotoPath, supabase]);

  if (!fotoPath) {
    // Los dos casos de "no hay foto" NO son lo mismo y el admin necesita
    // distinguirlos: "venció" es el funcionamiento normal, "sin foto" es
    // que el celular no la pudo subir (dato de soporte, igual que el
    // panel de dispositivos).
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-line px-1 text-center text-[10px] leading-tight text-muted">
        {fotoBorradaAt ? "Foto vencida (se borra a los 7 días)" : "Sin foto"}
      </div>
    );
  }

  if (!url) {
    return <div className="h-16 w-16 rounded-md border border-line bg-paper" />;
  }

  return (
    <>
      <button onClick={() => setZoom(true)} className="block">
        {/* eslint-disable-next-line @next/next/no-img-element -- foto de Storage vía signed URL, no un asset del sitio */}
        <img src={url} alt="" className="h-16 w-16 rounded-md border border-line object-cover" />
      </button>

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6"
          onClick={() => setZoom(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- foto de Storage vía signed URL */}
          <img src={url} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </>
  );
}

export function LogAltasManuales({ conteoId }: { conteoId: string }) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [altas, setAltas] = useState<AltaManual[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandida, setExpandida] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    async function cargar() {
      // Sin filtro de rol acá: la policy altas_manuales_conteo_select ya
      // deja fuera al operario y a las otras empresas. Si alguien sin
      // permiso llegara a esta pantalla, vería una lista vacía, no un
      // error.
      const { data, error: e } = await supabase
        .from("altas_manuales_conteo")
        .select(
          "id, producto_id, usuario_id, dispositivo, codigo_raw, foto_path, foto_borrada_at, duracion_segundos, datos, creado_at, perfiles(nombre)"
        )
        .eq("conteo_id", conteoId)
        .order("creado_at", { ascending: false });

      if (cancelado) return;
      if (e) {
        setError(e.message);
        return;
      }
      setAltas(
        (data ?? []).map((a) => ({
          ...a,
          datos: (a.datos ?? {}) as Record<string, unknown>,
          perfiles: a.perfiles as unknown as { nombre: string } | null,
        }))
      );
    }

    cargar();
    return () => {
      cancelado = true;
    };
  }, [conteoId, supabase]);

  if (error) {
    return (
      <div className="mt-8 border-t border-line pt-6">
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-ink">Altas manuales</h2>
        <p className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          No se pudo cargar el log de altas manuales: {error}
        </p>
      </div>
    );
  }

  if (altas === null) {
    return (
      <div className="mt-8 border-t border-line pt-6">
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-ink">Altas manuales</h2>
        <p className="text-sm text-muted">Cargando altas manuales…</p>
      </div>
    );
  }

  return (
    <div className="mt-8 border-t border-line pt-6">
      <h2 className="mb-1 text-lg font-semibold tracking-tight text-ink">Altas manuales</h2>
      <p className="mb-3 text-sm text-muted">
        Productos que se crearon desde el celular durante este conteo, con los datos tal
        como se cargaron en ese momento (si después se editaron desde el catálogo, acá
        igual se ve lo original). La foto se guarda 7 días y después se borra sola.
      </p>

      {altas.length === 0 ? (
        // Caso normal, no un error: un conteo donde todo estaba en el
        // catálogo no tiene ninguna fila acá, y los conteos anteriores a
        // esta función tampoco van a tenerla nunca.
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          Ningún alta manual en este conteo todavía.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-2.5 font-medium">Foto</th>
                <th className="px-4 py-2.5 font-medium">Producto</th>
                <th className="px-4 py-2.5 font-medium">Código</th>
                <th className="px-4 py-2.5 font-medium">Precio</th>
                <th className="px-4 py-2.5 font-medium">Operario</th>
                <th className="px-4 py-2.5 font-medium">Cargado</th>
                {/* Cuánto le llevó al operario llenar el formulario — la
                    respuesta a "¿cuánto cuesta cargar un producto que no
                    está en el catálogo?". No cuenta el tiempo de sacar la
                    foto: el cronómetro arranca con el paso 1 ya en
                    pantalla. */}
                <th className="px-4 py-2.5 font-medium">Tiempo</th>
              </tr>
            </thead>
            <tbody>
              {altas.map((a) => {
                const abierta = expandida === a.id;
                const fraccionable = a.datos.fraccionable === true;
                const campos = [...CAMPOS_BASE, ...(fraccionable ? CAMPOS_FRACCIONAMIENTO : [])]
                  .map((campo) => ({ campo, valor: texto(a.datos, campo) }))
                  .filter((c) => c.valor !== null);

                return (
                  <tr key={a.id} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-2.5">
                      <FotoAlta fotoPath={a.foto_path} fotoBorradaAt={a.foto_borrada_at} />
                    </td>
                    <td className="px-4 py-2.5 text-ink">
                      <span className="font-medium">{texto(a.datos, "nombre") ?? "—"}</span>
                      {texto(a.datos, "unidad") && (
                        <span className="text-muted"> · {texto(a.datos, "unidad")}</span>
                      )}
                      {fraccionable && (
                        <span className="ml-2 rounded-full border border-line px-1.5 py-0.5 text-[11px] text-muted">
                          fraccionable
                        </span>
                      )}

                      <button
                        onClick={() => setExpandida(abierta ? null : a.id)}
                        className="mt-1 block text-xs text-brand hover:underline"
                      >
                        {abierta ? "Ocultar datos" : "Ver todos los datos"}
                      </button>

                      {abierta && (
                        <dl className="mt-2 max-w-md space-y-1 rounded-md border border-line bg-paper p-2.5 text-xs">
                          {campos.length === 0 ? (
                            <p className="text-muted">
                              No se cargó ningún dato más allá del nombre y el precio.
                            </p>
                          ) : (
                            campos.map(({ campo, valor }) => (
                              <div key={campo} className="flex gap-2">
                                <dt className="shrink-0 text-muted">{LABELS[campo] ?? campo}:</dt>
                                <dd className="text-ink">{valor}</dd>
                              </div>
                            ))
                          )}
                          {a.dispositivo && (
                            <div className="flex gap-2 border-t border-line pt-1">
                              <dt className="shrink-0 text-muted">Dispositivo:</dt>
                              <dd className="text-ink">{a.dispositivo}</dd>
                            </div>
                          )}
                        </dl>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-muted">{a.codigo_raw}</td>
                    <td className="px-4 py-2.5 font-mono text-ink">{texto(a.datos, "precio") ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted">{a.perfiles?.nombre ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted">
                      <span title={new Date(a.creado_at).toLocaleString("es-BO")}>{hace(a.creado_at)}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-muted">
                      {formatearSegundos(a.duracion_segundos)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
