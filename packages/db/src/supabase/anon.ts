import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";
import type { Database } from "../types/database.types";

// Cliente anon SIN sesión, para verificar una contraseña desde código de
// servidor que no tiene navegador del otro lado.
//
// Existe porque los otros dos clientes no sirven para eso:
//
//   * createServerClient (./server.ts) está atado a las cookies del
//     request (usa `cookies()` de next/headers). Es el correcto para el
//     login del panel, donde el resultado del signInWithPassword TIENE
//     que quedar persistido en la cookie de sesión del navegador que hizo
//     el POST. En un route handler servidor-a-servidor no hay tal
//     navegador: la "sesión" que escribiría sería la del proceso
//     atendiendo un request de pdvlat, o sea basura que nadie va a usar y
//     que en el peor caso se cruza con otra cosa.
//
//   * createServiceRoleClient (./service.ts) se saltea RLS por completo,
//     pero justamente por eso NO puede validar una contraseña: con la
//     service_role key uno ya es todo el mundo. Verificar credenciales
//     reales es lo que hace GoTrue, y GoTrue se llama con la anon key.
//
// De ahí este tercero: anon key + `persistSession: false`, o sea un
// cliente de un solo uso que hace la llamada, devuelve si la contraseña
// era correcta y se tira. No guarda tokens en ningún lado, no hay
// refresh, y quien lo usa NO debe dejar salir la sesión resultante hacia
// el caller (ver apps/admin/app/api/pdvlat/auth-empleado): el único dato
// que se aprovecha del signIn es el `user.id`, para después leer el
// perfil con service_role y aplicar los chequeos de tenancy a mano.
//
// server-only a propósito aunque la anon key sea pública: no es la key lo
// que se protege, es el uso — un signInWithPassword desde el browser
// tiene que persistir la sesión, y este cliente está hecho para no
// hacerlo.
export function createAnonClient() {
  const { url, anonKey } = getSupabaseEnv();

  return createClient<Database>(url, anonKey, {
    auth: { persistSession: false },
  });
}
