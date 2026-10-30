/**
 * Exportación XLSX con ExcelJS.
 * - Los valores de dinero van como números decimales (centavos/100) con
 *   formato '#,##0.00'; nunca se recalculan sumas de flotantes.
 * - Protección contra inyección de fórmulas: todo texto que inicia con
 *   =, +, - o @ se escribe como texto literal (celda richText),
 *   no como fórmula ni con contenido alterado.
 * - Incluye hoja de datos con título, fecha de generación y filtros.
 */
import ExcelJS from 'exceljs';
import { cellText, TZ } from '../format.js';

const INJECTION_PREFIX = /^[=+\-@\t\r]/;

function sanitizeSheetName(name) {
  return String(name).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Reporte';
}

function toNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function renderXlsx({
  title,
  filtersApplied,
  columns,
  rows,
  generatedAt = new Date(),
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Relevo - Equipo 02';
  workbook.created = new Date(generatedAt.getTime());
  const sheet = workbook.addWorksheet(sanitizeSheetName(title), {
    views: [{ state: 'frozen', ySplit: 6 }],
  });

  // Bloque de metadatos: título, generación, filtros, registros.
  sheet.mergeCells(1, 1, 1, Math.max(columns.length, 4));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = String(title);
  titleCell.font = { bold: true, size: 14 };

  const generatedCell = sheet.getCell(2, 1);
  generatedCell.value = `Generado: ${new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(generatedAt.getTime()))} (America/El_Salvador)`;

  const filterEntries = Object.entries(filtersApplied ?? {});
  const filterLabels = {
    from: 'Desde',
    to: 'Hasta',
    technician_id: 'Técnico',
    brand: 'Marca',
  };
  const filterText =
    filterEntries.length === 0
      ? 'Filtros: Sin filtros'
      : `Filtros: ${filterEntries
          .map(([key, value]) => `${filterLabels[key] ?? key}: ${cellText(value, key === 'from' || key === 'to' ? 'date' : 'text')}`)
          .join(' \u00b7 ')}`;
  const filtersCell = sheet.getCell(3, 1);
  filtersCell.value = filterText;
  if (/^=/.test(filterText)) {
    filtersCell.value = { richText: [{ text: filterText }] };
  }

  sheet.getCell(4, 1).value = `Registros: ${rows.length} \u00b7 Moneda: USD`;

  // Cabecera de tabla (fila 6).
  const headerRow = sheet.getRow(6);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    let width = column.label.length + 4;
    for (const row of rows.slice(0, 200)) {
      width = Math.max(width, Math.min(cellText(row[column.key], column.type).length + 2, 40));
    }
    sheet.getColumn(index + 1).width = Math.min(width, 42);
  });
  headerRow.height = 20;

  rows.forEach((row, rowIndex) => {
    const sheetRow = sheet.getRow(7 + rowIndex);
    columns.forEach((column, index) => {
      const raw = row[column.key];
      const cell = sheetRow.getCell(index + 1);
      switch (column.type) {
        case 'cents': {
          const number = toNumber(raw);
          cell.value = number === null ? '' : number / 100;
          cell.numFmt = '#,##0.00';
          break;
        }
        case 'integer': {
          cell.value = raw === null ? '' : toNumber(raw);
          break;
        }
        case 'datetime': {
          if (raw === null) cell.value = '';
          else {
            cell.value = new Date(raw);
            cell.numFmt = 'dd/mm/yyyy hh:mm';
          }
          break;
        }
        case 'date': {
          cell.value = raw === null ? '' : cellText(raw, 'date');
          break;
        }
        case 'boolean': {
          cell.value = raw === null ? '' : raw ? 'Sí' : 'No';
          break;
        }
        default: {
          const text = raw === null ? '' : String(raw);
          if (INJECTION_PREFIX.test(text)) {
            // Texto literal: richText evita que Excel o cualquier conversor
            // posterior interprete el contenido como fórmula.
            cell.value = { richText: [{ text }] };
            cell.alignment = { vertical: 'top' };
          } else {
            cell.value = text;
          }
          break;
        }
      }
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** True si el texto requiere protección de fórmula (=, +, -, @). */
export function needsFormulaGuard(text) {
  return INJECTION_PREFIX.test(String(text ?? ''));
}
