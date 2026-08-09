import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@farmacia/db/server";

// Next.js 16 renombró "middleware" a "proxy" (mismo propósito). Este chequeo
// es optimista: solo mira si hay sesión, no el rol (eso requiere una query
// a `perfiles` y se hace en el DAL — ver apps/admin/lib/dal.ts — para no
// pegarle a la base en cada request, incluidas las prefetcheadas).
const PUBLIC_ROUTES = ["/login"];

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);

  const path = request.nextUrl.pathname;
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
