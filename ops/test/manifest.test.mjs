import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDatabaseUrl } from '../lib/database-url.mjs';
import {
  assertManifestMatchesDump,
  buildManifest,
  validateManifest,
  verifyManifestAndFile,
} from '../lib/manifest.mjs';
import { buildBackupFileName, sha256File } from '../lib/paths.mjs';
import { countTocEntries } from '../lib/verify.mjs';

const CONNECTION = parseDatabaseUrl('postgresql://equipo:S3cr3t!@localhost:5432/relevo');

test('sha256File calcula el hash conocido de abc', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relevo-sha-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'abc.txt');
  await writeFile(file, 'abc');
  assert.equal(
    await sha256File(file),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('buildManifest redacta el comando y valida hash/tamaño', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relevo-manifest-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const createdAt = new Date('2026-10-27T20:15:00.123Z');
  const dumpPath = path.join(root, 'daily', buildBackupFileName(createdAt));
  await mkdir(path.dirname(dumpPath), { recursive: true });
  await writeFile(dumpPath, 'abc');
  const bytes = 3;
  const sha256 = await sha256File(dumpPath);

  const manifest = buildManifest({
    kind: 'daily',
    createdAt,
    completedAt: new Date('2026-10-27T20:15:10.000Z'),
    connection: CONNECTION,
    root,
    dumpPath,
    bytes,
    sha256,
    commandBinary: 'C:/Program Files/PostgreSQL/18/bin/pg_dump.exe',
    commandArgs: [
      '--file',
      dumpPath,
      '--dbname',
      'postgresql://equipo:S3cr3t!@localhost:5432/relevo',
    ],
    pgDumpVersion: 'pg_dump (PostgreSQL) 18.0',
    verification: { tocEntries: 12, checkedAt: new Date('2026-10-27T20:15:05.000Z') },
  });

  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('S3cr3t!'), false);
  assert.equal(serialized.includes('equipo:'), false);
  assert.equal(manifest.command[0], 'pg_dump.exe');
  assert.equal(manifest.command[2], '<backup-root>/daily/relevo_20261027T201500123Z.dump');
  assert.equal(manifest.dump.bytes, bytes);
  assert.equal(manifest.dump.sha256, sha256);
  assert.doesNotThrow(() => validateManifest(manifest, { bytes, sha256 }));
  assert.doesNotThrow(() => assertManifestMatchesDump(manifest, dumpPath));

  assert.throws(
    () => validateManifest(manifest, { bytes: bytes + 1, sha256 }),
    /tamaño/,
  );
  assert.throws(
    () => validateManifest(manifest, { bytes, sha256: '0'.repeat(64) }),
    /SHA-256/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, schemaVersion: 99 }),
    /versión/,
  );
  assert.throws(
    () => validateManifest({
      ...manifest,
      command: ['pg_dump', 'postgresql://equipo:S3cr3t!@localhost/relevo'],
    }),
    /credenciales sin redactar/,
  );
  assert.throws(
    () => validateManifest({
      ...manifest,
      dump: { ...manifest.dump, file: '../fuera.dump' },
    }),
    /dentro de la carpeta/,
  );
});

test('verifyManifestAndFile detecta archivos alterados', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relevo-verify-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const createdAt = new Date('2026-10-27T20:15:00.123Z');
  const dumpPath = path.join(root, 'daily', buildBackupFileName(createdAt));
  await mkdir(path.dirname(dumpPath), { recursive: true });
  await writeFile(dumpPath, 'abc');
  const bytes = 3;
  const sha256 = await sha256File(dumpPath);
  const manifest = buildManifest({
    kind: 'daily',
    createdAt,
    completedAt: createdAt,
    connection: CONNECTION,
    root,
    dumpPath,
    bytes,
    sha256,
    commandBinary: 'pg_dump',
    commandArgs: ['--file', dumpPath],
    pgDumpVersion: null,
    verification: { tocEntries: 1, checkedAt: createdAt },
  });
  const manifestPath = path.join(root, 'daily', 'manifiesto.json');
  await writeFile(manifestPath, JSON.stringify(manifest));

  const verified = await verifyManifestAndFile(dumpPath, manifestPath);
  assert.equal(verified.sha256, sha256);
  assert.equal(verified.bytes, bytes);

  const broken = { ...manifest, dump: { ...manifest.dump, sha256: '0'.repeat(64) } };
  await writeFile(manifestPath, JSON.stringify(broken));
  await assert.rejects(
    verifyManifestAndFile(dumpPath, manifestPath),
    /SHA-256/,
  );
});

test('countTocEntries ignora comentarios de pg_restore --list', () => {
  const output = [
    ';',
    '; Archive created at 2026-10-27',
    ';     dbname: relevo',
    '',
    '1; 1259 16384 TABLE public cases relevo',
    '2; 2604 16385 DEFAULT public id relevo',
  ].join('\n');
  assert.equal(countTocEntries(output), 2);
  assert.equal(countTocEntries(''), 0);
});
