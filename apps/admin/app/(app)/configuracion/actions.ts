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

// Las dos acciones de abajo editan un operario que YA existe (ver
// 20260917000000_editar_operarios_autoservicio.sql). Antes de tocar nada
// las dos preguntan lo mismo: ¿esta fila es realmente un operario de MI
// empresa? Las policies ya lo garantizan, pero si el chequeo quedara
// solo del lado de Postgres el usuario vería un "new row violates
// row-level security policy" en la cara — o, peor en el caso del update,
// cero filas afectadas y ningún error, que se lee como éxito. Mismo
// criterio que el resto del código: RLS es el piso, no el único control.
async function verificarOperarioPropio(
  supabase: Awaited<ReturnType<typeof createServerClient>>,
  empresaId: string,
  perfilId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("perfiles")
    .select("rol, empresa_id")
    .eq("id", perfilId)
    .maybeSingle();

  if (error) return `No se pudo verificar el empleado: ${error.message}`;
  // maybeSingle y no single: perfiles_select ya acota a la propia
  // empresa, así que un id de otra empresa no viene como error sino
  // como "no hay fila" — para el que pregunta son el mismo caso.
  if (!data || data.empresa_id !== empresaId) return "Ese empleado no es de tu empresa.";
  if (data.rol !== "operario") {
    return "Solo podés editar operarios. Para un admin o gerente, pedile al superadmin.";
  }
  return null;
}

// Alta/baja de un operario. Desactivar es la baja blanda: no puede
// entrar más a la app de conteo, pero sus conteos anteriores siguen
// existiendo y con nombre. Borrarlo de verdad sigue siendo del
// superadmin.
export async function actualizarEstadoOperario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const perfil = await requirePerfilAdmin();

  const perfilId = String(formData.get("perfilId") ?? "").trim();
  const activo = String(formData.get("activo") ?? "") === "true";
  if (!perfilId) return { error: "No se indicó a qué empleado." };

  const supabase = await createServerClient();
  const problema = await verificarOperarioPropio(supabase, perfil.empresaId, perfilId);
  if (problema) return { error: problema };

  // Solo `activo`: el rol y la empresa ni se mencionan acá, y el
  // `with check` de la policy los frena igual si el request viniera
  // modificado.
  const { error } = await supabase.from("perfiles").update({ activo }).eq("id", perfilId);
  if (error) return { error: `No se pudo cambiar el estado: ${error.message}` };

  revalidatePath("/configuracion");
  return { success: true };
}

// Reasignación de sucursales. El formulario manda el conjunto COMPLETO
// de sucursales marcadas (mismo shape que el alta), no un delta, así que
// acá se calcula la diferencia contra lo que hay guardado y se tocan
// solo las filas que cambian — reemplazar todo a lo bruto (borrar y
// reinsertar) haría que dos admins editando a la vez se pisen y, peor,
// dejaría al operario sin ninguna sucursal si el insert falla.
export async function actualizarSucursalesOperario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const perfil = await requirePerfilAdmin();

  const perfilId = String(formData.get("perfilId") ?? "").trim();
  // Set: los checkboxes no deberían repetirse, pero el FormData llega
  // del cliente y una fila duplicada rompería el unique de la tabla.
  const sucursalIds = [...new Set(formData.getAll("sucursalIds").map(String))];
  if (!perfilId) return { error: "No se indicó a qué empleado." };
  // Misma regla que el alta (crearOperario): un operario sin sucursal no
  // puede contar nada, la app de conteo le quedaría con la lista vacía.
  if (sucursalIds.length === 0) {
    return { error: "Un operario necesita al menos una sucursal asignada." };
  }

  const supabase = await createServerClient();
  const problema = await verificarOperarioPropio(supabase, perfil.empresaId, perfilId);
  if (problema) return { error: problema };

  const { data: actuales, error: errActuales } = await supabase
    .from("perfiles_sucursal")
    .select("sucursal_id")
    .eq("perfil_id", perfilId);
  if (errActuales) return { error: `No se pudieron leer las sucursales actuales: ${errActuales.message}` };

  const yaAsignadas = new Set((actuales ?? []).map((r) => r.sucursal_id));
  const aAgregar = sucursalIds.filter((id) => !yaAsignadas.has(id));
  const aQuitar = [...yaAsignadas].filter((id) => !sucursalIds.includes(id));

  // Primero agregar y después quitar, no al revés: si el segundo paso
  // falla, el operario queda con una sucursal de más (inofensivo, se
  // reintenta) en vez de con ninguna. No hay transacción acá — son dos
  // statements sueltos por PostgREST.
  if (aAgregar.length > 0) {
    const { error } = await supabase
      .from("perfiles_sucursal")
      .insert(aAgregar.map((sucursalId) => ({ perfil_id: perfilId, sucursal_id: sucursalId })));
    if (error) return { error: `No se pudieron asignar las sucursales nuevas: ${error.message}` };
  }

  if (aQuitar.length > 0) {
    const { error } = await supabase
      .from("perfiles_sucursal")
      .delete()
      .eq("perfil_id", perfilId)
      .in("sucursal_id", aQuitar);
    if (error) return { error: `No se pudieron quitar las sucursales desmarcadas: ${error.message}` };
  }

  revalidatePath("/configuracion");
  return { success: true };
}
