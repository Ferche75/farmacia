import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { ResumenConteo, ResultadoComparativo } from "@farmacia/db";

// jspdf-autotable (API funcional, ver lib/exportar-resumen.ts) setea
// doc.lastAutoTable como efecto de lado de dibujar la tabla — no hay un
// método público doc.getLastAutoTable() en esta forma de uso (esa es la
// API antigua basada en applyPlugin, que acá no se llama). Confirmado
// leyendo node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.mjs
// en vez de asumirlo.
function obtenerFinalY(doc: jsPDF): number | undefined {
  return (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;
}

function filaResumen(resumen: ResumenConteo) {
  return [
    ["Unidades totales", resumen.unidades_totales],
    ["SKU distintos contados", resumen.skus_distintos],
    ["SKU del catálogo no encontrados", resumen.skus_catalogo_no_encontrados],
    ["Valor a costo (Bs)", resumen.valor_costo],
    ["Valor a precio (Bs)", resumen.valor_precio],
    ["Margen teórico (Bs)", resumen.margen_teorico],
    ["Desconocidos detectados en este conteo", resumen.desconocidos_detectados_este_conteo],
    ["Desconocidos pendientes (este conteo)", resumen.desconocidos_pendientes_este_conteo],
    ["Desconocidos resueltos por IA (este conteo)", resumen.desconocidos_resueltos_ia_este_conteo],
    ["Desconocidos resueltos manualmente (este conteo)", resumen.desconocidos_resueltos_manual_este_conteo],
    ["Desconocidos — total empresa (histórico)", resumen.desconocidos_empresa_total],
    ["Desconocidos — resueltos por IA (empresa, histórico)", resumen.desconocidos_empresa_resueltos_ia],
    ["Desconocidos — resueltos manualmente (empresa, histórico)", resumen.desconocidos_empresa_resueltos_manual],
    ["Desconocidos — pendientes empresa", resumen.desconocidos_empresa_pendientes],
    ...(resumen.tiene_vencimientos
      ? [
          ["Productos con vencimiento < 90 días", resumen.vencimientos_menos_90_dias],
          ["Productos con vencimiento < 180 días", resumen.vencimientos_menos_180_dias],
        ]
      : []),
  ];
}

export function exportarExcel(
  resumen: ResumenConteo,
  comparativo: ResultadoComparativo | null,
  nombreConteo: string
) {
  const wb = XLSX.utils.book_new();

  const wsResumen = XLSX.utils.aoa_to_sheet([
    ["Resumen gerencial", nombreConteo],
    [],
    ...filaResumen(resumen),
  ]);
  XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");

  const wsTop20 = XLSX.utils.json_to_sheet(
    resumen.top_20_valor_inmovilizado.map((p) => ({
      Producto: p.nombre,
      Cantidad: p.cantidad,
      "Valor a costo (Bs)": p.valor_costo,
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsTop20, "Top 20 valor inmovilizado");

  const wsProductividad = XLSX.utils.json_to_sheet(
    resumen.productividad_por_operario.map((p) => ({
      Usuario: p.usuario_id,
      Escaneos: p.escaneos,
      "Escaneos por hora": p.escaneos_por_hora,
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsProductividad, "Productividad");

  if (comparativo) {
    const filasComparativo: (string | number)[][] = [];
    if (comparativo.anterior_misma_sucursal) {
      const a = comparativo.anterior_misma_sucursal;
      filasComparativo.push(["Conteo anterior (misma sucursal)", a.nombre]);
      filasComparativo.push(["Unidades", a.unidades_totales]);
      filasComparativo.push(["Valor a precio (Bs)", a.valor_precio]);
      filasComparativo.push([]);
    }
    for (const s of comparativo.otras_sucursales) {
      filasComparativo.push([s.sucursal_nombre, s.conteo_nombre, s.unidades_totales]);
    }
    if (filasComparativo.length > 0) {
      const wsComparativo = XLSX.utils.aoa_to_sheet(filasComparativo);
      XLSX.utils.book_append_sheet(wb, wsComparativo, "Comparativo");
    }
  }

  XLSX.writeFile(wb, `resumen-${nombreConteo.replace(/[^a-z0-9]+/gi, "-")}.xlsx`);
}

export function exportarPdf(
  resumen: ResumenConteo,
  comparativo: ResultadoComparativo | null,
  nombreConteo: string
) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text(`Resumen gerencial — ${nombreConteo}`, 14, 18);
  doc.setFontSize(10);
  doc.text(new Date().toLocaleString("es-BO"), 14, 24);

  autoTable(doc, {
    startY: 30,
    head: [["Métrica", "Valor"]],
    body: filaResumen(resumen).map(([k, v]) => [String(k), String(v)]),
    styles: { fontSize: 9 },
  });

  const finalY1 = obtenerFinalY(doc) ?? 30;

  autoTable(doc, {
    startY: finalY1 + 10,
    head: [["Top 20 por valor inmovilizado", "Cantidad", "Valor a costo (Bs)"]],
    body: resumen.top_20_valor_inmovilizado.map((p) => [
      p.nombre,
      String(p.cantidad),
      p.valor_costo.toFixed(2),
    ]),
    styles: { fontSize: 9 },
  });

  if (comparativo && (comparativo.anterior_misma_sucursal || comparativo.otras_sucursales.length > 0)) {
    const finalY2 = obtenerFinalY(doc) ?? finalY1 + 10;
    const filas: string[][] = [];
    if (comparativo.anterior_misma_sucursal) {
      filas.push([
        "Conteo anterior (misma sucursal)",
        comparativo.anterior_misma_sucursal.nombre,
        String(comparativo.anterior_misma_sucursal.unidades_totales),
      ]);
    }
    for (const s of comparativo.otras_sucursales) {
      filas.push([s.sucursal_nombre, s.conteo_nombre, String(s.unidades_totales)]);
    }
    autoTable(doc, {
      startY: finalY2 + 10,
      head: [["Comparativo", "Conteo", "Unidades"]],
      body: filas,
      styles: { fontSize: 9 },
    });
  }

  doc.save(`resumen-${nombreConteo.replace(/[^a-z0-9]+/gi, "-")}.pdf`);
}
