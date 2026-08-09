// Port a TypeScript de normalizar_codigo() (ver
// supabase/migrations/20260806000002_funciones_rpc.sql). Tiene que
// producir EXACTAMENTE el mismo codigo_norm que la función de Postgres,
// porque acá se usa para el match 100% local contra el catálogo bajado a
// IndexedDB (CONTEXTO.md regla 1: apps/conteo funciona sin internet, el
// match es local). El servidor igual vuelve a normalizar todo en
// registrar_escaneos_batch — no se confía en lo que mande el cliente para
// la sincronización — así que un desvío acá afecta el matching offline,
// no la integridad de los datos.
//
// Verificado con los mismos 19 casos que supabase/tests/normalizar_codigo.test.sql
// — ver packages/db/scripts/verificar-normalizar-codigo.ts.
//
// Simplificación consciente respecto a la versión SQL: to_date(...,'YYMMDD')
// de Postgres tiene una regla de "siglo más cercano" para años de 2
// dígitos. Acá se asume siempre 20YY — correcto para vencimientos de
// medicamentos, que nunca están a más de pocos años de la fecha actual.

export interface CodigoNormalizado {
  codigoNorm: string | null;
  lote: string | null;
  vencimiento: string | null; // "YYYY-MM-DD" o null
}

function parseYYMMDD(s: string): string | null {
  const yy = parseInt(s.slice(0, 2), 10);
  const mm = parseInt(s.slice(2, 4), 10);
  const dd = parseInt(s.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const year = 2000 + yy;
  const date = new Date(Date.UTC(year, mm - 1, dd));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== mm - 1 ||
    date.getUTCDate() !== dd
  ) {
    return null; // ej: 31 de febrero
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(mm)}-${pad(dd)}`;
}

function normalizarGtin(gtin: string): string {
  if (gtin.length === 12) {
    return "0" + gtin;
  }
  if (gtin.length === 14) {
    const sinCeros = gtin.replace(/^0+/, "");
    return sinCeros === "" ? "0" : sinCeros;
  }
  return gtin;
}

export function normalizarCodigo(pCodigo: string | null | undefined): CodigoNormalizado {
  const input = (pCodigo ?? "").trim();

  if (input === "") {
    return { codigoNorm: null, lote: null, vencimiento: null };
  }

  let gtin: string | null = null;
  let lote: string | null = null;
  let vencimiento: string | null = null;

  if (input.includes("(01)")) {
    // GS1 legible: (01)GTIN(17)AAMMDD(10)LOTE, en cualquier orden/subset.
    const m01 = input.match(/\(01\)(\d{14})/);
    if (m01) gtin = m01[1];

    const m17 = input.match(/\(17\)(\d{6})/);
    if (m17) vencimiento = parseYYMMDD(m17[1]);

    const m10 = input.match(/\(10\)([^(]+)/);
    if (m10) lote = m10[1].trimEnd();
  } else if (/^01\d{14}/.test(input)) {
    // GS1-128 crudo (sin paréntesis): AIs concatenados, orden 01 → 17 → 10.
    gtin = input.substring(2, 16);
    let resto = input.substring(16).split(String.fromCharCode(29)).join("|");

    if (/^17\d{6}/.test(resto)) {
      vencimiento = parseYYMMDD(resto.substring(2, 8));
      resto = resto.substring(8).replace(/^\|+/, "");
    }

    if (resto.startsWith("10")) {
      lote = resto.substring(2).split("|")[0];
    }
  } else {
    // Código numérico simple: EAN-13, UPC-A o GTIN-14 sin AIs.
    gtin = input.replace(/\D/g, "");
  }

  if (!gtin) {
    return { codigoNorm: null, lote, vencimiento };
  }

  return { codigoNorm: normalizarGtin(gtin), lote, vencimiento };
}
