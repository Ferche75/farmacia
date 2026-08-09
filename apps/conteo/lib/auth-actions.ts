"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@farmacia/db/server";

export type LoginState = { error?: string } | undefined;

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
    .select("activo")
    .eq("id", user!.id)
    .single();

  if (!perfil || !perfil.activo) {
    await supabase.auth.signOut();
    return {
      error:
        "Tu usuario no tiene un perfil activo en el sistema. Contactá a tu administrador.",
    };
  }

  redirect("/");
}

export async function logout() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
