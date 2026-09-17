import { NextResponse } from "next/server";
import { createAnonClient, createServiceRoleClient } from "@farmacia/db/server";
import { autenticarPdv } from "@/lib/pdvlat";

export const dynamic = "force-dynamic";

// Un solo mensaje para TODAS las formas de fallar del lado del empleado:
// contraseña incorrecta, email que no existe, perfil desactivado, perfil
// de OTRA empresa y rol superadmin devuelven exactamente esto. Distinguir
// entre ellos le regalaría a cualquiera que tenga un api_key un
// enumerador de cuentas de toda la plataforma ("este email existe pero es
// de otra empresa" es justo el dato que no se puede dar).
//
// Función y no una constante de módulo: el body de una Response es un
// stream de un solo uso, así que una misma instancia compartida entre
// requests reventaría en el segundo que la devuelva. Mismo criterio que
// el `noAutorizado` que autenticarPdv arma adentro de cada llamada.
function credencialesInvalidas() {
  return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
}

// Login de cajero de pdvlat con su cuenta de Farmacia (SSO pobre pero
// honesto): el POS deja de tener usuarios propios y una alta/baja de
// empleado se hace en un solo lado.
//
// DOBLE FACTOR, y los dos son necesarios:
//   1. X-PDV-Api-Key / X-PDV-Api-Secret (autenticarPdv, igual que
//      /catalogo y /ventas): identifica a la INTEGRACIÓN, o sea a la
//      empresa. Sin esto, este endpoint sería un oráculo público de
//      contraseñas de Farmacia.
//   2. email + password del empleado: identifica a la PERSONA.
// El chequeo que los une —y el que de verdad importa— es que el perfil
// que salió del login pertenezca a la MISMA empresa que la integración
// del api_key. Sin él, cualquiera con un api_key válido podría loguear a
// un usuario de otra empresa cualquiera de la plataforma contra su propio
// POS.
//
// NO devuelve sesión, ni access_token, ni refresh_token. El signIn de acá
// es una VERIFICACIÓN de contraseña y nada más: lo único que se
// aprovecha de él es el user.id para buscar el perfil. pdvlat maneja su
// propia sesión de caja del lado del POS.
//
// POST /api/pdvlat/auth-empleado
// Headers: X-PDV-Api-Key, X-PDV-Api-Secret
// { "email": "...", "password": "..." }
// → { "perfil_id", "nombre", "rol", "sucursales": ["uuid", ...] }
export async function POST(request: Request) {
  const auth = await autenticarPdv(request);
  if ("respuesta" in auth) return auth.respuesta;

  const { empresaId } = auth.integracion;
  const body = await request.json().catch(() => null);

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "Faltan 'email' y/o 'password'" },
      { status: 400 }
    );
  }

  // Cliente anon de un solo uso (ver packages/db/src/supabase/anon.ts): la
  // contraseña la valida GoTrue, que es el único que sabe el hash. No se
  // usa el cliente con cookies del panel —acá no hay navegador a quien
  // persistirle una sesión— ni el de service_role, que se saltea RLS y
  // por eso mismo no puede verificar nada.
  const anon = createAnonClient();
  const { data: sesion, error: errorLogin } = await anon.auth.signInWithPassword(
    { email, password }
  );

  if (errorLogin || !sesion?.user) return credencialesInvalidas();

  // A propósito NO se llama a anon.auth.signOut(): su scope por defecto es
  // 'global' y revocaría TODAS las sesiones del usuario — lo sacaría del
  // panel de Farmacia por haber abierto la caja. La sesión que se acaba de
  // crear vive solo en memoria de este cliente (persistSession: false) y
  // se descarta al terminar el request.
  const usuarioId = sesion.user.id;

  const supabase = createServiceRoleClient();

  // Con service_role y el chequeo de empresa a mano, no con RLS: el que
  // consulta es un servidor sin sesión (auth.uid() es null acá, así que
  // mi_empresa_id() no existe como frontera), y el límite de tenancy que
  // corresponde no es "la empresa del usuario logueado" sino "la empresa
  // de la integración del api_key". Eso solo se puede afirmar en código.
  const { data: perfil } = await supabase
    .from("perfiles")
    .select("id, nombre, rol, activo, empresa_id")
    .eq("id", usuarioId)
    .maybeSingle();

  // Las cuatro razones para rechazar, juntas y con la misma respuesta:
  //   * sin perfil: usuario de auth sin fila en perfiles (no debería
  //     pasar, pero no se asume).
  //   * empresa_id distinto: login válido, PERO de otra empresa. Este es
  //     el chequeo de tenancy; empresaId sale de autenticarPdv, o sea de
  //     la fila de integraciones_pdv del api_key, nunca del body.
  //   * inactivo: baja de empleado. La cuenta de auth puede seguir
  //     existiendo; `activo` es la que manda en el dominio.
  //   * superadmin: es el operador de la plataforma (nosotros), no
  //     personal de la empresa. Nunca tiene que poder abrir una caja, ni
  //     siquiera de la empresa que tenga cargada en su perfil.
  if (
    !perfil ||
    perfil.empresa_id !== empresaId ||
    !perfil.activo ||
    perfil.rol === "superadmin"
  ) {
    return credencialesInvalidas();
  }

  // Sucursales habilitadas. Misma convención que ya usa el resto de la
  // app (ver tengo_acceso_sucursal() en 20260806000000 y
  // apps/conteo/lib/sucursales.ts): un operario está acotado a las filas
  // de perfiles_sucursal, y admin/gerente tienen acceso implícito a TODA
  // la empresa sin necesitar ninguna fila ahí.
  //
  // Por eso admin/gerente devuelven [] y eso significa "todas las de la
  // empresa", no "ninguna": listarlas acá sería duplicar exactamente lo
  // que /api/pdvlat/vincular ya le entregó a pdvlat en su campo
  // `sucursales`, con el riesgo de que las dos listas queden
  // desincronizadas. Un operario sin filas devuelve [] también, pero ese
  // caso lo tapa el rol: pdvlat solo expande [] a "todas" cuando el rol
  // es admin o gerente.
  let sucursales: string[] = [];

  if (perfil.rol === "operario") {
    const { data: asignadas, error: errorSucursales } = await supabase
      .from("perfiles_sucursal")
      .select("sucursal_id")
      .eq("perfil_id", perfil.id);

    if (errorSucursales) {
      return NextResponse.json(
        { error: errorSucursales.message },
        { status: 500 }
      );
    }

    sucursales = (asignadas ?? []).map((fila) => fila.sucursal_id);
  }

  // Solo estos cuatro campos salen. Nada de la sesión de Supabase —
  // tokens, email, metadata del usuario de auth— cruza este borde.
  return NextResponse.json({
    perfil_id: perfil.id,
    nombre: perfil.nombre,
    rol: perfil.rol,
    sucursales,
  });
}
