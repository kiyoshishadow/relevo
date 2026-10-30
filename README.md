# Relevo

Sistema para la gestión de reparación de terminales: recepción de equipos, seguimiento de casos, clientes, coberturas, préstamos y reportes.

## Requisitos

- Node.js 24 y npm.
- PostgreSQL dedicado para la aplicación.

## Instalación local

```sh
npm ci --include=dev
npm --prefix reports ci --include=dev
npm --prefix frontend ci --include=dev
npm run db:migrate
npm run build
npm start
```

Antes de ejecutar las migraciones o el servidor, configure `DATABASE_URL` con la conexión PostgreSQL de la instalación. Consulte `.env.example` para las demás opciones. Los archivos locales de credenciales no deben subirse al repositorio.

En una base nueva y migrada, cree el primer administrador ejecutando `npm run db:bootstrap-admin` con `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_FULL_NAME` y `BOOTSTRAP_ADMIN_PASSWORD` establecidos de forma privada en el entorno. El comando rechaza bases que ya contienen usuarios y no crea cuentas de demostración. Retire las variables de bootstrap después de usarlo.

El comando `db:seed` está destinado exclusivamente a bases de demostración desechables y puede borrar datos existentes. No lo use en producción.

## Publicación en Render y Neon

`render.yaml` define un servicio web gratuito que instala dependencias, construye la interfaz y aplica las migraciones antes de iniciar. Render solicita `DATABASE_URL` durante la creación; use la conexión directa TLS de Neon para la base dedicada. Mantenga el valor como secreto en Render. El servicio entrega la interfaz y la API bajo el mismo origen, y `/api/health` comprueba la conexión a PostgreSQL.

El procesamiento automático de notificaciones está desactivado en la configuración de ejemplo. Configure un proveedor SMTP antes de activar envíos externos. El modo local no entrega correo a destinatarios externos.

## Comprobaciones

```sh
npm test
npm run test:reports
npm --prefix frontend test
npm run build
```

Las pruebas de API con base de datos requieren una base de pruebas independiente: pueden reiniciar sus tablas y no deben apuntar a la base de desarrollo ni a producción.
