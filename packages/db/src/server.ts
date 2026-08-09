// Entry point server-only ("@farmacia/db/server"). Importar desde acá en
// proxy.ts, Server Components, Server Actions y route handlers — nunca
// desde un archivo con "use client".
export { createClient as createServerClient } from "./supabase/server";
export { updateSession } from "./supabase/proxy";
export { getPerfilActual } from "./perfil";
export type { PerfilActual } from "./perfil";
export { createServiceRoleClient } from "./supabase/service";
