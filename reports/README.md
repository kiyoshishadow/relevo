# REPORT-01 — Módulo de reportes y exportación (Relevo)

Router Express autónomo con el catálogo de 16 reportes, consultas SQL
parametrizadas y exportación PDF (PDFKit) y XLSX (ExcelJS). El módulo vive en
`reports/` de la raíz del proyecto (junto a `server/`).
El módulo trae su propio `package.json`: sus dependencias se resuelven desde
`reports/node_modules`.

## Integración con el backend

Instalar e integrar desde la raíz del proyecto.

```js
// server/index.js (montaje del backend)
import { createReportsRouter } from '../reports/index.js';

app.use('/api/reports', createReportsRouter({
  pool,           // pg.Pool de server/db/pool.js (solo lectura para los reportes)
  requireAuth,    // middleware directo de server/middleware/session.js
  requireRole,    // fábrica requireRole(...roles) que devuelve middleware
}));
```

Forma de `requireRole` confirmada en `server/middleware/session.js`
(líneas 103–111): `requireRole(...roles)` devuelve el middleware que valida
`req.user.role`. `requireAuth` es middleware directo (líneas 96–101). El
router los aplica así: `requireAuth, requireRole('admin','reception')`.

## Endpoints

- `GET /api/reports` → `{data:[{slug,name,category,filters}]}` — 16 exactos.
- `GET /api/reports/:slug?from=&to=&technician_id=&brand=&format=json|pdf|xlsx`
  → `format=json` (default): `{data:{report,columns,rows,summary,filters}}`.
  → `format=pdf|xlsx`: binario con `Content-Disposition: attachment; filename="relevo-<slug>_<desde>_<hasta>.<ext>"`.

## Slugs estables (kebab-case)

1. `clientes-registrados`
2. `reparaciones-por-periodo`
3. `ingresos-totales`
4. `terminales-ingresados`
5. `reparaciones-por-tecnico`
6. `reparaciones-por-problema`
7. `terminales-por-marca`
8. `reparaciones-por-cobertura`
9. `historial-reparaciones`
10. `pagos-por-reparacion`
11. `registro-terminales`
12. `prestamos`
13. `ingresos-diarios`
14. `ingresos-semanales`
15. `ingresos-mensuales`
16. `reparaciones-por-estado`

## Filtros

- `from` / `to`: fechas de negocio `AAAA-MM-DD` en **America/El_Salvador**,
  rangos inclusivos (para timestamptz: `>= inicio(día)` y `< inicio(día+1)`;
  para columnas DATE: `>=` y `<=`). Abiertos si se omite uno.
- `technician_id`: entero positivo (id de usuario rol técnico).
- `brand`: igualdad insensible a mayúsculas con la marca del terminal.
- Cada reporte declara en el catálogo qué filtros admite; valores inválidos
  (fechas imposibles, `from > to`, IDs no enteros) → 400
  `{error:{code:'VALIDATION_ERROR',message}}`. Slug desconocido → 404
  `REPORT_NOT_FOUND`. `format` fuera de json/pdf/xlsx → 400.

## Garantías de datos

- Dinero en centavos enteros (`amount_cents`, `total_cents`); las sumas se
  hacen en SQL bigint o como enteros exactos — sin aritmética flotante.
  XLSX numera `centavos/100` con formato `#,##0.00`.
- Sin doble conteo: joins solo 1:1 o con la entidad mutex de la agregación;
  IMEI y universos de conteo cero (estados, técnicos activos) via `LEFT JOIN`.
- Guardia anti-truncación: cada reporte declara `limit` (10 000 para listados;
  4 y 8 para los universos garantizados por el enum: métodos de pago y estados).
  La consulta pide `LIMIT (n+1)`; si hay una fila de más, se rechaza con
  `413 {error:{code:'REPORT_TOO_LARGE', message}}` pidiendo acotar filtros —
  sin PDF/XLSX parcial y sin resumen calculado sobre un subconjunto.
- Nunca se serializan `password_hash`, `tracking_token_hash`, `csrf_token`,
  `idempotency_key`, `request_hash`, ni tablas `sessions`/`audit_log`.
- XLSX: textos iniciados con `=`, `+`, `-`, `@` se escriben como literal de
  texto (celda richText), nunca interpretados como fórmula.
- PDF: carta horizontal, cabecera de tabla repetida en cada página, columnas
  dimensionadas al ancho útil (no se cortan filas horizontalmente), texto con
  recorte por elipsis.

## Comandos

```bash
cd reports
npm install
npm test        # node --test: catálogo, filtros, SQL, exportadores, router HTTP
```

Las pruebas usan un pool falso (no requieren PostgreSQL ni afirman SQL
ejecutado contra base real). Validación con base dedicada: pendiente del
coordinador; configurarla explícitamente al terminar, nunca usar la base
SICIS ni leer `.env` ajeno.

## Pendientes para el coordinador

- Montar el router en el backend real y probar `format=pdf|xlsx` en navegador.
- Confirmar que ningún reporte necesite columnas adicionales del esquema si
  evoluciona (el módulo solo hace `SELECT`; revisar el catálogo y literals).
- Decidir si los reportes deben filtrar también por `client_id` en el futuro
  (propuesto, no implementado).
