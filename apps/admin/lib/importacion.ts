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

export function aplicarMapeo(
  filas: Record<string, string>[],
  mapeo: MapeoColumnas
): FilaImportacion[] {
  return filas.map((fila) => ({
    codigoBarra: (mapeo.codigoBarra ? fila[mapeo.codigoBarra] : "") ?? "",
    nombre: mapeo.nombre ? fila[mapeo.nombre] : undefined,
    concentracion: mapeo.concentracion ? fila[mapeo.concentracion] : undefined,
    contenido: mapeo.contenido ? fila[mapeo.contenido] : undefined,
    unidad: mapeo.unidad ? fila[mapeo.unidad] : undefined,
    forma: mapeo.forma ? fila[mapeo.forma] : undefined,
    costo: mapeo.costo ? fila[mapeo.costo] : undefined,
    precio: mapeo.precio ? fila[mapeo.precio] : undefined,
  }));
}

export function trocear<T>(items: T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) {
    lotes.push(items.slice(i, i + tamano));
  }
  return lotes;
}
