import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "../types/database.types";
import { getSupabaseEnv } from "./env";

// Refresca la sesión de Supabase en cada request. Se llama desde el
// proxy.ts de cada app (apps/admin y apps/conteo) — Next.js 16 renombró
// "middleware" a "proxy", pero el propósito y el patrón son los mismos.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() (no getSession()) valida el token contra Supabase Auth en
  // vez de confiar ciegamente en la cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user };
}
