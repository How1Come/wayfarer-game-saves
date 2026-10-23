import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { snapshot, comparisonToken } from '../electron/sync.mjs';
import { captureCandidate, candidatePath, verifyCandidate, applyCandidate } from '../electron/edition-saves.mjs';
import { VaultService } from '../electron/service.mjs';

async function write(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wayfarer-editions-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const externalRoot = path.join(base, 'drive', 'AppData');
  const localRoot = path.join(base, 'computer', 'AppData', 'Local');
  const sourcePath = path.join(localRoot, 'Source Expedition');
  const destinationPath = path.join(localRoot, 'Target Expedition');
  await fs.mkdir(externalRoot, { recursive: true });
  await write(path.join(sourcePath, 'save.dat'), 'source progress');
  await write(path.join(destinationPath, 'save.dat'), 'target original');
  return { base, externalRoot, localRoot, sourcePath, destinationPath, groupId: randomUUID() };
}
async function capture(f, options = {}) {
  return captureCandidate({ ...f, expectedSnapshot: await snapshot(f.sourcePath), ...options });
}
async function proof(f, candidate, options = {}) {
  return { ...await verifyCandidate({ ...f, candidate }), candidateId: candidate.id, memberId: randomUUID(), side: 'local', ...options };
}
function application(f, candidate, verification, extra = {}) {
  return { ...f, candidate, verification, destinationRoot: f.localRoot, relativePath: 'Target Expedition', gameName: 'Target Expedition', root: 'Local', side: 'local', ...extra };
}
async function contents(folder) { return fs.readFile(path.join(folder, 'save.dat'), 'utf8'); }

test('capturing an immutable candidate preserves both active editions and creates a separate copy', async t => {
  const f = await fixture(t), beforeSource = await snapshot(f.sourcePath), beforeTarget = await snapshot(f.destinationPath);
  const candidate = await capture(f);
  const payload = await candidatePath({ ...f, candidateId: candidate.id });
  assert.equal((await snapshot(payload)).fingerprint, beforeSource.fingerprint);
  assert.equal((await snapshot(f.sourcePath)).fingerprint, beforeSource.fingerprint);
  assert.equal((await snapshot(f.destinationPath)).fingerprint, beforeTarget.fingerprint);
  await write(path.join(f.sourcePath, 'save.dat'), 'later source progress');
  assert.equal(await contents(payload), 'source progress');
  assert.equal(candidate.files, 1);
  assert.equal(candidate.bytes, Buffer.byteLength('source progress'));
});

test('capture rejects stale comparisons and changes during copying without modifying either edition', async t => {
  const f = await fixture(t), expectedSnapshot = await snapshot(f.sourcePath);
  await write(path.join(f.sourcePath, 'save.dat'), 'changed since refresh');
  await assert.rejects(captureCandidate({ ...f, expectedSnapshot }), /source changed since refresh/i);
  await assert.rejects(capture(f, { onProgress: async () => write(path.join(f.sourcePath, 'save.dat'), 'changed during capture') }), /changed during capture/);
  assert.equal(await contents(f.sourcePath), 'changed during capture');
  assert.equal(await contents(f.destinationPath), 'target original');
  const group = path.join(f.externalRoot, '.wayfarer', 'shared', f.groupId);
  assert.deepEqual(await fs.readdir(group), []);
});

test('unknown compatibility and mismatched candidate, path or side never overwrite a target', async t => {
  const f = await fixture(t), candidate = await capture(f), verified = await proof(f, candidate);
  for (const verification of [undefined, { ...verified, side: 'external' }, { ...verified, candidateId: randomUUID() }, { ...verified, targetPath: f.sourcePath.toLowerCase() }]) {
    await assert.rejects(applyCandidate(application(f, candidate, verification)), /unverified/);
    assert.equal(await contents(f.destinationPath), 'target original');
  }
  const backups = await fs.stat(path.join(f.externalRoot, '.wayfarer', 'backups')).catch(() => null);
  assert.equal(backups, null);
});

test('tampering with a candidate invalidates verification even when its size and modification time stay unchanged', async t => {
  const f = await fixture(t), candidate = await capture(f), verified = await proof(f, candidate);
  const payload = await candidatePath({ ...f, candidateId: candidate.id }), file = path.join(payload, 'save.dat');
  const stat = await fs.stat(file);
  await fs.writeFile(file, 'hacked progress');
  await fs.utimes(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  await assert.rejects(verifyCandidate({ ...f, candidate }), /shared copy has changed/);
  await assert.rejects(applyCandidate(application(f, candidate, verified)), /shared copy has changed/);
  assert.equal(await contents(f.destinationPath), 'target original');
  assert.equal(await contents(f.sourcePath), 'source progress');
});

test('target changes after attestation are blocked before staging or backup', async t => {
  const f = await fixture(t), candidate = await capture(f), verified = await proof(f, candidate);
  await write(path.join(f.destinationPath, 'save.dat'), 'target played later');
  await assert.rejects(applyCandidate(application(f, candidate, verified)), /target changed after testing/);
  assert.equal(await contents(f.destinationPath), 'target played later');
  assert.deepEqual((await fs.readdir(f.localRoot)).sort(), ['Source Expedition', 'Target Expedition']);
});

test('the initial target snapshot must match the proof even if the target reappears before a second check', async t => {
  const base = await fixture(t);
  const f = { ...base, sourcePath: path.join(base.localRoot, 'source.dat'), destinationPath: path.join(base.localRoot, 'target.dat') };
  await write(f.sourcePath, 'source file');
  await write(f.destinationPath, 'target file');
  const candidate = await capture(f), verified = await proof(f, candidate), lstat = fs.lstat;
  let targetReads = 0;
  const mock = t.mock.method(fs, 'lstat', async (target, ...options) => {
    if (target === f.destinationPath && ++targetReads === 3) throw Object.assign(new Error('Target temporarily missing'), { code: 'ENOENT' });
    return lstat(target, ...options);
  });
  await assert.rejects(applyCandidate(application(f, candidate, verified, { relativePath: 'target.dat' })), /target changed after testing/);
  mock.mock.restore();
  assert.equal(targetReads, 3);
  assert.equal(await fs.readFile(f.destinationPath, 'utf8'), 'target file');
});

test('applying an explicitly verified candidate preserves source and candidate and backs up the entire target', async t => {
  const f = await fixture(t), candidate = await capture(f);
  await write(path.join(f.destinationPath, 'obsolete.dat'), 'previous edition only');
  const before = await snapshot(f.destinationPath), verified = await proof(f, candidate);
  const result = await applyCandidate(application(f, candidate, verified));
  const payload = await candidatePath({ ...f, candidateId: candidate.id });
  assert.equal(await contents(f.destinationPath), 'source progress');
  assert.equal(await contents(f.sourcePath), 'source progress');
  assert.equal((await snapshot(payload)).fingerprint, candidate.fingerprint);
  assert.equal((await snapshot(result.backupPath)).fingerprint, before.fingerprint);
  assert.equal(await fs.readFile(path.join(result.backupPath, 'obsolete.dat'), 'utf8'), 'previous edition only');
  await assert.rejects(fs.stat(path.join(f.destinationPath, 'obsolete.dat')), { code: 'ENOENT' });
  assert.equal(result.direction, 'to-local');
  assert.equal(result.kind, 'shared');
});

test('a missing target is permitted only with its exact verified missing-state token', async t => {
  const f = await fixture(t), candidate = await capture(f);
  await fs.rm(f.destinationPath, { recursive: true });
  const verified = await proof(f, candidate);
  const result = await applyCandidate(application(f, candidate, verified));
  assert.equal(await contents(f.destinationPath), 'source progress');
  assert.equal(result.backupPath, undefined);
});

test('external-side verification applies only inside the configured external AppData section', async t => {
  const base = await fixture(t);
  const f = { ...base, destinationPath: path.join(base.externalRoot, 'Local', 'Target Expedition') };
  await write(path.join(f.destinationPath, 'save.dat'), 'previous external edition');
  const candidate = await capture(f), verified = await proof(f, candidate, { side: 'external' });
  const result = await applyCandidate(application(f, candidate, verified, { side: 'external', destinationRoot: path.join(f.externalRoot, 'Local') }));
  assert.equal(result.direction, 'to-drive');
  assert.equal(await contents(f.destinationPath), 'source progress');
  assert.equal(await contents(result.backupPath), 'previous external edition');
});

test('changes during shared-copy preparation keep the destination intact', async t => {
  const f = await fixture(t), candidate = await capture(f), verified = await proof(f, candidate);
  await assert.rejects(applyCandidate(application(f, candidate, verified, { onProgress: async message => {
    if (message.startsWith('Checking the tested')) await write(path.join(f.destinationPath, 'save.dat'), 'new live progress');
  } })), /target changed during preparation/);
  assert.equal(await contents(f.destinationPath), 'new live progress');
  assert.equal(await contents(f.sourcePath), 'source progress');
  assert.deepEqual((await fs.readdir(f.localRoot)).sort(), ['Source Expedition', 'Target Expedition']);
});

test('unverified partial backups are removed when the live target changes during backup', async t => {
  const f = await fixture(t), candidate = await capture(f), verified = await proof(f, candidate);
  await assert.rejects(applyCandidate(application(f, candidate, verified, { onProgress: async message => {
    if (message.startsWith('Backing up')) await write(path.join(f.destinationPath, 'save.dat'), 'changed during backup');
  } })), /Target changed during backup/);
  assert.equal(await contents(f.destinationPath), 'changed during backup');
  assert.equal(await contents(f.sourcePath), 'source progress');
  assert.deepEqual(await fs.readdir(path.join(f.externalRoot, '.wayfarer', 'backups')), []);
  assert.deepEqual((await fs.readdir(f.localRoot)).sort(), ['Source Expedition', 'Target Expedition']);
});

test('replacement failure rolls back the target and retains verified backups and candidate data', async t => {
  const f = await fixture(t), candidate = await capture(f), verified = await proof(f, candidate);
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith('.wayfarer-stage-')) throw new Error('Target is locked');
    return rename(from, to);
  });
  await assert.rejects(applyCandidate(application(f, candidate, verified)), /original restored/);
  mock.mock.restore();
  assert.equal(await contents(f.destinationPath), 'target original');
  const payload = await candidatePath({ ...f, candidateId: candidate.id });
  assert.equal((await snapshot(payload)).fingerprint, candidate.fingerprint);
  const backups = path.join(f.externalRoot, '.wayfarer', 'backups');
  const [transaction] = await fs.readdir(backups);
  assert.equal(await contents(path.join(backups, transaction, 'Local', 'Target Expedition')), 'target original');
});

test('candidate identifiers, junctions and shared-vault aliases cannot redirect captures or applies', async t => {
  const f = await fixture(t), candidate = await capture(f);
  for (const groupId of ['../outside', 'bad\\folder', '/absolute', 'bad:stream']) {
    await assert.rejects(candidatePath({ ...f, groupId, candidateId: candidate.id }), /identifier/);
  }
  const payload = await candidatePath({ ...f, candidateId: candidate.id });
  await assert.rejects(captureCandidate({ ...f, sourcePath: payload, expectedSnapshot: await snapshot(payload) }), /original save/);
  await assert.rejects(verifyCandidate({ ...f, candidate, destinationPath: payload }), /original AppData/);
  const alias = path.join(f.base, 'alias');
  await fs.symlink(f.sourcePath, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureCandidate({ ...f, sourcePath: alias, expectedSnapshot: await snapshot(f.sourcePath) }), /link|junction/i);
});

async function serviceFixture(t, samePath = false) {
  const f = await fixture(t), gamesRoot = path.join(f.base, 'games'), portableDir = path.join(f.base, 'app');
  for (const title of ['Source Expedition', 'Target Expedition']) await write(path.join(gamesRoot, title, `${title.replaceAll(' ', '')}.exe`), 'fixture');
  await fs.mkdir(portableDir);
  const localRoots = { Local: f.localRoot, LocalLow: path.join(f.base, 'computer', 'AppData', 'LocalLow'), Roaming: path.join(f.base, 'computer', 'AppData', 'Roaming') };
  const service = await new VaultService({ portableDir, localRoots, isWindows: true }).initialize();
  await service.saveSettings({ gamesRoot, externalRoot: f.externalRoot, coverArt: false });
  for (const game of service.games) {
    await service.addMapping({ gameId: game.id, root: 'Local', relativePath: samePath ? 'Source Expedition' : game.name });
  }
  const games = [...service.games].sort((a, b) => a.name.localeCompare(b.name));
  await service.linkEditions({ name: 'Edition test', members: games.map(game => ({ gameId: game.id, mappingId: game.mappings[0].id, label: game.name })) });
  const group = service.library.sharedGroups[0], source = group.members.find(member => member.label === 'Source Expedition'), target = group.members.find(member => member.label === 'Target Expedition');
  await service.captureShared({ groupId: group.id, memberId: source.id, side: 'local', expectedToken: service.findMapping(source.gameId, source.mappingId).mapping.token });
  return { ...f, service, groupId: group.id, sourceId: source.id, targetId: target.id, candidate: service.library.sharedGroups[0].candidates[0], metadataFile: path.join(f.externalRoot, '.wayfarer', 'library.json') };
}

test('the service requires explicit successful-test attestation and blocks source-path aliases', async t => {
  const f = await serviceFixture(t, true);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await assert.rejects(f.service.verifyShared({ ...args, tested: false }), /Confirm that this exact copy/);
  await assert.rejects(f.service.verifyShared({ ...args, tested: true }), /same or overlapping save location/);
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.sourcePath), 'source progress');
});

test('service attestation is restricted to one target side and consumed after a successful application', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  await assert.rejects(f.service.applyShared({ ...args, side: 'external' }), /successful test/);
  await f.service.applyShared(args);
  assert.equal(await contents(f.destinationPath), 'source progress');
  assert.equal(await contents(f.sourcePath), 'source progress');
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test/);
});

test('refresh removes a successful-test indicator when the target save has changed', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 1);
  await write(path.join(f.destinationPath, 'save.dat'), 'target advanced after testing');
  await f.service.refresh();
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target advanced after testing');
  assert.equal(await contents(f.sourcePath), 'source progress');
});

test('refresh retains a successful-test indicator for an unchanged target', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  await f.service.refresh();
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 1);
  await f.service.applyShared(args);
  assert.equal(await contents(f.destinationPath), 'source progress');
  assert.equal(await contents(f.sourcePath), 'source progress');
});

test('testing a target changed since refresh requires a fresh comparison before creating a visible proof', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await write(path.join(f.destinationPath, 'save.dat'), 'latest target before test');
  await assert.rejects(f.service.verifyShared({ ...args, tested: true }), /target changed since refresh/i);
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  assert.equal(await contents(f.destinationPath), 'latest target before test');
  await f.service.refresh();
  await f.service.verifyShared({ ...args, tested: true });
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 1);
  await f.service.applyShared(args);
  assert.equal(await contents(f.destinationPath), 'source progress');
  assert.equal(await contents(f.service.library.history[0].backupPath), 'latest target before test');
});

test('successful-test attestations expire on restart even on the same computer', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 1);
  const restarted = await new VaultService({ portableDir: f.service.portableDir, localRoots: f.service.localRoots, isWindows: true }).initialize();
  await restarted.getState();
  assert.equal(restarted.machine, f.service.machine);
  assert.equal(restarted.library.sharedGroups[0].verifications.length, 1);
  assert.equal(restarted.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(restarted.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target original');
  assert.equal(await contents(f.sourcePath), 'source progress');
  await restarted.verifyShared({ ...args, tested: true });
  await restarted.applyShared(args);
  assert.equal(await contents(f.destinationPath), 'source progress');
});

test('changing the game library revokes tests even when relative installations and save paths match', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  const gamesRoot = path.join(f.base, 'different-editions');
  for (const game of f.service.games) await write(path.join(gamesRoot, game.relativeInstallPath, `${game.name.replaceAll(' ', '')}.exe`), 'different edition fixture');
  await f.service.saveSettings({ ...f.service.config, gamesRoot });
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target original');
  assert.equal(await contents(f.sourcePath), 'source progress');
});

for (const edition of ['source', 'target']) test(`correcting the ${edition} game revokes compatibility even when its save path stays unchanged`, async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  const member = f.service.library.sharedGroups[0].members.find(item => item.id === (edition === 'source' ? f.sourceId : f.targetId));
  await f.service.addGame({ installPath: f.service.findGame(member.gameId).installPath, name: 'Different Unrelated Game' });
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target original');
  assert.equal(await contents(f.sourcePath), 'source progress');
});

for (const edition of ['source', 'target']) test(`loading a corrected ${edition} identity from metadata cannot inherit a session test`, async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  const member = f.service.library.sharedGroups[0].members.find(item => item.id === (edition === 'source' ? f.sourceId : f.targetId));
  const game = f.service.findGame(member.gameId);
  const saved = JSON.parse(await fs.readFile(f.metadataFile, 'utf8'));
  saved.manualGames.push({ relativeInstallPath: game.relativeInstallPath, name: 'Different Unrelated Game' });
  await fs.writeFile(f.metadataFile, JSON.stringify(saved));
  await f.service.refresh();
  assert.equal(f.service.findGame(game.id).name, 'Different Unrelated Game');
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target original');
  assert.equal(await contents(f.sourcePath), 'source progress');
});

test('a failed game-correction metadata save still revokes the tested edition', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  const member = f.service.library.sharedGroups[0].members.find(item => item.id === f.targetId);
  f.service.saveLibrary = async () => { throw new Error('Disk write failed'); };
  await assert.rejects(f.service.addGame({ installPath: f.service.findGame(member.gameId).installPath, name: 'Different Unrelated Game' }), /Disk write failed/);
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target original');
  assert.equal(await contents(f.sourcePath), 'source progress');
});

test('moving the archive to a new computer never carries over an old successful-test proof', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  const localRoots = Object.fromEntries(['Local', 'LocalLow', 'Roaming'].map(root => [root, path.join(f.base, 'new-computer', 'AppData', root)]));
  const newTarget = path.join(localRoots.Local, 'Target Expedition');
  await write(path.join(newTarget, 'save.dat'), 'new computer original');
  const moved = await new VaultService({ portableDir: f.service.portableDir, localRoots, isWindows: true }).initialize();
  await moved.getState();
  assert.notEqual(moved.machine, f.service.machine);
  assert.equal(moved.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(moved.applyShared(args), /successful test/);
  assert.equal(await contents(newTarget), 'new computer original');
  assert.equal(await contents(f.destinationPath), 'target original');
});

test('session attestation cannot be replaced by edited candidate fingerprints in persisted metadata', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  const payload = await candidatePath({ ...f, candidateId: f.candidate.id });
  await write(path.join(payload, 'save.dat'), 'untested altered data');
  const tampered = await snapshot(payload), saved = JSON.parse(await fs.readFile(f.metadataFile, 'utf8'));
  saved.sharedGroups[0].candidates[0].fingerprint = tampered.fingerprint;
  saved.sharedGroups[0].verifications[0].fingerprint = tampered.fingerprint;
  await fs.writeFile(f.metadataFile, JSON.stringify(saved));
  await f.service.refresh();
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target original');
});

test('session attestation cannot be rebound to a changed target through persisted metadata', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  await write(path.join(f.destinationPath, 'save.dat'), 'target advanced after testing');
  const changed = await snapshot(f.destinationPath), saved = JSON.parse(await fs.readFile(f.metadataFile, 'utf8'));
  saved.sharedGroups[0].verifications[0].destinationToken = comparisonToken(changed, changed);
  await fs.writeFile(f.metadataFile, JSON.stringify(saved));
  await f.service.refresh();
  await assert.rejects(f.service.applyShared(args), /successful test/);
  assert.equal(await contents(f.destinationPath), 'target advanced after testing');
});

test('an attested source-location change invalidates applying the candidate', async t => {
  const f = await serviceFixture(t);
  const args = { groupId: f.groupId, candidateId: f.candidate.id, memberId: f.targetId, side: 'local' };
  await f.service.verifyShared({ ...args, tested: true });
  const saved = JSON.parse(await fs.readFile(f.metadataFile, 'utf8'));
  saved.sharedGroups[0].candidates[0].sourceRelativePath = 'Changed Source';
  await fs.writeFile(f.metadataFile, JSON.stringify(saved));
  await f.service.refresh();
  assert.equal(f.service.state().sharedGroups[0].verifications.length, 0);
  await assert.rejects(f.service.applyShared(args), /successful test|source mapping changed/);
  assert.equal(await contents(f.destinationPath), 'target original');
});
