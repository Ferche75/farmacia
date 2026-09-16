"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceRoleClient } from "@farmacia/db/server";
import type { Rol } from "@farmacia/db";
import { requirePerfilAdmin } from "@/lib/dal";
import type { ActionState } from "../superadmin/actions";

// Los únicos roles que un admin/gerente puede repartir dentro de su
// empresa. La lista está escrita por extensión y no como `Rol` a secas
// justamente para que 'superadmin' NO entre por omisión: si mañana se
// agrega un rol nuevo al type, este arreglo no cambia solo y hay que
// venir a decidirlo a mano, que es lo que se quiere para algo que define
// permisos. Del lado de Postgres la policy dice lo simétrico
// (`rol <> 'superadmin'`, ver 20260918000000) y la UI solo ofrece estos
// tres en el selector: tres capas, ninguna confiando en las otras.
const ROLES_ASIGNABLES = ["admin", "gerente", "operario"] as const;
type RolAsignable = (typeof ROLES_ASIGNABLES)[number];

function esRolAsignable(rol: string): rol is RolAsignable {
  return (ROLES_ASIGNABLES as readonly string[]).includes(rol);
}

// Camino de autoservicio del admin/gerente para dar de alta empleados en
// SU PROPIA empresa. Es una versión más angosta de crearUsuario
// (superadmin/actions.ts): mismo procedimiento de dos pasos (auth.users
// con service_role, después perfiles con la sesión propia) y el mismo
// rollback, pero sin las dos perillas que hacen peligroso al original.
//
// `rol` SÍ se lee del formulario (antes estaba clavado en 'operario'):
// el admin/gerente legítimamente necesita elegir entre sus tres roles
// cuando contrata a un encargado y no a un contador de piso. Lo que
// nunca se acepta es 'superadmin' — ese no es un empleado de la
// farmacia, es el operador de la plataforma, y crearlo desde adentro de
// una empresa sería salirse del tenant propio (ver el encabezado de
// 20260918000000_admin_gerente_gestiona_empleados.sql).
//
// `empresa_id`, en cambio, sigue sin viajar en el request nunca: sale de
// la sesión (requirePerfilAdmin), que es la regla de siempre de este
// código para lo que define permisos (ver registrar_venta,
// generar_codigo_invitacion_pdv). crearUsuario sí lo toma del formulario
// porque el superadmin legítimamente necesita elegir la empresa.
//
// Las policies de 20260918000000 cubren la misma regla del lado de
// Postgres — si esta función se equivocara, el INSERT igual rebota.
// Defensa en profundidad, no redundancia inútil.
export async function crearEmpleado(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const perfil = await requirePerfilAdmin();

  const nombre = String(formData.get("nombre") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const rol = String(formData.get("rol") ?? "");
  const sucursalIds = formData.getAll("sucursalIds").map(String);

  if (!nombre || !email || !password) {
    return { error: "Completá nombre, email y contraseña." };
  }
  if (password.length < 8) {
    return { error: "La contraseña necesita al menos 8 caracteres." };
  }
  if (!esRolAsignable(rol)) {
    return { error: "Elegí un rol válido: admin, gerente u operario." };
  }
  // Solo para operarios: sin sucursal no pueden contar nada, la app de
  // conteo arranca eligiendo entre las suyas y les quedaría la lista
  // vacía. Un admin/gerente ve toda la empresa sin pasar por
  // perfiles_sucursal (tengo_acceso_sucursal corta antes de mirar esa
  // tabla), así que pedirle sucursales sería pedir un dato que no se usa.
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

  // El resto sí pasa por el cliente autenticado de quien está creando
  // (su propia sesión) para que quede sujeto a las policies de
  // perfiles/perfiles_sucursal como cualquier otra escritura de la app,
  // no como un bypass silencioso.
  const supabase = await createServerClient();
  const { error: errPerfil } = await supabase.from("perfiles").insert({
    id: nuevoUsuario.user.id,
    nombre,
    empresa_id: perfil.empresaId,
    rol,
  });

  if (errPerfil) {
    await admin.auth.admin.deleteUser(nuevoUsuario.user.id);
    return { error: `No se pudo crear el perfil, se deshizo el alta: ${errPerfil.message}` };
  }

  // Mismo criterio que crearUsuario (superadmin/actions.ts): las filas de
  // perfiles_sucursal se escriben SOLO si el rol es operario. Para un
  // admin/gerente no cambiarían nada (ver la nota de arriba) y la policy
  // de perfiles_sucursal, que sigue exigiendo `p.rol = 'operario'`, las
  // rebotaría igual.
  if (rol === "operario") {
    const { error: errSucursales } = await supabase
      .from("perfiles_sucursal")
      .insert(sucursalIds.map((sucursalId) => ({ perfil_id: nuevoUsuario.user!.id, sucursal_id: sucursalId })));
    if (errSucursales) {
      // El usuario ya existe y puede entrar, así que no se deshace nada —
      // pero sin sucursales no ve conteos. Se arregla desde su edición.
      return {
        error: `El operario se creó pero no se pudieron asignar las sucursales — asignalas desde su edición: ${errSucursales.message}`,
      };
    }
  }

  revalidatePath("/configuracion");
  return { success: true };
}

// Las dos acciones de abajo editan un empleado que YA existe (ver
// 20260918000000_admin_gerente_gestiona_empleados.sql). Antes de tocar
// nada las dos preguntan lo mismo: ¿esta fila es de MI empresa y no es
// la de un superadmin? Las policies ya lo garantizan, pero si el chequeo
// quedara solo del lado de Postgres el usuario vería un "new row
// violates row-level security policy" en la cara — o, peor en el caso
// del update, cero filas afectadas y ningún error, que se lee como
// éxito. Mismo criterio que el resto del código: RLS es el piso, no el
// único control.
//
// El chequeo se dio vuelta respecto de la versión anterior: era una
// lista blanca de uno (`rol !== 'operario'` ⇒ rechazar) y ahora es una
// lista negra de uno (`rol === 'superadmin'` ⇒ rechazar), igual que la
// policy. Devuelve el rol además del veredicto porque quien llama a
// veces necesita afinar más (actualizarSucursalesOperario solo acepta
// operarios) y así no se pide la misma fila dos veces.
type EmpleadoVerificado = { ok: false; error: string } | { ok: true; rol: Rol };

async function verificarEmpleadoPropio(
  supabase: Awaited<ReturnType<typeof createServerClient>>,
  empresaId: string,
  perfilId: string
): Promise<EmpleadoVerificado> {
  const { data, error } = await supabase
    .from("perfiles")
    .select("rol, empresa_id")
    .eq("id", perfilId)
    .maybeSingle();

  if (error) return { ok: false, error: `No se pudo verificar el empleado: ${error.message}` };
  // maybeSingle y no single: perfiles_select ya acota a la propia
  // empresa, así que un id de otra empresa no viene como error sino
  // como "no hay fila" — para el que pregunta son el mismo caso.
  if (!data || data.empresa_id !== empresaId) return { ok: false, error: "Ese empleado no es de tu empresa." };
  if (data.rol === "superadmin") {
    return { ok: false, error: "Las cuentas de superadmin no se administran desde acá." };
  }
  return { ok: true, rol: data.rol };
}

// Alta/baja de un empleado. Desactivar es la baja blanda: no puede
// entrar más a la app, pero sus conteos anteriores siguen existiendo y
// con nombre. Borrarlo de verdad sigue siendo del superadmin.
export async function actualizarEstadoEmpleado(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const perfil = await requirePerfilAdmin();

  const perfilId = String(formData.get("perfilId") ?? "").trim();
  const activo = String(formData.get("activo") ?? "") === "true";
  if (!perfilId) return { error: "No se indicó a qué empleado." };

  // Nadie se desactiva a sí mismo desde acá. Mientras esto solo tocaba
  // operarios la guarda no hacía falta (un operario no entra a esta
  // pantalla), pero ahora un admin puede tocar filas de admin — incluida
  // la propia — y desactivarse es un tiro en el pie sin vuelta atrás:
  // getPerfilActual devuelve null para un perfil inactivo, así que la
  // sesión siguiente rebota al login y hay que ir a molestar al
  // superadmin para volver a entrar. No hay ningún motivo legítimo para
  // hacerlo (irse del sistema es cerrar sesión, no borrarse el acceso).
  //
  // Esta sola guarda cubre también el caso "la empresa se queda sin
  // ningún admin/gerente activo", que era la otra preocupación: el que
  // ejecuta esta acción es siempre un admin o gerente (requirePerfilAdmin
  // rechaza operarios) y siempre sigue activo después, porque no puede
  // desactivarse. Así que por este camino nunca se llega a cero. Un
  // "no desactives al último admin" aparte sería además un
  // leer-y-después-escribir sin transacción — dos admins simultáneos lo
  // saltarían igual — y prohibiría el caso real de dar de baja a un
  // encargado que se fue.
  if (perfilId === perfil.id) {
    return { error: "No podés desactivar tu propia cuenta." };
  }

  const supabase = await createServerClient();
  const verificado = await verificarEmpleadoPropio(supabase, perfil.empresaId, perfilId);
  if (!verificado.ok) return { error: verificado.error };

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
//
// Esta es la única de las tres que sigue llamándose ...Operario, y a
// propósito: el nombre documenta el recorte que queda. Asignar
// sucursales solo tiene sentido para un operario — tengo_acceso_sucursal
// (20260806000001) ni mira perfiles_sucursal cuando el rol es
// admin/gerente/superadmin, les da la empresa entera — así que una fila
// ahí para un admin no le daría ni le quitaría nada y sería basura que
// confunde. Las policies de perfiles_sucursal siguen exigiendo
// `p.rol = 'operario'` por lo mismo, y la UI esconde la sección de
// sucursales cuando el empleado que se edita no es operario.
export async function actualizarSucursalesOperario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const perfil = await requirePerfilAdmin();

  const perfilId = String(formData.get("perfilId") ?? "").trim();
  // Set: los checkboxes no deberían repetirse, pero el FormData llega
  // del cliente y una fila duplicada rompería el unique de la tabla.
  const sucursalIds = [...new Set(formData.getAll("sucursalIds").map(String))];
  if (!perfilId) return { error: "No se indicó a qué empleado." };
  // Misma regla que el alta (crearEmpleado): un operario sin sucursal no
  // puede contar nada, la app de conteo le quedaría con la lista vacía.
  if (sucursalIds.length === 0) {
    return { error: "Un operario necesita al menos una sucursal asignada." };
  }

  const supabase = await createServerClient();
  const verificado = await verificarEmpleadoPropio(supabase, perfil.empresaId, perfilId);
  if (!verificado.ok) return { error: verificado.error };
  if (verificado.rol !== "operario") {
    return { error: "Las sucursales solo se asignan a operarios: un admin o gerente ve toda la empresa." };
  }

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
