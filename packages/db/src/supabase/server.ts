import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "../types/database.types";
import { getSupabaseEnv } from "./env";

// Cliente para Server Components, Server Actions y Route Handlers.
// Refresca cookies de sesión en cada request (necesario para que el
// access token no expire silenciosamente).
export async function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll llamado desde un Server Component: se ignora porque
          // el proxy ya se encarga de refrescar la sesión en cada request.
        }
      },
    },
  });
}
