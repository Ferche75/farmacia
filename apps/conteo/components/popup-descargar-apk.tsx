"use client";

import { useEffect, useState } from "react";

// Solo Android — es un APK, no tiene sentido ofrecerlo en iPhone/desktop
// (pedido explícito: "ya lo sé, solo para Android").
function esAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

// Si esto ya se está viendo DESDE la app instalada (la TWA que genera
// Bubblewrap), Chrome pone ese referrer especial — no tiene sentido
// ofrecerle a alguien que ya la tiene que se la vuelva a descargar.
function yaEstaEnLaApp(): boolean {
  return typeof document !== "undefined" && document.referrer.startsWith("android-app://");
}

/** Popup en el login ofreciendo el APK — pedido explícito: "que al iniciar
 * sesión les salga el popup para descargar la apk ahí mismo". Se muestra
 * en cada visita al login desde un Android que no sea ya la app instalada
 * (sin "no mostrar de nuevo": no se pidió, y el objetivo es justamente que
 * quien todavía usa el navegador la vea seguido hasta instalarla). */
export function PopupDescargarApk() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // navigator/document no existen en el render de servidor: arrancar
    // en `false` y recién decidir acá (post-mount) es justamente lo que
    // evita el mismatch de hidratación — el "cascading render" que marca
    // la regla es el costo aceptado de esa garantía.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (esAndroid() && !yaEstaEnLaApp()) setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-strong/50 p-4 sm:items-center">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl">
        <h2 className="text-base font-bold text-strong">Instalá la app Conteo</h2>
        <p className="mt-2 text-sm leading-relaxed text-strong">
          Andá más rápido escaneando: instalá la app en el teléfono en vez de entrar por el navegador cada vez.
        </p>
        <a
          href="/descargas/conteo.apk"
          download
          className="mt-4 block w-full rounded-lg bg-brand py-2.5 text-center text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Descargar app (APK)
        </a>
        <button
          onClick={() => setVisible(false)}
          className="mt-2 w-full rounded-lg py-2 text-center text-sm font-medium text-soft transition-colors hover:text-strong"
        >
          Ahora no
        </button>
      </div>
    </div>
  );
}
