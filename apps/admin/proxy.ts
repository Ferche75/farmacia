import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@farmacia/db/server";

// Next.js 16 renombró "middleware" a "proxy" (mismo propósito). Este chequeo
// es optimista: solo mira si hay sesión, no el rol (eso requiere una query
// a `perfiles` y se hace en el DAL — ver apps/admin/lib/dal.ts — para no
// pegarle a la base en cada request, incluidas las prefetcheadas).
const PUBLIC_ROUTES = ["/login"];

// pdvlat llama a estas tres server-to-server, sin cookie de sesión: se
// autentican solas (vincular con el código de invitación, ventas/catalogo
// con X-PDV-Api-Key/Secret — ver lib/pdvlat.ts), nunca con auth.uid(). Mismo
// bug real ya encontrado y arreglado en apps/conteo/proxy.ts para el
// callback de n8n: sin esta excepción, el chequeo de sesión de acá abajo
// las redirigía a /login con un 307 antes de que el handler llegara a
// correr — confirmado con curl contra producción (pdvlat recibía HTML de
// login donde esperaba JSON).
const RUTAS_SIN_SESION = ["/api/pdvlat/vincular", "/api/pdvlat/ventas", "/api/pdvlat/catalogo"];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (RUTAS_SIN_SESION.includes(path)) {
    return NextResponse.next();
  }

  const { response, user } = await updateSession(request);

  const isPublicRoute = PUBLIC_ROUTES.includes(path);

  if (!user && !isPublicRoute) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (user && isPublicRoute) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  // El patrón original solo excluía _next/static|_next/image|favicon.ico —
  // cualquier otro archivo estático de /public (imágenes, manifest, etc.)
  // seguía pasando por acá. Sin sesión, eso significaba un redirect 307 a
  // /login para la imagen misma, así que el navegador recibía HTML donde
  // esperaba bytes de imagen. `.*\..*` excluye cualquier ruta con un punto
  // (cualquier archivo con extensión), el patrón que la propia documentación
  // de Next.js recomienda para esto.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
