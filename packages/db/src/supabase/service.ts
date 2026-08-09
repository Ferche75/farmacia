import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.types";

// Cliente con la service_role key: ignora RLS por completo. Pensado para
// código que corre sin sesión de usuario (el callback que llama n8n
// cuando termina de procesar una foto — ver Fase 4) y que ya valida
// autorización por su cuenta (el secreto compartido del webhook).
//
// Única excepción aceptada (Fase 7, panel de superadmin): crear un
// usuario nuevo requiere llamar auth.admin.createUser, que SOLO existe
// con esta key — no hay policy de Postgres que lo cubra. Esa acción
// primero valida con la sesión real del caller (requireSuperadmin(), con
// el cliente normal) que quien pide el alta es superadmin, y usa esta key
// nada más que para ese único paso — la escritura en `perfiles` que sigue
// vuelve a pasar por el cliente autenticado, sujeto a RLS como cualquier
// otra escritura de la app.
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY para el cliente service_role."
    );
  }

  return createClient<Database>(url, key, { auth: { persistSession: false } });
}
