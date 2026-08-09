// Simula 500 escaneos seguidos contra IndexedDB real (fake-indexeddb en
// Node, misma librería Dexie que usa el navegador) y mide tiempos —
// exactamente lo que pide el prompt de Fase 3: "Probalo simulando 500
// escaneos seguidos y mostrame los tiempos."
//
// Correr con: node --experimental-strip-types scripts/medir-rendimiento-escaneo.ts

import "fake-indexeddb/auto";
import { db } from "../lib/db.ts";
import { procesarEscaneo } from "../lib/motor-escaneo.ts";

const N_PRODUCTOS_CATALOGO = 12_000;
const N_ESCANEOS = 500;
const CONTEO_ID = "conteo-test";

function codigoDe(i: number): string {
  return String(7_800_000_000_000 + i).padStart(13, "0");
}

async function main() {
  console.log(`Sembrando catálogo local con ${N_PRODUCTOS_CATALOGO} productos…`);
  const productos = Array.from({ length: N_PRODUCTOS_CATALOGO }, (_, i) => ({
    codigoNorm: codigoDe(i),
    productoId: `prod-${i}`,
    nombre: `Producto Demo ${i}`,
    laboratorio: `Lab ${i % 25}`,
    concentracion: "500 mg",
    forma: "comprimidos",
    contenido: 20,
    unidad: "comprimidos",
  }));
  await db.catalogo.bulkPut(productos);

  await db.meta.put({
    id: "actual",
    conteoId: CONTEO_ID,
    sucursalId: "sucursal-test",
    nombre: "Conteo de prueba",
    catalogoListo: true,
    catalogoDescargadoAt: Date.now(),
    catalogoTotal: N_PRODUCTOS_CATALOGO,
  });

  // 500 escaneos: 90% códigos que existen (aleatorios, sin repetir
  // consecutivo para no pisar el debounce de 400ms), 10% que no existen
  // (para medir también el camino "no encontrado").
  const codigos: string[] = [];
  let ultimoIndex = -1;
  for (let i = 0; i < N_ESCANEOS; i++) {
    if (i % 10 === 9) {
      codigos.push(`9999999${String(i).padStart(6, "0")}`); // no existe
      continue;
    }
    let idx = Math.floor(Math.random() * N_PRODUCTOS_CATALOGO);
    if (idx === ultimoIndex) idx = (idx + 1) % N_PRODUCTOS_CATALOGO;
    ultimoIndex = idx;
    codigos.push(codigoDe(idx));
  }

  console.log(`Disparando ${N_ESCANEOS} escaneos secuenciales…`);
  const tiempos: number[] = [];
  let encontrados = 0;
  let noEncontrados = 0;

  for (const codigo of codigos) {
    const t0 = performance.now();
    const resultado = await procesarEscaneo({
      conteoId: CONTEO_ID,
      codigoRaw: codigo,
      saltarDebounce: true, // simula lecturas ~cada 50-100ms reales, no ráfaga instantánea
    });
    const t1 = performance.now();
    tiempos.push(t1 - t0);

    if (resultado.tipo === "encontrado") encontrados++;
    else if (resultado.tipo === "no_encontrado") noEncontrados++;
  }

  tiempos.sort((a, b) => a - b);
  const suma = tiempos.reduce((a, b) => a + b, 0);
  const promedio = suma / tiempos.length;
  const p50 = tiempos[Math.floor(tiempos.length * 0.5)];
  const p95 = tiempos[Math.floor(tiempos.length * 0.95)];
  const p99 = tiempos[Math.floor(tiempos.length * 0.99)];
  const max = tiempos[tiempos.length - 1];
  const sobre100ms = tiempos.filter((t) => t > 100).length;

  const totalPendientes = await db.colaEscaneos
    .where("conteoId")
    .equals(CONTEO_ID)
    .filter((e) => e.sincronizado === 0)
    .count();

  console.log("");
  console.log(`Resultados (${N_ESCANEOS} escaneos, catálogo de ${N_PRODUCTOS_CATALOGO} productos):`);
  console.log(`  encontrados: ${encontrados}, no encontrados: ${noEncontrados}`);
  console.log(`  promedio: ${promedio.toFixed(2)} ms`);
  console.log(`  p50: ${p50.toFixed(2)} ms`);
  console.log(`  p95: ${p95.toFixed(2)} ms`);
  console.log(`  p99: ${p99.toFixed(2)} ms`);
  console.log(`  max: ${max.toFixed(2)} ms`);
  console.log(`  escaneos que superaron 100ms: ${sobre100ms} de ${N_ESCANEOS}`);
  console.log(`  cola de sincronización pendiente: ${totalPendientes} (correcto: = encontrados)`);

  if (sobre100ms > 0) {
    console.error("\nFALLÓ: hay escaneos por encima del presupuesto de 100ms del spec.");
    process.exit(1);
  }
  console.log("\nOK: los 500 escaneos quedaron por debajo de 100ms.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
