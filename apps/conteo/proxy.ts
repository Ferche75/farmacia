import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@farmacia/db/server";

// Ver apps/admin/proxy.ts para la nota sobre el rename middleware → proxy
// en Next.js 16. Chequeo optimista de sesión; el rol no se valida acá.
const PUBLIC_ROUTES = ["/login"];

// n8n llama a esta ruta server-to-server, sin cookie de sesión — se
// autentica con un secreto compartido que valida el propio route handler
// (ver api/desconocidos/callback-ia/route.ts), nunca con auth.uid(). Sin
// esta excepción, el chequeo de sesión de acá abajo la redirigía a
// /login con un 307 antes de que el handler llegara a correr — bug real,
// confirmado con curl: n8n nunca podía reportar el resultado de la IA.
const RUTAS_SIN_SESION = ["/api/desconocidos/callback-ia"];

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
  // Antes era una lista puntual de excepciones (manifest.webmanifest, sw.js,
  // icon-*.png) — cualquier archivo estático nuevo que no estuviera en esa
  // lista quedaba atrapado por el proxy igual (ver el bug real que esto
  // causó en apps/admin/proxy.ts: una imagen de /public devolvía un
  // redirect 307 a /login en vez de sus bytes, sin sesión). `.*\..*`
  // excluye cualquier ruta con un punto (cualquier archivo con extensión),
  // el patrón que la propia documentación de Next.js recomienda.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
