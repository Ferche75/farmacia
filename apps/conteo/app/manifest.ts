import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Farmacia — Conteo",
    short_name: "Conteo",
    description: "Conteo físico de stock con lector de código de barras",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    // Antes tenía valores placeholder (#030712/#111827, gris de Tailwind)
    // que nunca coincidieron con el fondo real de la app (--color-ink,
    // globals.css) ni con viewport.themeColor de layout.tsx (#141312) —
    // se notaba como un flash de color raro al abrir la splash screen de
    // la PWA instalada. Ahora coincide con los tres lados.
    background_color: "#141312",
    theme_color: "#141312",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
