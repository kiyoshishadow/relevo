/**
 * REPORT-01 - Router de reportes de Relevo.
 *
 * Integración (backend Express):
 *   import { createReportsRouter } from '../reports/index.js';
 *   app.use('/api/reports', createReportsRouter({ pool, requireAuth, requireRole }));
 *
 * - GET /        -> {data:[{slug,name,category,filters}]} con 16 exactos.
 * - GET /:slug   -> {data:{report,columns,rows,summary,filters}}.
 * - GET /:slug?format=pdf|xlsx -> descarga binaria.
 * Autenticación y roles vienen inyectados: requireAuth es middleware directo
 * y requireRole es fábrica requireRole('admin','reception') => middleware.
 */
import { Router } from 'express';
import { catalogView, findReportBySlug } from './catalog.js';
import { ApiError, asyncHandler, reportsErrorMiddleware } from './errors.js';
import { parseFilters } from './filters.js';
import { runReport } from './run.js';
import { renderPdf } from './exporters/pdf.js';
import { renderXlsx } from './exporters/xlsx.js';
import { cellText, fmtDateTime } from './format.js';

const FORMAT_EXTENSIONS = { pdf: 'pdf', xlsx: 'xlsx' };

function contentDispositionFilename(slug, filters, extension) {
  const desde = filters.from ?? 'inicio';
  const hasta = filters.to ?? 'actual';
  return `relevo-${slug}_${desde}_${hasta}.${extension}`;
}

function filterLabels(key) {
  return { from: 'Desde', to: 'Hasta', technician_id: 'Técnico', brand: 'Marca' }[key] ?? key;
}

function filterType(key) {
  if (key === 'from' || key === 'to') return 'date';
  if (key === 'technician_id') return 'integer';
  return 'text';
}

export function createReportsRouter({ pool, requireAuth, requireRole }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createReportsRouter: se requiere un pool de PostgreSQL con .query()');
  }
  if (typeof requireAuth !== 'function') {
    throw new Error('createReportsRouter: requireAuth debe ser un middleware (function (req,res,next))');
  }
  if (typeof requireRole !== 'function') {
    throw new Error(
      "createReportsRouter: requireRole debe ser una fábrica requireRole(...roles) que devuelve middleware",
    );
  }

  const router = Router();
  const guard = [requireAuth, requireRole('admin', 'reception')];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (_req, res) => {
      res.json({ data: catalogView() });
    }),
  );

  router.get(
    '/:slug',
    ...guard,
    asyncHandler(async (req, res) => {
      const entry = findReportBySlug(req.params.slug);
      if (!entry) {
        throw new ApiError(404, 'REPORT_NOT_FOUND', 'Reporte no encontrado');
      }

      const format = req.query.format === undefined
        ? 'json'
        : String(req.query.format).trim().toLowerCase();
      if (format !== 'json' && !FORMAT_EXTENSIONS[format]) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'Parámetro format inválido: use json, pdf o xlsx',
        );
      }

      // Valida y normaliza solo los filtros permitidos para este reporte.
      const filters = parseFilters(entry, req.query);
      const data = await runReport(entry, filters, pool);

      if (format === 'json') {
        return res.json({ data });
      }

      const generatedAt = new Date();
      const subtitleLines = [
        `Generado: ${fmtDateTime(generatedAt)} (America/El_Salvador)`,
        `Filtros: ${
          Object.entries(filters).length === 0
            ? 'Sin filtros'
            : Object.entries(filters)
                .map(([key, value]) => `${filterLabels(key)}: ${cellText(value, filterType(key))}`)
                .join(' \u00b7 ')
        }`,
      ];
      const extension = FORMAT_EXTENSIONS[format];
      const filename = contentDispositionFilename(entry.slug, filters, extension);
      const buffer =
        format === 'pdf'
          ? await renderPdf({
              title: entry.name,
              filtersApplied: filters,
              columns: data.columns,
              rows: data.rows,
              generatedAt,
            })
          : await renderXlsx({
              title: entry.name,
              filtersApplied: filters,
              columns: data.columns,
              rows: data.rows,
              generatedAt,
            });

      res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.setHeader('Content-Length', String(buffer.length));
      return res.send(buffer);
    }),
  );

  router.use(reportsErrorMiddleware);

  return router;
}
