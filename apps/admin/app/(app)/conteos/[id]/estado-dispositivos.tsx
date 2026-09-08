"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@farmacia/db";

// Lo que el admin no podía ver hasta ahora: apps/conteo muestra
// "N sin sincronizar" EN LA PANTALLA DEL CELULAR, y ahí se quedaba. Con
// el cliente en Bolivia, la única forma de enterarse de que un
// dispositivo tenía la cola trabada era pedirle al operario que leyera la
// pantalla por WhatsApp. Esto lo trae al servidor.
// Ver supabase/migrations/20260912000000_estado_dispositivos_conteo.sql

interface EstadoDispositivo {
  dispositivo: string;
  pendientes: number;
  fallados: number;
  ultimo_error: string | null;
  ultima_conexion: string;
  perfiles: { nombre: string } | null;
}

/** Relativo en castellano, sin dependencias: el proyecto no tiene
 * date-fns/dayjs y no vale la pena sumar una para esto. */
export function hace(iso: string): string {
  const segundos = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(segundos)) return "—";
  if (segundos < 60) return "hace instantes";

  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `hace ${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;

  const dias = Math.floor(horas / 24);
  return dias === 1 ? "hace 1 día" : `hace ${dias} días`;
}

/** El user agent completo no le dice nada a nadie. Se queda con la parte
 * que sí identifica al aparato (el modelo entre paréntesis de Android) y,
 * si no matchea, con un recorte legible — nunca es un identificador
 * exacto y no pretende serlo, alcanza para distinguir dos celulares. */
export function etiquetaDispositivo(ua: string): string {
  const android = ua.match(/Android[^;)]*;\s*([^;)]+)/);
  if (android?.[1]) return android[1].trim();
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua || "—";
}

export function EstadoDispositivos({ conteoId }: { conteoId: string }) {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [estados, setEstados] = useState<EstadoDispositivo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    async function cargar() {
      const { data, error: e } = await supabase
        .from("conteo_dispositivos_estado")
        .select("dispositivo, pendientes, fallados, ultimo_error, ultima_conexion, perfiles(nombre)")
        .eq("conteo_id", conteoId)
        .order("ultima_conexion", { ascending: false });

      if (cancelado) return;
      if (e) {
        setError(e.message);
        return;
      }
      setEstados(
        (data ?? []).map((d) => ({
          ...d,
          perfiles: d.perfiles as unknown as { nombre: string } | null,
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
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-ink">Dispositivos</h2>
        <p className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          No se pudo cargar el estado de los dispositivos: {error}
        </p>
      </div>
    );
  }

  if (estados === null) {
    return (
      <div className="mt-8 border-t border-line pt-6">
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-ink">Dispositivos</h2>
        <p className="text-sm text-muted">Cargando estado de los dispositivos…</p>
      </div>
    );
  }

  return (
    <div className="mt-8 border-t border-line pt-6">
      <h2 className="mb-1 text-lg font-semibold tracking-tight text-ink">Dispositivos</h2>
      <p className="mb-3 text-sm text-muted">
        Estado de los celulares que participaron en este conteo. Si la columna
        &quot;Visto&quot; está desactualizada, ese dispositivo está sin conexión y puede tener
        datos pendientes de subir.
      </p>

      {estados.length === 0 ? (
        // Caso normal, no un error: ningún conteo anterior a esta función
        // tiene filas acá, y nunca las va a tener.
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          Ningún dispositivo reportó estado para este conteo todavía.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-2.5 font-medium">Dispositivo</th>
                <th className="px-4 py-2.5 font-medium">Operario</th>
                <th className="px-4 py-2.5 font-medium">Sin subir</th>
                <th className="px-4 py-2.5 font-medium">Fallados</th>
                <th className="px-4 py-2.5 font-medium">Visto</th>
              </tr>
            </thead>
            <tbody>
              {estados.map((d) => (
                <tr key={d.dispositivo} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-2.5 text-ink">
                    <span title={d.dispositivo}>{etiquetaDispositivo(d.dispositivo)}</span>
                    {d.ultimo_error && (
                      <p className="mt-1 max-w-md text-xs text-danger">Último error: {d.ultimo_error}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{d.perfiles?.nombre ?? "—"}</td>
                  <td
                    className={`px-4 py-2.5 font-mono ${d.pendientes > 0 ? "font-semibold text-warn" : "text-muted"}`}
                  >
                    {d.pendientes}
                  </td>
                  <td
                    className={`px-4 py-2.5 font-mono ${d.fallados > 0 ? "font-semibold text-danger" : "text-muted"}`}
                  >
                    {d.fallados}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    <span title={new Date(d.ultima_conexion).toLocaleString("es-BO")}>
                      {hace(d.ultima_conexion)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
