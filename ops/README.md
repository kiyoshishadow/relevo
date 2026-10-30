# Operación: respaldo, verificación y restauración

Scripts Node ESM **sin dependencias** para respaldar PostgreSQL en formato custom,
verificar la integridad del archivo, restaurar únicamente en bases aisladas y
aplicar retención de **7 copias diarias y 4 semanales**.

> Estado OPS-01: scripts y pruebas unitarias listos (20 tests). Se ejecutó una
> restauración real del respaldo QA (`sha256 7709d203…`, 185 TOC) en la base
> aislada `relevo_restore`: 18 tablas y conteos/hashes del snapshot verificados.
> La corrida completa con exit 0 en una base **nueva** queda pendiente porque el
> destino ya está poblado y no se sobrescribe.

## Requisitos

- Node.js 24 o superior (`node --version`).
- Herramientas cliente de PostgreSQL 18 (o compatible): `pg_dump`, `pg_restore`
  y `psql`. En esta máquina están en
  `C:\Program Files\PostgreSQL\18\bin`.
- Permisos de lectura sobre la base de origen y de escritura en la carpeta de
  respaldos.
- No hace falta `npm install` para estos scripts: no usan dependencias externas.

Configure `PG_BIN` si las herramientas no están en `PATH`. El script también
busca instalaciones bajo `C:\Program Files\PostgreSQL\<versión>\bin`.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `DATABASE_URL` | Sí, para respaldar y restaurar | Base de origen. También actúa como origen que la restauración debe rechazar. |
| `RESTORE_DATABASE_URL` | Solo para restaurar | Base aislada de destino. Debe empezar por `relevo_restore` o `relevo_test`. |
| `PG_BIN` | No | Carpeta `bin` de PostgreSQL. |
| `BACKUP_DIR` | No | Carpeta raíz de respaldos. Por defecto `ops/backups`. |
| `PGPASSFILE` | No | Archivo de contraseñas de libpq si la URL no incluye contraseña. |

Los scripts **no leen archivos `.env`**. Configure las variables en la sesión de
PowerShell, en el entorno del usuario/servicio que ejecuta la tarea o use
`PGPASSFILE`. No guarde contraseñas en el repositorio ni en el manifiesto.

Ejemplo de sesión (sin datos reales):

```powershell
$env:PG_BIN = 'C:\Program Files\PostgreSQL\18\bin'
$env:BACKUP_DIR = 'D:\RelevoBackups'
$env:DATABASE_URL = 'postgresql://usuario:<contraseña>@localhost:5432/relevo'
```

La URL admite `?sslmode=require`, `connect_timeout`, `application_name`, etc.
No se admiten sockets locales ni contraseñas en la cadena de consulta. La
contraseña va en la parte de usuario de la URL o en `PGPASSFILE`.

## Instalar un entorno nuevo

1. Clonar el repositorio y entrar en la raíz.
2. Verificar Node 24 y PostgreSQL:
   ```powershell
   node --version
   & "$env:PG_BIN\pg_dump.exe" --version
   & "$env:PG_BIN\psql.exe" --version
   ```
3. Crear una base dedicada del proyecto y un usuario de aplicación. **No usar la
   base de SICIS ni copiar sus datos.**
4. Cuando BACK-01 haya entregado `package.json` y `scripts/`, instalar y aplicar
   migraciones/semilla con los nombres exactos que publique ese módulo:
   ```powershell
   npm install
   # Consultar package.json antes de ejecutar; los nombres definitivos no se
   # inventan en OPS-01. Ejemplos habituales, sujetos al contrato de BACK-01:
   npm run migrate
   npm run seed
   ```
   Ejecutar migraciones y semilla solo contra la base nueva del proyecto. La
   semilla no debe usarse sobre datos reales.
5. Definir `DATABASE_URL`, `PG_BIN` y `BACKUP_DIR` en el entorno del operador o
   del servicio.
6. Ejecutar `node ops/backup.mjs` una vez y verificar el par `.dump` +
   `.manifest.json` antes de programar nada.

## Respaldo

```powershell
node ops/backup.mjs
```

El comando:

1. Ejecuta `pg_dump --format=custom` con argumentos (`spawn`, sin shell).
2. Guarda primero un archivo temporal y lo renombra al finalizar.
3. Verifica el archivo con `pg_restore --list`.
4. Calcula SHA-256 y tamaño, y escribe el manifiesto JSON con fecha UTC,
   comando redactado y resultado de la verificación.
5. Crea una copia semanal automática los **domingos UTC** (o con `--weekly`).
6. Aplica retención: 7 diarias y 4 semanales.

Opciones:

```text
--output-dir <ruta>   Reemplaza BACKUP_DIR.
--weekly             Fuerza la copia semanal.
--no-prune           No aplica retención en esta ejecución.
--help               Ayuda.
```

Estructura resultante:

```text
<BACKUP_DIR>/
  daily/relevo_20261027T201500123Z.dump
  daily/relevo_20261027T201500123Z.manifest.json
  weekly/relevo_20261027T201500123Z.dump
  weekly/relevo_20261027T201500123Z.manifest.json
```

El manifiesto incluye `schemaVersion`, `kind`, `createdAt`/`completedAt` en UTC,
host/puerto/base (sin usuario ni contraseña), ruta relativa del dump, tamaño,
`sha256`, comando redactado, versión de `pg_dump` y verificación TOC.

En producción, `BACKUP_DIR` debe estar **fuera del equipo de PostgreSQL y del
repositorio**, con control de acceso y respaldo/almacenamiento protegido. El
valor por defecto `ops/backups` es solo para desarrollo y está ignorado por Git.

## Verificación

```powershell
node ops/verify.mjs --dump "D:\RelevoBackups\daily\relevo_20261027T201500123Z.dump"
```

Busca el manifiesto hermano, comprueba tamaño y SHA-256, y valida que
`pg_restore --list` pueda leer el archivo. Use `--manifest <ruta>` para indicar
otro manifiesto. Si el manifiesto no existe, informa que solo verificó el
archivo. Código de salida 5 si la verificación falla.

## Restauración aislada

La restauración **solo** se permite en bases cuyo nombre empiece por
`relevo_restore` o `relevo_test` (con sufijo opcional `_[a-z0-9]+`). Además:

- Rechaza la misma base de origen (host, puerto y nombre).
- Rechaza `postgres`, `template0`, `template1`, la base de la aplicación y
  cualquier otro nombre.
- Exige que el destino esté **vacío** (sin relaciones ni esquemas de usuario).
  No borra, no hace `DROP`, no usa `--clean`.
- Restaura con `--single-transaction --exit-on-error`; si falla, la transacción
  revierte. Pasa a `pg_restore` un `--dbname <nombre_destino>` explícito:
  `PGDATABASE` por sí solo no basta, porque `pg_restore` exige `-d/--dbname` o
  `-f/--file` al leer un archivo. La contraseña sigue yendo por entorno, nunca
  por argv.
- Exige manifiesto y verificación previa del archivo.

Pasos:

```powershell
# 1. Crear una base aislada nueva. Introduzca la contraseña cuando se solicite.
& "$env:PG_BIN\createdb.exe" -h localhost -p 5432 -U postgres relevo_restore_ops01

# 2. Definir origen y destino.
$env:DATABASE_URL = 'postgresql://usuario:<contraseña>@localhost:5432/relevo'
$env:RESTORE_DATABASE_URL = 'postgresql://usuario:<contraseña>@localhost:5432/relevo_restore_ops01'

# 3. Restaurar y comprobar tablas clave cuando el backend las tenga.
node ops/restore.mjs --dump "D:\RelevoBackups\daily\relevo_20261027T201500123Z.dump" `
  --expect-table cases --expect-table payments
```

`--expect-table` es repetible y acepta `tabla` o `esquema.tabla`. Si falta una
tabla, el comando termina con código 7 y deja los datos en la base aislada para
inspección; no intenta borrarlos.

Para repetir una restauración hay que crear **otra** base aislada. El script
nunca elimina ni vacía una base existente.

### Evidencia QA de restauración

Se restauró el dump `relevo_20261028T023720141Z.dump` (74 120 B, 185 TOC,
SHA-256 `7709d2033b5d9ae482267c2e901bdd6f4689ebcb88a4f57b9b45701e1b639303`) en
`relevo_restore`. El preflight confirmó la base vacía (`0` relaciones y `0`
esquemas de usuario), `pg_restore` terminó con código 0 y quedaron 18 tablas.
Los conteos/hashes de `cases` (7), `payments` (1), `coverages` (4) y `loans` (2)
coinciden con el snapshot previo del origen. Una segunda ejecución sobre el
destino ya poblado devolvió exit 6 y no lo sobrescribió. El origen
`relevo_dev` siguió recibiendo datos después del respaldo; por eso su estado
actual no debe compararse directamente con el snapshot.

La primera ejecución reveló que `pg_restore` exige `--dbname` explícito y que la
comprobación posterior debía incluir el esquema `public`. Ambos defectos están
corregidos y cubiertos por pruebas.

## Retención manual

```powershell
node ops/prune.mjs --dry-run   # ver qué se eliminaría
node ops/prune.mjs             # aplicar 7 diarias / 4 semanales
```

Solo elimina pares `.dump` + `.manifest.json` que sigan el formato gestionado.
Archivos desconocidos, `.partial-*`, manifiestos sin dump y dumps sin manifiesto
se conservan y se informan. El respaldo recién creado queda protegido aunque el
reloj del sistema esté desfasado.

## Programación diaria (opt-in, requiere revisión)

**OPS-01 no instaló ninguna tarea.** La programación real es opt-in y debe
revisarla el coordinador antes de registrarla. No guarde la contraseña en el
repositorio ni en el XML de la tarea.

Recomendación: usar una cuenta de servicio con permisos mínimos, definir
`DATABASE_URL` (o `PGPASSFILE`), `PG_BIN` y `BACKUP_DIR` en el entorno de esa
cuenta, y registrar una tarea diaria con la acción:

```text
Programa:   C:\Program Files\nodejs\node.exe
Argumentos: "C:\ruta\al\repositorio\ops\backup.mjs"
Iniciar en: C:\ruta\al\repositorio
```

Pasos en Task Scheduler (interfaz gráfica, revisar antes de guardar):

1. Crear tarea básica → diariamente → hora local deseada (p. ej. 02:30).
2. Acción: iniciar un programa con los valores de la tabla anterior.
3. En «General», elegir la cuenta de servicio y marcar «Ejecutar tanto si el
   usuario inició sesión como si no».
4. En «Condiciones», desmarcar suspensión si el equipo puede hibernar; en
   «Configuración», permitir ejecutar aunque se pierda el inicio y definir un
   tiempo máximo razonable.
5. Guardar con la contraseña de la cuenta, ejecutar una vez a mano y revisar el
   código de salida y los archivos generados.

Task Scheduler hereda las variables de usuario/sistema de la cuenta; no ponga
`DATABASE_URL` ni contraseñas en el campo de argumentos. Si usa `PGPASSFILE`,
restrinja sus permisos a esa cuenta.

Referencia equivalente para `cmd.exe` (no ejecutar sin revisión; los `\"` son
para la línea de comandos de Windows):

```bat
schtasks /Create /TN "Relevo\BackupDiario" /SC DAILY /ST 02:30 /RU "<cuenta-de-servicio>" /RP * /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\ruta\al\repositorio\ops\backup.mjs\""
```

La hora de la tarea es local; los nombres de archivo y las fechas del manifiesto
son UTC. La copia semanal se genera cuando la ejecución cae en domingo UTC
(o si se pasa `--weekly`). Configure el equipo para que no suspenda la tarea,
revise el código de salida y pruebe primero una ejecución manual.

Comprobación posterior (también requiere revisión):

```powershell
schtasks /Query /TN "Relevo\BackupDiario" /V /FO LIST
```

## Códigos de salida

| Código | Significado |
|---:|---|
| 0 | Éxito |
| 1 | Error inesperado no clasificado |
| 2 | Argumentos de uso incorrectos |
| 3 | Configuración/entorno o binario faltante |
| 4 | Fallo de `pg_dump` o de escritura del respaldo |
| 5 | Verificación de archivo/manifiesto fallida |
| 6 | Guarda de restauración rechazó el destino |
| 7 | Fallo de restauración o comprobación posterior |
| 8 | Fallo de retención |
| 9 | No se pudo inspeccionar/conectar al destino |

## Seguridad

- No se leen `.env` externos, no se usa `shell: true`, no se interpola texto en
  comandos y los argumentos se pasan como vector a `spawn`.
- La contraseña se pasa por entorno al proceso hijo y se elimina de mensajes,
  manifiestos y logs. El manifiesto guarda un comando redactado.
- Los archivos se escriben con modo `0600` cuando el sistema lo permite.
- Los respaldos contienen datos personales: proteja la carpeta, cifre el medio si
  corresponde y no los adjunte al repositorio ni a evidencias académicas.
- No se toca SICIS ni se restauran bases ajenas.

## Pruebas

```powershell
node --test "ops/test/*.test.mjs"
```

Cubren guards de nombres/URLs, redacción de secretos, identidad origen/destino,
argumentos de `pg_restore` (`--dbname` obligatorio), preflight/lista de tablas de
`public`, manifiestos/SHA-256, retención, archivos huérfanos, dry-run y códigos de
salida sin conexión. No requieren PostgreSQL ni red.

## Pendientes de integración

- Repetir la corrida completa con exit 0 en una base nueva `relevo_restore_*` o
  `relevo_test_*`; `relevo_restore` quedó poblado y no se sobrescribe.
- Comparar contra el origen actual solo con una ventana sin escrituras o un dump
  nuevo coherente; el origen es una base viva.
- Revisar y, solo entonces, registrar la tarea diaria.
- Alinear los comandos de migración/semilla con `package.json` y `scripts/**`
  de BACK-01 cuando estén integrados.
