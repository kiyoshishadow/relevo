/**
 * Catálogo de los 16 reportes. Slugs kebab-case estables: es el contrato
 * de integración con frontend y backend; no renombrar sin coordinación.
 */
export const CATALOG = [
  {
    slug: 'clientes-registrados',
    name: 'Clientes registrados',
    category: 'Clientes',
    filters: ['from', 'to'],
  },
  {
    slug: 'reparaciones-por-periodo',
    name: 'Reparaciones por período',
    category: 'Reparaciones',
    filters: ['from', 'to'],
  },
  {
    slug: 'ingresos-totales',
    name: 'Ingresos totales',
    category: 'Ingresos',
    filters: ['from', 'to'],
  },
  {
    slug: 'terminales-ingresados',
    name: 'Terminales ingresados',
    category: 'Reparaciones',
    filters: ['from', 'to', 'technician_id', 'brand'],
  },
  {
    slug: 'reparaciones-por-tecnico',
    name: 'Reparaciones por técnico',
    category: 'Reparaciones',
    filters: ['from', 'to', 'technician_id'],
  },
  {
    slug: 'reparaciones-por-problema',
    name: 'Reparaciones por problema',
    category: 'Reparaciones',
    filters: ['from', 'to'],
  },
  {
    slug: 'terminales-por-marca',
    name: 'Terminales por marca',
    category: 'Flota',
    filters: ['from', 'to', 'brand'],
  },
  {
    slug: 'reparaciones-por-cobertura',
    name: 'Reparaciones por cobertura',
    category: 'Reparaciones',
    filters: ['from', 'to'],
  },
  {
    slug: 'historial-reparaciones',
    name: 'Historial de reparaciones',
    category: 'Reparaciones',
    filters: ['from', 'to', 'technician_id'],
  },
  {
    slug: 'pagos-por-reparacion',
    name: 'Pagos por reparación',
    category: 'Ingresos',
    filters: ['from', 'to'],
  },
  {
    slug: 'registro-terminales',
    name: 'Registro de terminales',
    category: 'Flota',
    filters: ['from', 'to', 'brand'],
  },
  {
    slug: 'prestamos',
    name: 'Préstamos de equipos',
    category: 'Préstamos',
    filters: ['from', 'to'],
  },
  {
    slug: 'ingresos-diarios',
    name: 'Ingresos diarios',
    category: 'Ingresos',
    filters: ['from', 'to'],
  },
  {
    slug: 'ingresos-semanales',
    name: 'Ingresos semanales',
    category: 'Ingresos',
    filters: ['from', 'to'],
  },
  {
    slug: 'ingresos-mensuales',
    name: 'Ingresos mensuales',
    category: 'Ingresos',
    filters: ['from', 'to'],
  },
  {
    slug: 'reparaciones-por-estado',
    name: 'Reparaciones por estado',
    category: 'Reparaciones',
    filters: ['from', 'to'],
  },
];

const BY_SLUG = new Map(CATALOG.map((report) => [report.slug, report]));

/** Devuelve la entrada del catálogo o null si el slug es desconocido. */
export function findReportBySlug(slug) {
  return BY_SLUG.get(String(slug ?? '')) ?? null;
}

/** Catálogo en la forma del contrato: {data:[{slug,name,category,filters}]}. */
export function catalogView() {
  return CATALOG.map((report) => ({
    slug: report.slug,
    name: report.name,
    category: report.category,
    filters: report.filters,
  }));
}
