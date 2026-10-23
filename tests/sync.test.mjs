import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { snapshot, compareSnapshots, comparisonToken, safeResolve, transferSave } from '../electron/sync.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wayfarer-sync-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const localRoot = path.join(base, 'computer', 'Local');
  const externalRoot = path.join(base, 'drive', 'AppData');
  await Promise.all([fs.mkdir(localRoot, { recursive: true }), fs.mkdir(externalRoot, { recursive: true })]);
  return { base, localRoot, externalRoot,
    options: { localRoot, externalRoot, root: 'Local', relativePath: 'Studio/Game', gameName: 'Test Game', direction: 'to-drive' },
    local: path.join(localRoot, 'Studio', 'Game'), external: path.join(externalRoot, 'Local', 'Studio', 'Game') };
}
async function write(target, contents, when) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  if (when) await fs.utimes(target, when, when);
}
async function token(f) { return comparisonToken(await snapshot(f.local), await snapshot(f.external)); }
async function read(target) { return fs.readFile(target, 'utf8'); }

test('snapshots hash complete contents, including equal-length edits with preserved modification time', async (t) => {
  const f = await fixture(t), file = path.join(f.local, 'slot.sav'), date = new Date('2025-01-02T03:04:05Z');
  await write(file, 'level1', date);
  await fs.mkdir(path.join(f.local, 'empty'), { recursive: true });
  const first = await snapshot(f.local);
  assert.equal(first.files, 1);
  assert.equal(first.bytes, 6);
  assert.equal(first.newest, date.getTime());
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await snapshot(f.local)).fingerprint, first.fingerprint);
  await write(file, 'level2', date);
  const second = await snapshot(f.local);
  assert.equal(second.newest, first.newest);
  assert.notEqual(second.fingerprint, first.fingerprint);
  await fs.rmdir(path.join(f.local, 'empty'));
  assert.notEqual((await snapshot(f.local)).fingerprint, second.fingerprint);
});

test('snapshot fingerprints ignore timestamps but comparison tokens notice them', async (t) => {
  const f = await fixture(t);
  await write(f.local, 'save', new Date('2024-01-01Z'));
  await write(f.external, 'save', new Date('2025-01-01Z'));
  const a = await snapshot(f.local), b = await snapshot(f.external);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(compareSnapshots(a, b), 'synced');
  assert.notEqual(comparisonToken(a, a), comparisonToken(a, b));
});

test('comparison identifies new saves, empty saves, errors, timestamp ties and two-sided conflicts', () => {
  const a = { exists: true, files: 1, bytes: 1, newest: 100, fingerprint: 'a' };
  const b = { ...a, newest: 200, fingerprint: 'b' };
  const empty = { ...a, exists: false, files: 0, fingerprint: 'missing' };
  assert.equal(compareSnapshots(a, b), 'drive-newer');
  assert.equal(compareSnapshots(b, a), 'local-newer');
  assert.equal(compareSnapshots(a, { ...b, newest: 100 }), 'conflict');
  assert.equal(compareSnapshots(a, b, 'original'), 'conflict');
  assert.equal(compareSnapshots(a, b, { local: 'a', external: 'old' }), 'drive-newer');
  assert.equal(compareSnapshots(a, b, { localFingerprint: 'old', externalFingerprint: 'b' }), 'local-newer');
  assert.equal(compareSnapshots(a, b, { local: { fingerprint: 'a' }, external: { fingerprint: 'b' } }), 'conflict');
  assert.equal(compareSnapshots(a, empty), 'local-only');
  assert.equal(compareSnapshots(empty, b), 'drive-only');
  assert.equal(compareSnapshots(empty, empty), 'empty');
  assert.equal(compareSnapshots({ ...a, error: 'Locked' }, b), 'error');
});

test('safeResolve accepts both separators and rejects Windows traversal, devices and root-only paths', async (t) => {
  const f = await fixture(t);
  assert.equal(await safeResolve(f.localRoot, 'Studio\\Game'), f.local);
  for (const relative of ['', '.', '..', '../outside', 'Studio/../outside', 'Studio\\..\\outside', '/outside', '\\outside',
    'C:\\outside', 'C:outside', '//server/share', 'Studio//Game', 'Studio/', 'foo:stream', 'folder.', 'folder ', 'CON',
    'NUL.sav', 'COM1', 'lPt9.txt', 'file\0.sav', 'file?.sav']) {
    await assert.rejects(safeResolve(f.localRoot, relative), undefined, relative);
  }
  await assert.rejects(safeResolve(path.parse(f.localRoot).root, 'Game'), /root/);
});

test('links inside saves, selected roots and root ancestors are rejected', async (t) => {
  const f = await fixture(t), target = path.join(f.base, 'other');
  await fs.mkdir(target);
  await fs.mkdir(f.local, { recursive: true });
  await fs.symlink(target, path.join(f.local, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await snapshot(f.local)).error, /link|junction/i);
  await assert.rejects(safeResolve(f.localRoot, 'Studio/Game/linked/slot.sav'), /link|junction/i);
  const alias = path.join(f.base, 'alias');
  await fs.symlink(path.join(f.base, 'computer'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safeResolve(path.join(alias, 'Local'), 'Game'), /link|junction/i);
  await assert.rejects(safeResolve(alias, 'Game'), /link|junction/i);
});

test('drive transfer fully replaces the destination, preserves times and retains a verified backup', async (t) => {
  const f = await fixture(t), when = new Date('2023-06-07T08:09:10Z');
  await write(path.join(f.local, 'slot1.sav'), 'new progress', when);
  await write(path.join(f.local, 'nested', 'slot2.sav'), 'second slot', when);
  await fs.mkdir(path.join(f.local, 'empty'));
  await write(path.join(f.external, 'slot1.sav'), 'old progress');
  await write(path.join(f.external, 'obsolete.sav'), 'remove this');
  const previous = await snapshot(f.external), progress = [];
  const history = await transferSave({ ...f.options, expectedToken: await token(f), onProgress: (text) => progress.push(text) });
  assert.equal((await snapshot(f.local)).fingerprint, (await snapshot(f.external)).fingerprint);
  assert.equal((await snapshot(history.backupPath)).fingerprint, previous.fingerprint);
  assert.equal(await read(path.join(history.backupPath, 'obsolete.sav')), 'remove this');
  await assert.rejects(fs.stat(path.join(f.external, 'obsolete.sav')), { code: 'ENOENT' });
  assert.equal((await fs.stat(path.join(f.external, 'slot1.sav'))).mtimeMs, when.getTime());
  assert.equal((await fs.stat(path.join(f.external, 'empty'))).isDirectory(), true);
  assert.equal(history.files, 2);
  assert.equal(history.bytes, Buffer.byteLength('new progresssecond slot'));
  assert.equal(history.direction, 'to-drive');
  assert.ok(history.backupPath.startsWith(path.join(f.externalRoot, '.wayfarer', 'backups')));
  assert.ok(progress.some((text) => text.includes('Staging')));
  assert.deepEqual((await fs.readdir(path.dirname(f.external))).sort(), ['Game']);
});

test('restore onto a fresh computer creates missing LocalLow folders and supports single-file saves', async (t) => {
  const f = await fixture(t), localRoot = path.join(f.base, 'computer', 'LocalLow');
  const external = path.join(f.externalRoot, 'LocalLow', 'Studio', 'slot.sav');
  const local = path.join(localRoot, 'Studio', 'slot.sav');
  await write(external, 'portable progress');
  const history = await transferSave({ ...f.options, localRoot, root: 'LocalLow', relativePath: 'Studio/slot.sav', direction: 'to-local',
    expectedToken: comparisonToken(await snapshot(local), await snapshot(external)) });
  assert.equal(await read(local), 'portable progress');
  assert.equal(history.backupPath, undefined);
});

test('file-to-directory replacement backs up the original file', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.local, 'slot.sav'), 'folder save');
  await write(f.external, 'former single-file save');
  const history = await transferSave({ ...f.options, expectedToken: await token(f) });
  assert.equal(await read(path.join(f.external, 'slot.sav')), 'folder save');
  assert.equal(await read(history.backupPath), 'former single-file save');
});

test('missing or empty sources can never erase existing progress', async (t) => {
  const f = await fixture(t);
  await write(path.join(f.external, 'slot.sav'), 'keep me');
  await assert.rejects(transferSave({ ...f.options, expectedToken: await token(f) }), /missing or empty/);
  await fs.mkdir(f.local, { recursive: true });
  await assert.rejects(transferSave({ ...f.options, expectedToken: await token(f) }), /missing or empty/);
  assert.equal(await read(path.join(f.external, 'slot.sav')), 'keep me');
});

test('a zero-byte save file is legitimate data and can be transferred', async (t) => {
  const f = await fixture(t);
  await write(f.local, '');
  const history = await transferSave({ ...f.options, expectedToken: await token(f) });
  assert.equal(history.files, 1);
  assert.equal(history.bytes, 0);
  assert.equal(await read(f.external), '');
});

test('stale UI comparisons are blocked before destination mutation', async (t) => {
  const f = await fixture(t);
  await write(f.local, 'new');
  await write(f.external, 'old');
  const expectedToken = await token(f);
  await write(f.external, 'changed after refresh');
  await assert.rejects(transferSave({ ...f.options, expectedToken }), /since the last refresh/);
  assert.equal(await read(f.external), 'changed after refresh');
  await assert.rejects(transferSave({ ...f.options, expectedToken: '' }), /since the last refresh/);
});

for (const changedSide of ['local', 'external']) {
  test(`a ${changedSide} change after staging blocks commit and cleans temporary data`, async (t) => {
    const f = await fixture(t);
    await write(f.local, 'source');
    await write(f.external, 'destination');
    await assert.rejects(transferSave({ ...f.options, expectedToken: await token(f), onProgress: async (message) => {
      if (message.startsWith('Staged save;')) await write(f[changedSide], 'concurrent change');
    } }), /changed while the transfer/);
    assert.equal(await read(f.external), changedSide === 'external' ? 'concurrent change' : 'destination');
    assert.deepEqual(await fs.readdir(path.dirname(f.external)), ['Game']);
  });
}

test('changes during backup are checked again immediately before commit', async (t) => {
  const f = await fixture(t);
  await write(f.local, 'source');
  await write(f.external, 'destination');
  await assert.rejects(transferSave({ ...f.options, expectedToken: await token(f), onProgress: async (message) => {
    if (message.startsWith('Backup ready;')) await write(f.local, 'updated while backup was prepared');
  } }), /changed while the transfer/);
  assert.equal(await read(f.external), 'destination');
  assert.equal((await fs.readdir(path.join(f.externalRoot, '.wayfarer', 'backups'))).length, 1);
});

test('a failed replacement restores the original destination and retains its external backup', async (t) => {
  const f = await fixture(t);
  await write(f.local, 'new progress');
  await write(f.external, 'original progress');
  const realRename = fs.rename;
  const rename = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith('.wayfarer-stage-')) throw Object.assign(new Error('File is locked'), { code: 'EACCES' });
    return realRename(from, to);
  });
  await assert.rejects(transferSave({ ...f.options, expectedToken: await token(f) }), /original destination was restored/);
  rename.mock.restore();
  assert.equal(await read(f.external), 'original progress');
  assert.equal(await read(f.local), 'new progress');
  assert.deepEqual(await fs.readdir(path.dirname(f.external)), ['Game']);
  const backups = path.join(f.externalRoot, '.wayfarer', 'backups');
  const [transaction] = await fs.readdir(backups);
  assert.equal(await read(path.join(backups, transaction, 'Local', 'Studio', 'Game')), 'original progress');
});

test('rollback failure preserves recovery copies and reports their paths', async (t) => {
  const f = await fixture(t);
  await write(f.local, 'new progress');
  await write(f.external, 'original progress');
  const realRename = fs.rename;
  const rename = t.mock.method(fs, 'rename', async (from, to) => {
    if (/^\.wayfarer-(stage|rollback)-/.test(path.basename(from))) throw new Error('Locked by another process');
    return realRename(from, to);
  });
  await assert.rejects(transferSave({ ...f.options, expectedToken: await token(f) }), /original save remains at .*external backup:/);
  rename.mock.restore();
  const [retained] = (await fs.readdir(path.dirname(f.external))).filter((name) => name.startsWith('.wayfarer-rollback-'));
  assert.equal(await read(path.join(path.dirname(f.external), retained)), 'original progress');
});

test('overlapping roots, unsafe backup locations and backup symlinks are blocked', async (t) => {
  const f = await fixture(t);
  await write(f.local, 'source');
  await assert.rejects(transferSave({ ...f.options, externalRoot: path.dirname(f.localRoot), expectedToken: 'unused' }), /separate folders/);
  await assert.rejects(transferSave({ ...f.options, externalRoot: f.localRoot.toUpperCase(), expectedToken: 'unused' }), /separate folders/);
  await assert.rejects(transferSave({ ...f.options, backupRoot: path.join(f.base, 'backups'), expectedToken: await token(f) }), /Backups must remain/);
  await fs.mkdir(path.join(f.externalRoot, '.wayfarer'));
  await fs.symlink(f.localRoot, path.join(f.externalRoot, '.wayfarer', 'backups'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(transferSave({ ...f.options, expectedToken: await token(f) }), /link|junction/i);
});

test('overlapping simultaneous transfers cannot race each other', async (t) => {
  const f = await fixture(t);
  await write(f.local, 'source');
  const expectedToken = await token(f);
  let release, notify;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { notify = resolve; });
  const first = transferSave({ ...f.options, expectedToken, onProgress: async (message) => {
    if (message.startsWith('Staging')) { notify(); await blocked; }
  } });
  await entered;
  try { await assert.rejects(transferSave({ ...f.options, expectedToken }), /already running/); }
  finally { release(); }
  await first;
  assert.equal(await read(f.external), 'source');
});
