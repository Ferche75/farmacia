import type { Metadata, Viewport } from "next";
import { Lexend, IBM_Plex_Mono } from "next/font/google";
import { RegistrarServiceWorker } from "@/components/registrar-service-worker";
import "./globals.css";

const lexend = Lexend({
  variable: "--font-lexend",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Farmacia — Conteo",
  description: "Conteo físico de stock con lector de código de barras",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Conteo" },
};

export const viewport: Viewport = {
  themeColor: "#141312",
  // El operario cuenta parado, con una mano: bloqueamos el zoom por gesto
  // para que un pellizco accidental no lo saque de la pantalla de conteo.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${lexend.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-ink text-paper">
        <RegistrarServiceWorker />
        {children}
      </body>
    </html>
  );
}
