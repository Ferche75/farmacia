import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { FilaImportacion } from "@farmacia/db";
import type { MapeoColumnas } from "./campos-sistema";

export interface ArchivoParseado {
  headers: string[];
  filas: Record<string, string>[];
}

function parseCsv(file: File): Promise<ArchivoParseado> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      worker: true,
      complete: (result) => resolve({ headers: result.meta.fields ?? [], filas: result.data }),
      error: (err: Error) => reject(err),
    });
  });
}

async function parseXlsx(file: File): Promise<ArchivoParseado> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const filasCrudas = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
  });

  if (filasCrudas.length === 0) {
    return { headers: [], filas: [] };
  }

  const headers = filasCrudas[0].map((h) => String(h ?? "").trim());
  const filas = filasCrudas.slice(1).map((fila) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      const valor = fila[i];
      obj[h] = valor === undefined || valor === null ? "" : String(valor);
    });
    return obj;
  });

  return { headers, filas };
}

/** CSV se parsea en un Web Worker (papaparse `worker: true`). XLSX no —
 * para 20.000 filas x ~10 columnas el parseo síncrono de SheetJS es de
 * un par de segundos, no llega a colgar el navegador en la práctica. Si
 * en el futuro hace falta, mover a un Worker propio. */
export async function parseArchivo(file: File): Promise<ArchivoParseado> {
  const nombre = file.name.toLowerCase();
  if (nombre.endsWith(".csv")) return parseCsv(file);
  if (nombre.endsWith(".xlsx") || nombre.endsWith(".xls")) return parseXlsx(file);
  throw new Error("Formato no soportado. Subí un archivo .csv o .xlsx.");
}

/** Varios archivos reales traen "cantidad" y "unidad" combinados en una
 * sola columna de texto libre (ej. "100 COMP", "1 TUBO X 10 G") en vez de
 * separados. Extrae el número inicial como contenido y el resto como
 * unidad. Si no encuentra un número al principio, deja todo en unidad. */
function parseCantidadUnidad(valor: string): { numero: string; resto: string } {
  const match = valor.trim().match(/^([\d.,]+)\s*(.*)$/);
  if (!match) return { numero: "", resto: valor.trim() };
  return { numero: match[1].replace(",", "."), resto: match[2].trim() };
}

/** margenPorcentaje: si una fila trae costo pero no precio, calcula
 * precio = costo * (1 + margen/100) — para archivos que solo traen costo
 * (listas de proveedor sin precio de venta definido). Opcional; sin
 * margen, una fila sin precio mapeado simplemente queda sin precio. */
export function aplicarMapeo(
  filas: Record<string, string>[],
  mapeo: MapeoColumnas,
  margenPorcentaje?: number
): FilaImportacion[] {
  // "Contenido" y "Unidad" mapeados a la MISMA columna del archivo es la
  // señal de que esa columna trae ambos combinados en texto libre — se
  // parsea una sola vez por fila en vez de leerla dos veces tal cual.
  const cantidadCombinada = !!mapeo.contenido && mapeo.contenido === mapeo.unidad;

  return filas.map((fila) => {
    let contenido = mapeo.contenido ? fila[mapeo.contenido] : undefined;
    let unidad = mapeo.unidad ? fila[mapeo.unidad] : undefined;

    if (cantidadCombinada && contenido) {
      const { numero, resto } = parseCantidadUnidad(contenido);
      contenido = numero;
      unidad = resto;
    }

    const costo = mapeo.costo ? fila[mapeo.costo] : undefined;
    let precio = mapeo.precio ? fila[mapeo.precio] : undefined;

    if (!precio && costo && margenPorcentaje) {
      const costoNum = Number(String(costo).replace(",", "."));
      if (!Number.isNaN(costoNum)) {
        precio = (costoNum * (1 + margenPorcentaje / 100)).toFixed(2);
      }
    }

    return {
      codigoBarra: (mapeo.codigoBarra ? fila[mapeo.codigoBarra] : "") ?? "",
      nombre: mapeo.nombre ? fila[mapeo.nombre] : undefined,
      concentracion: mapeo.concentracion ? fila[mapeo.concentracion] : undefined,
      contenido,
      unidad,
      forma: mapeo.forma ? fila[mapeo.forma] : undefined,
      principioActivo: mapeo.principioActivo ? fila[mapeo.principioActivo] : undefined,
      categoria: mapeo.categoria ? fila[mapeo.categoria] : undefined,
      codigoProveedor: mapeo.codigoProveedor ? fila[mapeo.codigoProveedor] : undefined,
      laboratorio: mapeo.laboratorio ? fila[mapeo.laboratorio] : undefined,
      costo,
      precio,
    };
  });
}

export function trocear<T>(items: T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) {
    lotes.push(items.slice(i, i + tamano));
  }
  return lotes;
}
