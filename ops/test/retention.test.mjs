import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildBackupFileName,
  manifestNameForDump,
  parseBackupFileName,
} from '../lib/paths.mjs';
import {
  DEFAULT_RETENTION,
  listManagedBackups,
  planRetention,
  pruneBackups,
} from '../lib/retention.mjs';

const BASE = Date.parse('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function entry(kind, timestampMs, root = 'C:/respaldos') {
  const name = buildBackupFileName(new Date(timestampMs));
  return {
    kind,
    name,
    dumpPath: path.join(root, kind, name),
    manifestPath: path.join(root, kind, manifestNameForDump(name)),
    timestampMs,
    createdAt: new Date(timestampMs).toISOString(),
  };
}

async function createPair(root, item) {
  await mkdir(path.dirname(item.dumpPath), { recursive: true });
  await writeFile(item.dumpPath, `dump-${item.name}`);
  await writeFile(item.manifestPath, '{}');
}

test('buildBackupFileName y parseBackupFileName usan UTC y validan fechas', () => {
  const date = new Date(Date.UTC(2026, 9, 27, 20, 15, 0, 123));
  const name = buildBackupFileName(date);
  assert.equal(name, 'relevo_20261027T201500123Z.dump');
  assert.equal(parseBackupFileName(name).iso, date.toISOString());
  assert.equal(parseBackupFileName(name).timestampMs, date.getTime());
  assert.equal(parseBackupFileName('relevo_20260230T000000000Z.dump'), null);
  assert.equal(parseBackupFileName('otro.dump'), null);
});

test('planRetention conserva 7 diarias y 4 semanales más recientes por separado', () => {
  const daily = Array.from({ length: 12 }, (_, index) => entry('daily', BASE + index * DAY));
  const weekly = Array.from({ length: 6 }, (_, index) => entry('weekly', BASE + index * 7 * DAY));
  const plan = planRetention([...daily, ...weekly], DEFAULT_RETENTION);

  assert.equal(plan.keep.filter((item) => item.kind === 'daily').length, 7);
  assert.equal(plan.remove.filter((item) => item.kind === 'daily').length, 5);
  assert.equal(plan.keep.filter((item) => item.kind === 'weekly').length, 4);
  assert.equal(plan.remove.filter((item) => item.kind === 'weekly').length, 2);

  const keptDaily = new Set(plan.keep.filter((item) => item.kind === 'daily').map((item) => item.timestampMs));
  for (const item of daily.slice(0, 5)) assert.equal(keptDaily.has(item.timestampMs), false);
  for (const item of daily.slice(5)) assert.equal(keptDaily.has(item.timestampMs), true);

  assert.throws(() => planRetention([], { daily: -1, weekly: 4 }), /Límite/);
});

test('pruneBackups solo borra pares gestionados y respeta dry-run y protección', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relevo-retention-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const daily = Array.from({ length: 9 }, (_, index) => entry('daily', BASE + index * DAY, root));
  const weekly = Array.from({ length: 5 }, (_, index) => entry('weekly', BASE + index * 7 * DAY, root));
  for (const item of [...daily, ...weekly]) await createPair(root, item);

  const unrelated = path.join(root, 'daily', 'notas.txt');
  const unknownDump = path.join(root, 'daily', 'raro.dump');
  const orphanDump = path.join(root, 'daily', 'relevo_20200101T000000000Z.dump');
  const orphanManifest = path.join(root, 'daily', 'relevo_20200102T000000000Z.manifest.json');
  await writeFile(unrelated, 'no borrar');
  await writeFile(unknownDump, 'no borrar');
  await writeFile(orphanDump, 'no borrar');
  await writeFile(orphanManifest, '{}');

  const listed = await listManagedBackups(root);
  assert.equal(listed.entries.length, 14);
  assert.equal(listed.warnings.some((warning) => warning.includes('sin manifiesto')), true);
  assert.equal(listed.warnings.some((warning) => warning.includes('sin respaldo')), true);

  const dry = await pruneBackups(root, DEFAULT_RETENTION, { dryRun: true });
  assert.equal(dry.removed.length, 3);
  assert.equal(dry.keep.length, 11);
  assert.equal((await stat(daily[0].dumpPath)).isFile(), true);

  const result = await pruneBackups(root, DEFAULT_RETENTION);
  assert.equal(result.removed.length, 3);
  for (const item of daily.slice(0, 2)) {
    await assert.rejects(stat(item.dumpPath), { code: 'ENOENT' });
    await assert.rejects(stat(item.manifestPath), { code: 'ENOENT' });
  }
  await assert.rejects(stat(weekly[0].dumpPath), { code: 'ENOENT' });
  assert.equal((await readFile(unrelated, 'utf8')), 'no borrar');
  assert.equal((await stat(unknownDump)).isFile(), true);
  assert.equal((await stat(orphanDump)).isFile(), true);
  assert.equal((await stat(orphanManifest)).isFile(), true);
});

test('pruneBackups protege explícitamente un respaldo recién creado', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relevo-protect-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const daily = Array.from({ length: 8 }, (_, index) => entry('daily', BASE + index * DAY, root));
  for (const item of daily) await createPair(root, item);

  const result = await pruneBackups(root, DEFAULT_RETENTION, { protect: [daily[0].dumpPath] });
  assert.equal(result.removed.length, 0);
  assert.equal(result.keep.length, 8);
  assert.equal(result.warnings.some((warning) => warning.includes('protegido')), true);
  assert.equal((await stat(daily[0].dumpPath)).isFile(), true);
});
