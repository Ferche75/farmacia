"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@farmacia/db/server";

export type LoginState = { error?: string } | undefined;

const ROLES_PERMITIDOS_ADMIN = ["superadmin", "gerente", "admin"] as const;

export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Completá email y contraseña." };
  }

  const supabase = await createServerClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    return { error: "Email o contraseña incorrectos." };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: perfil } = await supabase
    .from("perfiles")
    .select("rol, activo")
    .eq("id", user!.id)
    .single();

  if (!perfil || !perfil.activo) {
    await supabase.auth.signOut();
    return {
      error:
        "Tu usuario no tiene un perfil activo en el sistema. Contactá a tu administrador.",
    };
  }

  if (!ROLES_PERMITIDOS_ADMIN.includes(perfil.rol as "superadmin" | "gerente" | "admin")) {
    await supabase.auth.signOut();
    return {
      error:
        "Esta aplicación es para admin, gerente y superadmin. Como operario, usá la app de conteo.",
    };
  }

  redirect("/");
}

export async function logout() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
