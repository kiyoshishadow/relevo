/**
 * Exportación PDF con PDFKit: carta horizontal, paginado con cabeceras de
 * tabla repetidas en cada página, columnas dimensionadas al ancho disponible
 * (la tabla nunca se corta horizontalmente) y encabezado con título, fecha
 * de generación y filtros aplicados.
 */
import PDFDocument from 'pdfkit';
import { cellText, fmtDateTime, TZ } from '../format.js';

const MARGIN = 36;
const LINE_HEIGHT = 10;
const CELL_PADDING = 3;
const MAX_LINES = 3;
const FONT_REGULAR = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

function measureWrap(doc, text, width, maxLines = MAX_LINES) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean === '') return [''];
  const tokens = [];
  for (const word of clean.split(' ')) {
    if (doc.widthOfString(word, { width }) <= width) {
      tokens.push(word);
      continue;
    }
    let piece = '';
    for (const char of word) {
      if (piece !== '' && doc.widthOfString(piece + char) > width) {
        tokens.push(piece);
        piece = char;
      } else {
        piece += char;
      }
    }
    if (piece !== '') tokens.push(piece);
  }
  const lines = [];
  let line = '';
  for (const token of tokens) {
    const candidate = line === '' ? token : `${line} ${token}`;
    if (doc.widthOfString(candidate) <= width) {
      line = candidate;
    } else {
      if (line !== '') lines.push(line);
      line = token;
    }
  }
  if (line !== '') lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (doc.widthOfString(`${last}…`) > width && last.length > 1) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

function computeColumnWidths(doc, columns, rows, tableWidth) {
  const weights = columns.map((column) => {
    const lens = [column.label.length, 4];
    for (const row of rows.slice(0, 200)) {
      const text = cellText(row[column.key], column.type);
      lens.push(Math.min(text.length, 40));
    }
    const weight = Math.max(...lens) + 6;
    return column.type === 'text' ? weight : weight * 0.75;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) =>
    Math.max((tableWidth * weight) / total, 38),
  );
  // Reescala en caso de topes mínimos.
  const widthTotal = widths.reduce((sum, width) => sum + width, 0);
  return widths.map((width) => (width * tableWidth) / widthTotal);
}

export function renderPdf({ title, filtersApplied, columns, rows, generatedAt = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'letter',
      layout: 'landscape',
      margin: MARGIN,
      info: { Title: title, Author: 'Relevo - Equipo 02' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // Encabezado del documento.
      doc.font(FONT_BOLD).fontSize(14).fillColor('#111827').text(title, MARGIN, MARGIN);
      doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#4b5563');
      doc.text(
        `Generado: ${fmtDateTime(generatedAt)} (America/El_Salvador)`,
        MARGIN,
        doc.y + 4,
      );
      const filterEntries = Object.entries(filtersApplied ?? {});
      const filterText =
        filterEntries.length === 0
          ? 'Sin filtros'
          : filterEntries
              .map(([key, value]) => {
                const labels = {
                  from: 'Desde',
                  to: 'Hasta',
                  technician_id: 'Técnico',
                  brand: 'Marca',
                };
                return `${labels[key] ?? key}: ${cellText(value, key.endsWith('id') ? 'integer' : key === 'from' || key === 'to' ? 'date' : 'text')}`;
              })
              .join(' \u00b7 ');
      doc.text(`Filtros: ${filterText}`, MARGIN, doc.y + 2);
      doc.text(
        `Registros: ${rows.length} \u00b7 Moneda: USD`,
        MARGIN,
        doc.y + 2,
      );

      const yStart = doc.y + 14;
      const tableWidth = doc.page.width - MARGIN * 2;
      doc.fontSize(7.5);
      const columnWidths = computeColumnWidths(doc, columns, rows, tableWidth);
      const maxY = doc.page.height - MARGIN;

      const drawHeaderRow = (y) => {
        doc.font(FONT_BOLD).fontSize(7.5).fillColor('#111827');
        let height = CELL_PADDING * 2 + LINE_HEIGHT;
        const cellLines = columns.map((column, index) => {
          const lines = measureWrap(doc, column.label, columnWidths[index] - CELL_PADDING * 2);
          height = Math.max(height, CELL_PADDING * 2 + lines.length * LINE_HEIGHT);
          return lines;
        });
        if (y + height > maxY) throw new Error('PAGE_NEEDED');
        doc.rect(MARGIN, y, tableWidth, height).fill('#e5e7eb');
        let x = MARGIN;
        columns.forEach((_column, index) => {
          doc.fillColor('#111827');
          cellLines[index].forEach((line, lineIndex) => {
            doc.text(line, x + CELL_PADDING, y + CELL_PADDING + lineIndex * LINE_HEIGHT,
              { width: columnWidths[index] - CELL_PADDING * 2, lineBreak: false });
          });
          x += columnWidths[index];
        });
        doc.rect(MARGIN, y, tableWidth, height).lineWidth(0.5).strokeColor('#9ca3af').stroke();
        return y + height;
      };

      let y = drawHeaderRow(yStart);
      doc.font(FONT_REGULAR);

      rows.forEach((row, rowIndex) => {
        const alternate = rowIndex % 2 === 1;
        doc.font(FONT_REGULAR).fontSize(7.5);
        let height = CELL_PADDING * 2 + LINE_HEIGHT;
        const cellLines = columns.map((column, index) => {
          const text = cellText(row[column.key], column.type);
          const lines = measureWrap(doc, text, columnWidths[index] - CELL_PADDING * 2);
          height = Math.max(height, CELL_PADDING * 2 + lines.length * LINE_HEIGHT);
          return lines;
        });

        if (y + height > maxY) {
          doc.addPage({ size: 'letter', layout: 'landscape', margin: MARGIN });
          doc.font(FONT_REGULAR).fontSize(7.5);
          y = drawHeaderRow(MARGIN);
          doc.font(FONT_REGULAR);
        }

        if (alternate) {
          doc.rect(MARGIN, y, tableWidth, height).fill('#f3f4f6');
        }
        let x = MARGIN;
        columns.forEach((column, index) => {
          doc.fillColor('#374151');
          cellLines[index].forEach((line, lineIndex) => {
            doc.text(line, x + CELL_PADDING, y + CELL_PADDING + lineIndex * LINE_HEIGHT,
              { width: columnWidths[index] - CELL_PADDING * 2, lineBreak: false });
          });
          x += columnWidths[index];
        });
        doc.lineWidth(0.3).strokeColor('#d1d5db')
          .moveTo(MARGIN, y + height)
          .lineTo(MARGIN + tableWidth, y + height)
          .stroke();
        y += height;
      });

      doc.end();
    } catch (error) {
      doc.end();
      reject(error);
    }
  });
}

export { TZ };
