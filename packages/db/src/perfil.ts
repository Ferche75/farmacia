import "server-only";

import { cache } from "react";
import type { Rol } from "./types/database.types";
import { createClient } from "./supabase/server";

export interface PerfilActual {
  id: string;
  nombre: string;
  empresaId: string;
  rol: Rol;
  sucursalIds: string[];
}

// Memoizado con React cache() por render pass: llamarlo desde varios
// Server Components en la misma request no dispara queries repetidas.
// Devuelve null si no hay sesión o el perfil está inactivo — quien lo
// llama decide si redirige a /login.
export const getPerfilActual = cache(
  async (): Promise<PerfilActual | null> => {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return null;

    const { data: perfil } = await supabase
      .from("perfiles")
      .select("id, nombre, empresa_id, rol, activo")
      .eq("id", user.id)
      .single();

    if (!perfil || !perfil.activo) return null;

    const { data: sucursales } = await supabase
      .from("perfiles_sucursal")
      .select("sucursal_id")
      .eq("perfil_id", user.id);

    return {
      id: perfil.id,
      nombre: perfil.nombre,
      empresaId: perfil.empresa_id,
      rol: perfil.rol,
      sucursalIds: (sucursales ?? []).map((s) => s.sucursal_id),
    };
  }
);
