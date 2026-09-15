"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceRoleClient } from "@farmacia/db/server";
import { requirePerfilAdmin } from "@/lib/dal";
import type { ActionState } from "../superadmin/actions";

// Camino de autoservicio del admin/gerente para dar de alta operarios en
// SU PROPIA empresa. Es una versión deliberadamente más angosta de
// crearUsuario (superadmin/actions.ts): mismo procedimiento de dos pasos
// (auth.users con service_role, después perfiles con la sesión propia) y
// el mismo rollback, pero sin ninguna de las dos perillas que hacen
// peligroso al original.
//
// El rol y la empresa NO se leen del formulario — ni siquiera se aceptan
// como campos. `rol` es siempre 'operario' y `empresa_id` sale de la
// sesión (requirePerfilAdmin), que es la regla de siempre de este
// código: lo que define permisos nunca viaja en el request (ver
// registrar_venta, generar_codigo_invitacion_pdv). crearUsuario sí los
// toma porque el superadmin legítimamente necesita elegir ambos.
//
// Las policies de 20260915000000_operarios_autoservicio.sql cubren la
// misma regla del lado de Postgres — si esta función se equivocara, el
// INSERT igual rebota. Defensa en profundidad, no redundancia inútil.
export async function crearOperario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const perfil = await requirePerfilAdmin();

  const nombre = String(formData.get("nombre") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const sucursalIds = formData.getAll("sucursalIds").map(String);

  if (!nombre || !email || !password) {
    return { error: "Completá nombre, email y contraseña." };
  }
  if (password.length < 8) {
    return { error: "La contraseña necesita al menos 8 caracteres." };
  }
  // Un operario sin sucursal no puede contar nada: la app de conteo
  // arranca eligiendo entre las suyas y le quedaría la lista vacía.
  if (sucursalIds.length === 0) {
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

  // El resto sí pasa por el cliente autenticado de quien está creando
  // (su propia sesión) para que quede sujeto a las policies de
  // perfiles/perfiles_sucursal como cualquier otra escritura de la app,
  // no como un bypass silencioso.
  const supabase = await createServerClient();
  const { error: errPerfil } = await supabase.from("perfiles").insert({
    id: nuevoUsuario.user.id,
    nombre,
    empresa_id: perfil.empresaId,
    rol: "operario",
  });

  if (errPerfil) {
    await admin.auth.admin.deleteUser(nuevoUsuario.user.id);
    return { error: `No se pudo crear el perfil, se deshizo el alta: ${errPerfil.message}` };
  }

  const { error: errSucursales } = await supabase
    .from("perfiles_sucursal")
    .insert(sucursalIds.map((sucursalId) => ({ perfil_id: nuevoUsuario.user!.id, sucursal_id: sucursalId })));
  if (errSucursales) {
    // El usuario ya existe y puede entrar, así que no se deshace nada —
    // pero sin sucursales no ve conteos. Reasignarlas todavía es cosa
    // del superadmin (esta pasada solo cubre el alta).
    return {
      error: `El operario se creó pero no se pudieron asignar las sucursales — pedile al superadmin que las asigne: ${errSucursales.message}`,
    };
  }

  revalidatePath("/configuracion");
  return { success: true };
}
