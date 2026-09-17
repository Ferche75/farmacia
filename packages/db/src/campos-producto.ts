// Vocabulario compartido de PRESENTACIÓN y CONCENTRACIÓN de un producto.
//
// POR QUÉ VIVE ACÁ Y NO EN CADA APP: hasta este archivo había DOS arrays
// `UNIDADES_PRESENTACION` distintos, copiados a mano —uno en
// apps/admin/app/(app)/productos/productos-abm.tsx y otro en
// apps/conteo/lib/campos-producto.ts— y se desincronizaron: el de
// apps/admin creció a 21 valores y el de apps/conteo se quedó en los 7
// originales. Consecuencia real: el mismo producto ofrecía opciones
// distintas según por qué pantalla se lo cargara, y una presentación
// elegida en el panel no existía en el selector del dispositivo. Ahora hay
// UNA sola definición y las dos apps la importan de `@farmacia/db`.
//
// CONVENCIÓN DE LA LISTA (heredada de productos-abm.tsx, no cambiarla):
// minúsculas, sin acentos, y el valor se muestra TAL CUAL como etiqueta
// del <option>. Por eso "tableta efervescente" y "polvo para suspension"
// van con espacios y no con guión bajo: se persisten igual que se leen.
//
// LOS 7 VALORES ORIGINALES (comprimidos, capsulas, ml, g, unidades,
// sobres, ampollas) SIGUEN ESCRITOS EXACTAMENTE IGUAL y no se renombran
// nunca: hay productos guardados con esos strings, y además son el
// vocabulario que emite el prompt de Gemini en
// n8n/flujo-desconocidos-ia.json. La lista es hoy un SUPERCONJUNTO de ese
// prompt — lo que sugiere la IA sigue cayendo siempre en una opción real
// del selector, y las presentaciones nuevas simplemente no las sugiere la
// IA todavía (se eligen a mano).
//
// El orden es el del selector: se agrupan por familia (sólidos orales,
// líquidos, inyectables, tópicos, …) y los tres genéricos de medida
// —ml / g / unidades— quedan al final como último recurso. Las entradas
// que ya existían conservan su posición relativa: agregar una fila acá no
// le mueve el piso a nadie.
export const UNIDADES_PRESENTACION = [
  "comprimidos",
  "capsulas",
  "tabletas",
  "tableta efervescente",
  "jarabe",
  "suspension",
  "polvo para suspension",
  "suero",
  "tonico",
  "ampollas",
  "vial",
  "gotas",
  "gotero",
  "frasco",
  "sobres",
  "polvos",
  "gel",
  "crema",
  "pomada",
  "unguento",
  "locion",
  "aceite",
  "parches",
  "supositorios",
  "ovulos",
  "ml",
  "g",
  "unidades",
];

// Unidades de CONCENTRACIÓN (cuánto principio activo trae cada unidad),
// distinto de la presentación de arriba. Ordenadas por frecuencia: mg y ml
// cubren la enorme mayoría.
//
// `gr` (gramos) y `ui` (unidades internacionales) se suman para los casos
// que la lista de 4 no cubría: polvos/sueros que se dosifican en gramos, y
// los viales de reconstitución (heparinas, vitaminas, hormonas) que se
// rotulan en UI y no en masa.
//
// `kg` y `lt` NO están, y es una decisión explícita del usuario, no un
// olvido: lo que viene en kilos se carga en gramos y lo que viene en
// litros se carga en mililitros. Dos unidades más para el mismo dato solo
// abrirían la puerta a que el mismo producto se cargue con escalas
// distintas según quién lo toque.
export const UNIDADES_CONCENTRACION = ["mg", "ml", "mcg", "%", "gr", "ui"];

/** Qué campos extra tiene sentido pedir según la presentación. Vive en el
 * código y no en la base a propósito: es criterio de FORMULARIO (qué se le
 * muestra a quien carga), no un dato de negocio que una empresa necesite
 * editar — si algún día lo necesita, recién ahí se mueve a empresas.config. */
export interface CamposPresentacion {
  /** Se puede vender la caja entera, el blíster/bandeja suelto o la unidad
   * individual. Habilita el bloque de precios por nivel del ABM. */
  fraccionable?: boolean;
  /** El envase (o cada unidad del envase) tiene contenido líquido: el
   * campo `contenido` se rotula en mililitros. */
  contenidoEnMl?: boolean;
}

// Una presentación que no esté en el mapa (las de texto libre del "Otro…",
// y todas las que no figuran acá) cae en el objeto vacío: el formulario
// queda como si el mapa no existiera.
//
// "tableta efervescente" queda AFUERA del fraccionamiento a propósito
// (pedido explícito del usuario): viene en tubo, no en blíster.
//
// AMPOLLAS Y VIAL LLEVAN LAS DOS BANDERAS JUNTAS, y son los únicos. Una
// caja de ampollas se vende entera, por bandeja o por ampolla suelta (de
// ahí `fraccionable`), y ADEMÁS cada ampolla tiene su propio contenido
// líquido o su polvo a reconstituir (de ahí `contenidoEnMl`, y de ahí que
// `gr`/`ui` se hayan sumado a UNIDADES_CONCENTRACION). Ojo con la tensión
// que eso deja en el campo `contenido` del ABM: cuando el producto está
// marcado como fraccionable, `contenido` pasa a ser el DERIVADO
// (bandejas × ampollas) y por lo tanto se mide en unidades, no en ml — los
// mililitros de cada ampolla se cargan en `concentracion`. El rótulo del
// campo respeta esa precedencia (ver productos-abm.tsx).
export const CAMPOS_POR_PRESENTACION: Record<string, CamposPresentacion> = {
  comprimidos: { fraccionable: true },
  capsulas: { fraccionable: true },
  tabletas: { fraccionable: true },
  supositorios: { fraccionable: true },
  ovulos: { fraccionable: true },
  jarabe: { contenidoEnMl: true },
  suspension: { contenidoEnMl: true },
  ampollas: { fraccionable: true, contenidoEnMl: true },
  vial: { fraccionable: true, contenidoEnMl: true },
};

export function camposDePresentacion(unidad: string): CamposPresentacion {
  return CAMPOS_POR_PRESENTACION[unidad] ?? {};
}

/** true si la presentación guardada no es ninguna de las de la lista, o
 * sea que se cargó por el "Otro…" de texto libre. */
export function esUnidadPersonalizada(unidad: string): boolean {
  return unidad !== "" && !UNIDADES_PRESENTACION.includes(unidad);
}
