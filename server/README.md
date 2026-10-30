# Relevo — Backend (BACK-01)

API JSON del sistema de reparación de terminales Relevo, construida con Node.js ESM, Express 5 y PostgreSQL. Implementa autenticación con sesiones persistentes, CSRF, roles, reglas de negocio, transacciones, idempotencia, auditoría y una bandeja de notificaciones (outbox).

## Requisitos

- Node.js 20.11 o superior. Verificado con Node.js 24.18.1.
- PostgreSQL 16 o superior. Verificado con PostgreSQL 18.
- Una base de datos **nueva y dedicada** al proyecto. Nunca use la base de SICIS.

## Instalación y arranque

```powershell
npm install

# Exporte las variables en el proceso. Este backend NO lee archivos .env.
$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/relevo_dev"
$env:PORT = "3000"

npm run db:setup   # migraciones + datos sintéticos
npm start
```

`npm run db:setup` ejecuta las migraciones y luego el seed. El seed trunca las tablas del proyecto y vuelve a crearlas con datos sintéticos; úselo solo en una base de demostración.

Comandos disponibles:

| Comando | Uso |
| --- | --- |
| `npm start` | Inicia la API. |
| `npm run dev` | Inicia con `--watch`. |
| `npm run db:migrate` | Aplica migraciones pendientes. |
| `npm run db:seed` | Carga datos sintéticos (truncando el esquema del proyecto). |
| `npm run db:setup` | Migraciones + seed. |
| `npm run notifications:drain` | Procesa una vez la bandeja de notificaciones. |
| `npm test` | Pruebas unitarias de dominio (sin base de datos). |
| `npm run test:integration` | Pruebas de API con base de datos de prueba. |
| `npm run test:all` | Unitarias + integración. |

## Configuración

La referencia completa está en `.env.example`. Las variables se leen de `process.env`; no se cargan archivos `.env` externos.

Variables principales:

- `DATABASE_URL` (obligatoria): cadena de conexión PostgreSQL del proyecto.
- `PORT`, `HOST`, `TRUST_PROXY`.
- `COOKIE_NAME`, `COOKIE_SECURE`, `SESSION_TTL_MINUTES`, `DATABASE_POOL_MAX`.
- `CORS_ORIGINS`: orígenes separados por coma. Vacío desactiva CORS.
- `LOGIN_RATE_LIMIT`, `LOGIN_RATE_WINDOW_MINUTES`, `TRACK_RATE_LIMIT`, `TRACK_RATE_WINDOW_MINUTES`.
- `NOTIFICATIONS_MODE=local|smtp`, `NOTIFICATIONS_AUTO_PROCESS`, `NOTIFICATIONS_INTERVAL_MS`,
  `NOTIFICATIONS_FROM`, `NOTIFICATIONS_LOCAL_FILE`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
  (solo con `NOTIFICATIONS_MODE=smtp`).
- `SEED_DEMO_PASSWORD`, `ALLOW_SEED`.

### Sesiones y CSRF

1. `GET /api/auth/csrf` crea una sesión anónima en PostgreSQL, devuelve `data.csrfToken` y fija la cookie HttpOnly `relevo_session`.
2. Envíe la cookie y el encabezado `X-CSRF-Token` en todo `POST`, `PATCH`, `PUT` o `DELETE` autenticado.
3. `POST /api/auth/login` rota el token CSRF y lo devuelve junto con el usuario.
4. `POST /api/auth/logout` elimina la sesión en la base de datos.

`POST /api/track` es la única mutación pública: no exige CSRF porque usa el token secreto del caso y está limitada por IP.

### Roles

- `admin`: administración general, usuarios, auditoría, procesamiento de notificaciones.
- `reception`: clientes, terminales, coberturas, casos, cotizaciones, pagos y préstamos.
- `technician`: solo casos asignados; diagnóstico, acciones y transiciones permitidas.

La autorización por rol y por asignación se comprueba en el servidor.

## Endpoints

Todas las respuestas de éxito usan `{data: ...}` y los listados añaden `{meta:{total,page,pageSize}}`. Los errores usan `{error:{code,message,details?}}`.

| Método | Ruta | Notas |
| --- | --- | --- |
| GET | `/api/health` | Estado y conectividad de la base. |
| GET | `/api/auth/csrf` | Crea/recupera sesión y token CSRF. |
| POST | `/api/auth/login` | Inicio de sesión. |
| GET | `/api/auth/me` | Usuario y CSRF actuales. |
| POST | `/api/auth/logout` | Cierra la sesión. |
| GET/POST | `/api/clients` | Búsqueda, filtros y alta. |
| PATCH | `/api/clients/:id` | Edición y baja lógica con `active`. |
| GET/POST | `/api/terminals` | Terminales con IMEI 14–16 dígitos, máximo dos. |
| GET/POST | `/api/coverages` | Coberturas configurables. |
| PATCH | `/api/coverages/:id` | Edición de cobertura. |
| GET/POST | `/api/cases` | Listado por rol y alta de caso. |
| GET | `/api/cases/:id` | Detalle interno completo. |
| PATCH | `/api/cases/:id` | Extensión: reasignar `technician_id` (admin/recepción). |
| POST | `/api/cases/:id/diagnosis` | Diagnóstico y evaluación de cobertura. |
| POST | `/api/cases/:id/transition` | Transición validada por la máquina de estados. |
| POST | `/api/cases/:id/actions` | Acciones y repuestos. |
| POST | `/api/cases/:id/quote` | Cotización versionada. |
| POST | `/api/cases/:id/quote/decision` | Aceptar o rechazar cotización. |
| POST | `/api/cases/:id/payments` | Pago con `idempotency_key`. |
| GET/POST | `/api/loan-devices` | Equipos de préstamo. |
| POST | `/api/cases/:id/loan` | Asigna un préstamo activo. |
| POST | `/api/cases/:id/loan/return` | Devuelve el préstamo. |
| POST | `/api/cases/:id/replacement` | Reemplazo con política `new` o `continue`. |
| POST | `/api/track` | Consulta pública con número y token. |
| GET | `/api/dashboard` | Conteos, casos recientes, ingresos y préstamos activos. |
| GET/POST | `/api/users` | Solo administración. |
| PATCH | `/api/users/:id` | Roles, estado y contraseña; protege al último admin. |
| GET | `/api/audit` | Solo administración. |
| GET | `/api/notifications` | Bandeja outbox para admin/recepción. |
| POST | `/api/notifications/process` | Extensión: procesa la cola (solo admin). |

### Reglas de negocio relevantes

- La cobertura se evalúa con la fecha de negocio de `America/El_Salvador`, no con UTC.
- Un caso cubierto puede pasar de `diagnosing` a `repairing`.
- Un caso fuera de cobertura exige una cotización aceptada y el pago completo antes de `repairing`.
- `delivered` exige `ready` y que no exista un préstamo activo.
- Un caso `cancelled` no se reabre; uno `delivered` no admite cambios.
- Los IMEI son únicos por terminal y globalmente, con un máximo de dos por terminal.
- Los pagos se guardan en centavos enteros, se serializan como cadenas decimales y usan claves de idempotencia únicas.
- Los préstamos tienen índices únicos parciales: un préstamo activo por caso y por equipo.
- Las notificaciones se encolan en la misma transacción que la acción de negocio.

## Datos sintéticos

Contraseña demo: `RelevoDemo2026!`

| Correo | Rol |
| --- | --- |
| `admin@relevo.test` | admin |
| `recepcion@relevo.test` | reception |
| `tecnico@relevo.test` | technician |
| `tecnico2@relevo.test` | technician |

El seed imprime los números de caso y sus tokens de seguimiento. Todos los datos son ficticios. El seed se bloquea con `NODE_ENV=production` salvo `ALLOW_SEED=1`, y rechaza bases cuyo nombre contenga `sicis`.

## Notificaciones

El outbox funciona en dos modos:

- `local` (predeterminado): imprime cada mensaje como JSON en consola y, si se define `NOTIFICATIONS_LOCAL_FILE`, lo agrega como JSONL. **No equivale a correo entregado.**
- `smtp`: envía por SMTP con las variables `SMTP_*`.

Con `NOTIFICATIONS_AUTO_PROCESS=true` el proceso de API ejecuta un despachador periódico. También puede procesarse a demanda con `npm run notifications:drain` o `POST /api/notifications/process`. La cola usa `FOR UPDATE SKIP LOCKED`, reintentos con retroceso y estado `failed` tras cinco intentos.

## Pruebas

```powershell
npm test
```

Ejecuta `server/test/domain.test.js` con `node --test` (15 pruebas): fecha de negocio y límites de cobertura, reglas de estados, dinero, tokens, paginación y configuración.

La integración necesita una base de prueba cuyo nombre contenga `test`:

```powershell
$env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:55439/relevo_test"
$env:TEST_PORT = "3102"   # cualquier puerto libre; no use el 3001 del coordinador
npm run test:integration
```

La suite crea el esquema, trunca solo esa base y recorre autenticación, permisos, cobertura, pagos, idempotencia, préstamos, portal público, reemplazos, auditoría y usuarios. El puerto predeterminado de la suite es `3102`; si está ocupado, elija otro con `TEST_PORT`. Si no se define `TEST_DATABASE_URL`, la prueba se marca como omitida.

## Integración de reportes (REPORT-01)

Este módulo no implementa reportes exportables. `createApp` acepta un router externo:

```js
import { createApp } from './server/app.js';
import { createReportsRouter } from './reports/index.js';

const app = createApp({
  reportsRouter: createReportsRouter({ pool, requireAuth, requireRole }),
});
```

El router se monta en `/api/reports`, después de la autenticación. `requireAuth` y `requireRole` se exportan desde `server/middleware/session.js`.

## Limitaciones conocidas

- No incluye `GET /api/reports` ni exportaciones PDF/XLSX; pertenecen a REPORT-01.
- Los limitadores de tasa son en memoria y por instancia; para varias instancias se requiere un almacén compartido.
- No hay integración con pasarela de pagos: solo se registran pagos.
- El envío local de notificaciones no demuestra entrega externa.
- Este backend no carga archivos `.env`; las variables deben exportarse en el proceso.
