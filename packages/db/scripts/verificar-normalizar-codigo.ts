// Verifica que el port a TypeScript de normalizar_codigo (src/normalizar-codigo.ts)
// da EXACTAMENTE los mismos resultados que la versión SQL, con los mismos
// 19 casos de supabase/tests/normalizar_codigo.test.sql.
//
// Correr con: node --experimental-strip-types scripts/verificar-normalizar-codigo.ts
// (Node 22+, sin dependencias nuevas — el port es TS sin sintaxis que
// --experimental-strip-types no pueda pelar: solo tipos y interfaces.)

import { normalizarCodigo } from "../src/normalizar-codigo.ts";

interface Caso {
  descripcion: string;
  input: string | null;
  esperadoNorm: string | null;
  esperadoLote: string | null;
  esperadoVenc: string | null;
}

const casos: Caso[] = [
  { descripcion: "EAN-13 plano", input: "7501234567892", esperadoNorm: "7501234567892", esperadoLote: null, esperadoVenc: null },
  { descripcion: "EAN-13 con guiones/espacios", input: " 750-1234567892 ", esperadoNorm: "7501234567892", esperadoLote: null, esperadoVenc: null },
  { descripcion: "UPC-A simple", input: "036000291452", esperadoNorm: "0036000291452", esperadoLote: null, esperadoVenc: null },
  { descripcion: "UPC-A que ya arranca en 0", input: "003600029145", esperadoNorm: "0003600029145", esperadoLote: null, esperadoVenc: null },
  { descripcion: "GTIN-14 con un cero adelante (matchea el EAN-13 de arriba)", input: "07501234567892", esperadoNorm: "7501234567892", esperadoLote: null, esperadoVenc: null },
  { descripcion: "GTIN-14 con varios ceros adelante", input: "00001234567890", esperadoNorm: "1234567890", esperadoLote: null, esperadoVenc: null },
  { descripcion: "GTIN-14 todo ceros (caso límite)", input: "00000000000000", esperadoNorm: "0", esperadoLote: null, esperadoVenc: null },
  { descripcion: "EAN-8 plano, sin tocar", input: "12345670", esperadoNorm: "12345670", esperadoLote: null, esperadoVenc: null },
  { descripcion: "String vacío", input: "", esperadoNorm: null, esperadoLote: null, esperadoVenc: null },
  { descripcion: "Solo espacios", input: "   ", esperadoNorm: null, esperadoLote: null, esperadoVenc: null },
  { descripcion: "NULL", input: null, esperadoNorm: null, esperadoLote: null, esperadoVenc: null },
  { descripcion: "Solo letras, sin dígitos", input: "ABCDEF", esperadoNorm: null, esperadoLote: null, esperadoVenc: null },
  { descripcion: "DataMatrix 01+17+10 completo", input: "(01)07501234567892(17)251231(10)LOTE123", esperadoNorm: "7501234567892", esperadoLote: "LOTE123", esperadoVenc: "2025-12-31" },
  { descripcion: "DataMatrix 01+10+17, orden distinto, GTIN con varios ceros", input: "(01)00001234567890(10)ABC-99(17)260101", esperadoNorm: "1234567890", esperadoLote: "ABC-99", esperadoVenc: "2026-01-01" },
  { descripcion: "DataMatrix solo 01+10, sin vencimiento", input: "(01)00360002914523(10)L1", esperadoNorm: "360002914523", esperadoLote: "L1", esperadoVenc: null },
  { descripcion: "DataMatrix solo 01+17, sin lote", input: "(01)12345678901234(17)260630", esperadoNorm: "12345678901234", esperadoLote: null, esperadoVenc: "2026-06-30" },
  { descripcion: "DataMatrix con GTIN inválido (no 14 dígitos) pero 17 sí parsea", input: "(01)1234567890(17)260101", esperadoNorm: null, esperadoLote: null, esperadoVenc: "2026-01-01" },
  { descripcion: "GS1-128 crudo 01+17+10 sin separador", input: "01" + "00360002914523" + "17" + "260731" + "10" + "LOTE7", esperadoNorm: "360002914523", esperadoLote: "LOTE7", esperadoVenc: "2026-07-31" },
  { descripcion: "GS1-128 crudo, solo 01", input: "01" + "12345678901234", esperadoNorm: "12345678901234", esperadoLote: null, esperadoVenc: null },
];

let fallos = 0;

for (const caso of casos) {
  const resultado = normalizarCodigo(caso.input);
  const ok =
    resultado.codigoNorm === caso.esperadoNorm &&
    resultado.lote === caso.esperadoLote &&
    resultado.vencimiento === caso.esperadoVenc;

  if (!ok) {
    fallos++;
    console.warn(
      `FALLÓ [${caso.descripcion}] input=${JSON.stringify(caso.input)} → obtenido=${JSON.stringify(resultado)} esperado=${JSON.stringify({
        codigoNorm: caso.esperadoNorm,
        lote: caso.esperadoLote,
        vencimiento: caso.esperadoVenc,
      })}`
    );
  }
}

if (fallos > 0) {
  console.error(`${fallos} de ${casos.length} casos fallaron.`);
  process.exit(1);
}

console.log(`OK: ${casos.length} de ${casos.length} casos pasaron (paridad con la versión SQL confirmada).`);
