"use client";

import { useEffect } from "react";

export function RegistrarServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Instalación de PWA no crítica: si falla, la app sigue
        // funcionando online normalmente.
      });
    }
  }, []);

  return null;
}
