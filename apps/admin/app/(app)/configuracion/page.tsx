import type { ReactNode } from "react";
import { requirePerfilAdmin } from "@/lib/dal";
import { createServerClient } from "@farmacia/db/server";
import { VENCIMIENTO_SEMAFORO_DEFAULT, type ConfigOperativaEmpresa, type CampoPersonalizado } from "@farmacia/db";
import { ConfiguracionForm } from "./configuracion-form";
import { SucursalesBodegas } from "./sucursales-bodegas";
import { ConfigOperativa } from "./config-operativa";
import { CamposPersonalizados } from "./campos-personalizados";
import { IntegracionPdv, type EstadoIntegracionPdv } from "./integracion-pdv";
import { Empleados } from "./empleados";

export const dynamic = "force-dynamic";

// Chrome único de las 4 secciones de esta página: "rail" a la izquierda
// con el título + la explicación (ancho fijo, medida legible) y los
// controles a la derecha ocupando TODO el resto del ancho. Es el patrón
// clásico de página de settings, y es lo que resuelve el problema que
// veníamos arrastrando acá: antes la tarjeta era full-width pero el
// contenido cortaba a ~800px, dejando media tarjeta vacía. Ahora el
// ancho sobrante lo consume el rail a propósito, y cada sección
// reorganiza sus controles en más columnas a medida que hay lugar (ver
// los `2xl:grid-cols-*` de cada hijo) en vez de estirar un input solo.
// Debajo de lg el rail se apila arriba y queda todo en una columna.
function Seccion({
  titulo,
  descripcion,
  children,
}: {
  titulo: string;
  descripcion: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-6 lg:p-8">
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div>
          <h2 className="text-sm font-semibold text-ink">{titulo}</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">{descripcion}</p>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

export default async function ConfiguracionPage() {
  const perfil = await requirePerfilAdmin();
  const supabase = await createServerClient();

  // Mismo criterio que las demás páginas de esta app: desestructurar
  // también `error` y tirar si existe, en vez de tratar cualquier falla
  // como si la fila no existiera (ver docs/decisiones.md, auditoría
  // 2026-08-09).
  const { data: empresa, error } = await supabase
    .from("empresas")
    .select(
      "nombre, telefono, email, direccion, ciudad, contacto_emergencia_nombre, contacto_emergencia_telefono, config"
    )
    .eq("id", perfil.empresaId)
    .single();

  if (error) throw new Error(`No se pudo cargar la empresa: ${error.message}`);

  // `config` es jsonb libre — las claves que nos importan pueden no
  // existir todavía (empresa que nunca guardó esta sección), de ahí los
  // fallbacks. Ver actualizar_config_operativa_empresa (RPC) para el
  // shape que se guarda.
  const configRaw = (empresa.config ?? {}) as Record<string, unknown>;
  const semaforoRaw = configRaw.vencimiento_semaforo as
    | { rojo_dias?: number; amarillo_dias?: number; verde_dias?: number }
    | undefined;
  const configOperativa: ConfigOperativaEmpresa = {
    camposRequeridosImportacion: Array.isArray(configRaw.campos_requeridos_importacion)
      ? (configRaw.campos_requeridos_importacion as string[])
      : [],
    vencimientoSemaforo: {
      rojoDias: semaforoRaw?.rojo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.rojoDias,
      amarilloDias: semaforoRaw?.amarillo_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.amarilloDias,
      verdeDias: semaforoRaw?.verde_dias ?? VENCIMIENTO_SEMAFORO_DEFAULT.verdeDias,
    },
  };
  const camposPersonalizados: CampoPersonalizado[] = Array.isArray(configRaw.campos_personalizados)
    ? (configRaw.campos_personalizados as CampoPersonalizado[])
    : [];

  const { data: sucursales, error: errorSucursales } = await supabase
    .from("sucursales")
    .select("id, nombre, direccion, activo")
    .eq("empresa_id", perfil.empresaId)
    .order("nombre");

  if (errorSucursales) throw new Error(`No se pudieron cargar las sucursales: ${errorSucursales.message}`);

  const { data: bodegas, error: errorBodegas } = await supabase
    .from("bodegas")
    .select("id, sucursal_id, nombre, activo")
    .eq("empresa_id", perfil.empresaId)
    .order("nombre");

  if (errorBodegas) throw new Error(`No se pudieron cargar las bodegas: ${errorBodegas.message}`);

  // perfiles_select (20260806000000_tenancy.sql) ya deja leer todos los
  // perfiles de la propia empresa, así que no hace falta filtrar de más
  // ni pasar por la service_role. El email NO se trae: vive en
  // auth.users y solo se puede leer con la Admin API — el panel de
  // superadmin sí lo hace, esta pantalla no lo necesita para listar.
  // Orden por rol y después por nombre: agrupa admin/gerente arriba y
  // deja el pelotón de operarios junto, que es como se lee la lista.
  const { data: perfiles, error: errorPerfiles } = await supabase
    .from("perfiles")
    .select("id, nombre, rol, activo")
    .eq("empresa_id", perfil.empresaId)
    .order("rol")
    .order("nombre");

  if (errorPerfiles) throw new Error(`No se pudieron cargar los empleados: ${errorPerfiles.message}`);

  // Las sucursales asignadas se piden aparte y se cruzan acá, igual que
  // en superadmin/[empresaId]/page.tsx — se manda solo el id y el nombre
  // lo resuelve el componente contra la lista de `sucursales` que ya
  // recibe, sin traer la misma fila dos veces.
  const perfilIds = (perfiles ?? []).map((p) => p.id);
  const { data: perfilesSucursal, error: errorPerfilesSucursal } = perfilIds.length
    ? await supabase.from("perfiles_sucursal").select("perfil_id, sucursal_id").in("perfil_id", perfilIds)
    : { data: [], error: null };

  if (errorPerfilesSucursal)
    throw new Error(`No se pudieron cargar las sucursales del equipo: ${errorPerfilesSucursal.message}`);

  const sucursalIdsPorPerfil = new Map<string, string[]>();
  for (const ps of perfilesSucursal ?? []) {
    const arr = sucursalIdsPorPerfil.get(ps.perfil_id) ?? [];
    arr.push(ps.sucursal_id);
    sucursalIdsPorPerfil.set(ps.perfil_id, arr);
  }

  const empleados = (perfiles ?? []).map((p) => ({
    ...p,
    sucursalIds: sucursalIdsPorPerfil.get(p.id) ?? [],
  }));

  // maybeSingle y no single: la fila de integraciones_pdv recién existe
  // cuando alguien genera el primer código. api_key/api_secret NO se
  // seleccionan — el panel no los necesita para nada (viajan una sola vez,
  // al canjear el código, ver /api/pdvlat/vincular) y así no terminan en
  // el HTML que se manda al browser.
  const { data: integracion, error: errorIntegracion } = await supabase
    .from("integraciones_pdv")
    .select(
      "codigo_invitacion, codigo_expira_at, tenant_id_pdvlat, vinculado_at, sucursal_id, bodega_id"
    )
    .eq("empresa_id", perfil.empresaId)
    .maybeSingle();

  if (errorIntegracion)
    throw new Error(`No se pudo cargar la integración con el punto de venta: ${errorIntegracion.message}`);

  const estadoIntegracion: EstadoIntegracionPdv = {
    vinculado: integracion?.vinculado_at != null,
    tenantIdPdvlat: integracion?.tenant_id_pdvlat ?? null,
    vinculadoAt: integracion?.vinculado_at ?? null,
    codigoInvitacion: integracion?.codigo_invitacion ?? null,
    codigoExpiraAt: integracion?.codigo_expira_at ?? null,
    sucursalId: integracion?.sucursal_id ?? null,
    bodegaId: integracion?.bodega_id ?? null,
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Mi empresa</h1>
      <p className="mb-6 text-sm text-muted">
        Datos de contacto, sucursales, bodegas y equipo de tu empresa. Podés dar de alta operarios vos mismo; para el
        NIT, el país, o un admin/gerente nuevo, pedile al superadmin.
      </p>
      <div className="space-y-6">
        <Seccion
          titulo="Datos de contacto"
          descripcion="Lo que aparece en remitos y reportes, y a quién llamar si pasa algo fuera de horario."
        >
          <ConfiguracionForm empresa={empresa} />
        </Seccion>

        <Seccion
          titulo="Sucursales y bodegas"
          descripcion="Dónde se guarda y se cuenta el stock. Cada bodega pertenece a una sucursal; desactivar una la saca de los conteos nuevos sin tocar el histórico."
        >
          <SucursalesBodegas empresaId={perfil.empresaId} sucursales={sucursales ?? []} bodegas={bodegas ?? []} />
        </Seccion>

        {/* Va después de "Sucursales y bodegas" y no antes: dar de alta un
            operario exige elegirle al menos una sucursal, así que primero
            tiene que existir el lugar y recién después la persona. */}
        <Seccion
          titulo="Empleados"
          descripcion="Quién trabaja en tu empresa. Podés crear operarios (los que hacen los conteos) y elegirles las sucursales; para un admin o gerente nuevo, o para dar de baja a alguien, pedile al superadmin."
        >
          <Empleados empleados={empleados} sucursales={sucursales ?? []} />
        </Seccion>

        <Seccion
          titulo="Configuración operativa"
          descripcion="Umbrales y validaciones que solo afectan a tu empresa — no cambian nada para las demás."
        >
          <ConfigOperativa config={configOperativa} />
        </Seccion>

        <Seccion
          titulo="Campos personalizados"
          descripcion="Tus propios campos: aparecen en la ficha de producto y como columna en la tabla. Por ahora se cargan a mano (todavía no se mapean desde el importador masivo) y solo aceptan texto libre."
        >
          <CamposPersonalizados campos={camposPersonalizados} />
        </Seccion>

        <Seccion
          titulo="Punto de venta"
          descripcion="Conectá tu sistema de caja para que descuente el stock apenas vende, sin esperar al próximo conteo. El catálogo lo sigue mandando Farmacia."
        >
          {/* Se reusan las mismas listas que la sección "Sucursales y
              bodegas" — ya vienen cargadas y el selector solo ofrece las
              activas (el RPC rechaza las inactivas de todas formas). */}
          <IntegracionPdv
            estado={estadoIntegracion}
            sucursales={(sucursales ?? []).filter((s) => s.activo)}
            bodegas={(bodegas ?? []).filter((b) => b.activo)}
          />
        </Seccion>
      </div>
    </div>
  );
}
