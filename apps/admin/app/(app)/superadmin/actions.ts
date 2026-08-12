"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceRoleClient } from "@farmacia/db/server";
import type { Rol } from "@farmacia/db";
import { requireSuperadmin } from "@/lib/dal";

export type ActionState = { error?: string; success?: boolean } | undefined;

const CAMPOS_TEXTO_EMPRESA = [
  "nombre",
  "nit",
  "pais",
  "telefono",
  "email",
  "direccion",
  "ciudad",
  "contacto_emergencia_nombre",
  "contacto_emergencia_telefono",
] as const;

function leerCamposEmpresa(formData: FormData) {
  const campos = Object.fromEntries(
    CAMPOS_TEXTO_EMPRESA.map((campo) => [campo, String(formData.get(campo) ?? "").trim() || null])
  ) as Record<(typeof CAMPOS_TEXTO_EMPRESA)[number], string | null>;
  return campos;
}

export async function crearEmpresa(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSuperadmin();

  const campos = leerCamposEmpresa(formData);
  if (!campos.nombre) return { error: "El nombre es obligatorio." };

  const supabase = await createServerClient();
  const { error } = await supabase.from("empresas").insert({ ...campos, nombre: campos.nombre });

  if (error) return { error: error.message };

  revalidatePath("/superadmin");
  return { success: true };
}

export async function actualizarEmpresa(
  empresaId: string,
  cambios: {
    nombre?: string;
    nit?: string | null;
    pais?: string | null;
    telefono?: string | null;
    email?: string | null;
    direccion?: string | null;
    ciudad?: string | null;
    contacto_emergencia_nombre?: string | null;
    contacto_emergencia_telefono?: string | null;
    activo?: boolean;
  }
): Promise<ActionState> {
  await requireSuperadmin();

  const supabase = await createServerClient();
  const { error } = await supabase.from("empresas").update(cambios).eq("id", empresaId);
  if (error) return { error: error.message };

  revalidatePath("/superadmin");
  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}

export async function actualizarConfigN8n(
  empresaId: string,
  config: { n8n_webhook_url?: string; n8n_webhook_secret?: string }
): Promise<ActionState> {
  await requireSuperadmin();

  const supabase = await createServerClient();
  const { data: actual, error: errLectura } = await supabase
    .from("empresas")
    .select("config")
    .eq("id", empresaId)
    .single();
  if (errLectura) return { error: errLectura.message };

  const { error } = await supabase
    .from("empresas")
    .update({ config: { ...actual.config, ...config } })
    .eq("id", empresaId);
  if (error) return { error: error.message };

  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}

export async function crearSucursal(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSuperadmin();

  const empresaId = String(formData.get("empresaId") ?? "");
  const nombre = String(formData.get("nombre") ?? "").trim();
  const direccion = String(formData.get("direccion") ?? "").trim();

  if (!empresaId || !nombre) return { error: "Falta el nombre de la sucursal." };

  const supabase = await createServerClient();
  const { error } = await supabase.from("sucursales").insert({
    empresa_id: empresaId,
    nombre,
    direccion: direccion || null,
  });
  if (error) return { error: error.message };

  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}

export async function actualizarSucursal(
  empresaId: string,
  sucursalId: string,
  cambios: { nombre?: string; direccion?: string | null; activo?: boolean }
): Promise<ActionState> {
  await requireSuperadmin();

  const supabase = await createServerClient();
  const { error } = await supabase.from("sucursales").update(cambios).eq("id", sucursalId);
  if (error) return { error: error.message };

  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}

export async function crearBodega(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSuperadmin();

  const empresaId = String(formData.get("empresaId") ?? "");
  const sucursalId = String(formData.get("sucursalId") ?? "");
  const nombre = String(formData.get("nombre") ?? "").trim();

  if (!empresaId || !sucursalId || !nombre) return { error: "Elegí la sucursal y el nombre de la bodega." };

  const supabase = await createServerClient();
  const { error } = await supabase.from("bodegas").insert({
    empresa_id: empresaId,
    sucursal_id: sucursalId,
    nombre,
  });
  if (error) return { error: error.message };

  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}

export async function actualizarBodega(
  empresaId: string,
  bodegaId: string,
  cambios: { nombre?: string; activo?: boolean }
): Promise<ActionState> {
  await requireSuperadmin();

  const supabase = await createServerClient();
  const { error } = await supabase.from("bodegas").update(cambios).eq("id", bodegaId);
  if (error) return { error: error.message };

  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}

export async function crearUsuario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSuperadmin();

  const empresaId = String(formData.get("empresaId") ?? "");
  const nombre = String(formData.get("nombre") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const rol = String(formData.get("rol") ?? "") as Rol;
  const sucursalIds = formData.getAll("sucursalIds").map(String);

  if (!empresaId || !nombre || !email || !password) {
    return { error: "Completá nombre, email y contraseña." };
  }
  if (password.length < 8) {
    return { error: "La contraseña necesita al menos 8 caracteres." };
  }
  if (!["superadmin", "gerente", "admin", "operario"].includes(rol)) {
    return { error: "Rol inválido." };
  }
  if (rol === "operario" && sucursalIds.length === 0) {
    return { error: "Un operario necesita al menos una sucursal asignada." };
  }

  // auth.users solo se puede escribir con la service_role key — ninguna
  // policy de RLS cubre esto, es la Admin API de Supabase Auth.
  const admin = createServiceRoleClient();
  const { data: nuevoUsuario, error: errAuth } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (errAuth || !nuevoUsuario.user) {
    return { error: errAuth?.message ?? "No se pudo crear el usuario." };
  }

  // El resto sí pasa por el cliente autenticado del superadmin (su propia
  // sesión) para que quede sujeto a las policies de perfiles/perfiles_sucursal
  // como cualquier otra escritura de la app, no como un bypass silencioso.
  const supabase = await createServerClient();
  const { error: errPerfil } = await supabase.from("perfiles").insert({
    id: nuevoUsuario.user.id,
    nombre,
    empresa_id: empresaId,
    rol,
  });

  if (errPerfil) {
    await admin.auth.admin.deleteUser(nuevoUsuario.user.id);
    return { error: `No se pudo crear el perfil, se deshizo el alta: ${errPerfil.message}` };
  }

  if (rol === "operario" && sucursalIds.length > 0) {
    const { error: errSucursales } = await supabase
      .from("perfiles_sucursal")
      .insert(sucursalIds.map((sucursalId) => ({ perfil_id: nuevoUsuario.user!.id, sucursal_id: sucursalId })));
    if (errSucursales) {
      return {
        error: `El usuario se creó pero no se pudieron asignar las sucursales — asignalas desde su edición: ${errSucursales.message}`,
      };
    }
  }

  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}

// Perfil + sucursales de operario se actualizan en una sola llamada a un
// RPC (actualizar_usuario_superadmin), no como 2-3 escrituras sueltas
// desde acá — antes eran llamadas separadas y si el proceso se caía entre
// el DELETE y el INSERT de perfiles_sucursal, un operario podía quedar
// sin ninguna sucursal asignada. El RPC corre las 3 dentro de una sola
// transacción de Postgres, y de paso limpia las sucursales viejas solo
// si el rol deja de ser 'operario' (antes quedaban colgadas).
export async function actualizarUsuario(
  empresaId: string,
  perfilId: string,
  cambios: { nombre?: string; rol?: Rol; activo?: boolean; sucursalIds?: string[] }
): Promise<ActionState> {
  await requireSuperadmin();

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("actualizar_usuario_superadmin", {
    p_perfil_id: perfilId,
    p_nombre: cambios.nombre ?? null,
    p_rol: cambios.rol ?? null,
    p_activo: cambios.activo ?? null,
    p_sucursal_ids: cambios.sucursalIds ?? null,
  });
  if (error) return { error: error.message };

  revalidatePath(`/superadmin/${empresaId}`);
  return { success: true };
}
