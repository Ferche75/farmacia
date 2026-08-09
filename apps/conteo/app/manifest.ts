import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Farmacia — Conteo",
    short_name: "Conteo",
    description: "Conteo físico de stock con lector de código de barras",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#030712",
    theme_color: "#111827",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
