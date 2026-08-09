"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "../types/database.types";
import { getSupabaseEnv } from "./env";

// Cliente para Client Components. Nunca incluir la service_role key acá.
export function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  return createBrowserClient<Database>(url, anonKey);
}
