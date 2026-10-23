import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot, comparisonToken, safeResolve, ensureDirectory, copyEntry, assertNoLinks, removeOwnedTemporary } from './sync.mjs';

const token = value => comparisonToken(value, value);
const key = value => path.resolve(value).normalize('NFC').toLowerCase();
const overlap = (a, b) => key(a) === key(b) || key(a).startsWith(`${key(b)}${path.sep}`) || key(b).startsWith(`${key(a)}${path.sep}`);
const locks = new Set();
function requireId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{7,79}$/.test(value)) throw new Error('Invalid shared-save identifier.');
  return value;
}
async function checked(target, requireFiles = false) {
  const result = await snapshot(target);
  if (result.error) throw new Error(result.error);
  if (requireFiles && (!result.exists || !result.files)) throw new Error('The selected save is missing or empty.');
  return result;
}
async function checkDrive(externalRoot) {
  await assertNoLinks(externalRoot, { directory: true });
  if (!(await fs.stat(externalRoot)).isDirectory()) throw new Error('Reconnect the external drive first.');
}
export async function candidatePath({ externalRoot, groupId, candidateId }) {
  return safeResolve(externalRoot, `.wayfarer/shared/${requireId(groupId)}/${requireId(candidateId)}/payload`);
}
export async function captureCandidate({ externalRoot, groupId, sourcePath, expectedSnapshot, onProgress = () => {} }) {
  await checkDrive(externalRoot);
  const vault = await safeResolve(externalRoot, '.wayfarer');
  if (overlap(sourcePath, vault)) throw new Error('Choose an original save, not the shared-copy or backup storage.');
  const original = await checked(sourcePath, true);
  if (!expectedSnapshot || token(original) !== token(expectedSnapshot)) throw new Error('The source changed since refresh. Refresh and capture again.');
  const id = randomUUID(), at = Date.now();
  const payload = await candidatePath({ externalRoot, groupId, candidateId: id });
  const folder = path.dirname(payload);
  await ensureDirectory(path.dirname(folder));
  await fs.mkdir(folder);
  try {
    await onProgress('Creating a separate shared save copy…');
    await copyEntry(sourcePath, payload);
    const copied = await checked(payload, true);
    if (copied.fingerprint !== original.fingerprint || token(await checked(sourcePath)) !== token(original)) throw new Error('Source changed during capture. Your originals were not changed.');
    const result = { id, at, fingerprint: copied.fingerprint, files: copied.files, bytes: copied.bytes, newest: copied.newest };
    await fs.writeFile(path.join(folder, 'candidate.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    return result;
  } catch (error) {
    await removeOwnedTemporary(folder).catch(() => {});
    throw error;
  }
}
async function validateCandidate({ externalRoot, groupId, candidate }) {
  await checkDrive(externalRoot);
  const source = await candidatePath({ externalRoot, groupId, candidateId: candidate.id });
  const current = await checked(source, true);
  if (current.fingerprint !== candidate.fingerprint) throw new Error('This shared copy has changed. Capture a new copy and test it again.');
  return { source, current };
}
export async function verifyCandidate({ externalRoot, groupId, candidate, destinationPath }) {
  const { source, current } = await validateCandidate({ externalRoot, groupId, candidate });
  if (overlap(destinationPath, await safeResolve(externalRoot, '.wayfarer'))) throw new Error('An edition must use its original AppData location.');
  const destination = await checked(destinationPath);
  if (destination.exists && (await fs.lstat(source)).isDirectory() !== (await fs.lstat(destinationPath)).isDirectory()) throw new Error('The shared copy and target must both be files or both be folders. Correct the mapping first.');
  return { fingerprint: current.fingerprint, destinationToken: token(destination), targetPath: key(destinationPath) };
}
export async function applyCandidate({ externalRoot, groupId, candidate, destinationPath, destinationRoot, relativePath, verification, gameName, root, side, onProgress = () => {} }) {
  if (!['local', 'external'].includes(side) || !['Local', 'LocalLow', 'Roaming'].includes(root)) throw new Error('Invalid shared-save target.');
  const permitted = await safeResolve(destinationRoot, relativePath);
  if (key(permitted) !== key(destinationPath)) throw new Error('Target is outside the selected save location.');
  if (side === 'external' && key(destinationRoot) !== key(path.join(externalRoot, root))) throw new Error('Invalid external target root.');
  if (!verification || verification.candidateId !== candidate.id || verification.side !== side || verification.fingerprint !== candidate.fingerprint || verification.targetPath !== key(destinationPath)) throw new Error('Compatibility is unverified for this exact shared copy and target. Originals are protected.');
  if ([...locks].some(active => overlap(active, destinationPath))) throw new Error('A transfer to this save is already running.');
  locks.add(destinationPath);
  const id = randomUUID(), at = Date.now();
  const stage = path.join(path.dirname(destinationPath), `.wayfarer-stage-${id}`);
  const rollback = path.join(path.dirname(destinationPath), `.wayfarer-rollback-${id}`);
  let staged = false, displaced = false, backupPath, backupFolder, backupVerified = false;
  try {
    const { source, current } = await validateCandidate({ externalRoot, groupId, candidate });
    const before = await checked(destinationPath);
    if (token(before) !== verification.destinationToken) throw new Error('The target changed after testing. Refresh, inspect the versions, and confirm a new test before replacing it.');
    const verificationNow = await verifyCandidate({ externalRoot, groupId, candidate, destinationPath });
    if (verificationNow.destinationToken !== verification.destinationToken) throw new Error('The target changed after testing. Refresh, inspect the versions, and confirm a new test before replacing it.');
    await ensureDirectory(path.dirname(destinationPath));
    await onProgress('Staging the tested shared copy…');
    staged = true;
    await copyEntry(source, stage);
    if ((await checked(stage, true)).fingerprint !== candidate.fingerprint) throw new Error('Shared copy changed during staging.');
    const recheck = async () => {
      await validateCandidate({ externalRoot, groupId, candidate });
      if (token(await checked(destinationPath)) !== verification.destinationToken) throw new Error('The target changed during preparation. Nothing was overwritten.');
    };
    await recheck();
    if (before.exists) {
      await onProgress('Backing up the edition’s original save…');
      backupFolder = await safeResolve(externalRoot, `.wayfarer/backups/shared-${id}`);
      backupPath = await safeResolve(backupFolder, `${root}/${relativePath}`);
      await ensureDirectory(path.dirname(backupPath));
      await copyEntry(destinationPath, backupPath);
      if ((await checked(backupPath)).fingerprint !== before.fingerprint) throw new Error('Target changed during backup. Original save was not replaced.');
      await fs.writeFile(path.join(backupFolder, 'metadata.json'), JSON.stringify({ id, at, gameName, root, relativePath, direction: side === 'local' ? 'to-local' : 'to-drive', originalPath: destinationPath, fingerprint: before.fingerprint, candidateId: candidate.id }, null, 2), { flag: 'wx' });
      backupVerified = true;
    }
    await onProgress('Checking the tested copy and target again…');
    await recheck();
    await assertNoLinks(stage);
    if (before.exists) { await fs.rename(destinationPath, rollback); displaced = true; }
    try {
      await fs.rename(stage, destinationPath);
      staged = false;
    } catch (error) {
      if (displaced) {
        try {
          if (await fs.lstat(destinationPath).catch(() => null)) throw new Error('Target was recreated by another process.');
          await fs.rename(rollback, destinationPath);
          displaced = false;
        } catch (restoreError) { throw new Error(`Replacement failed. Recover the original from ${rollback} or ${backupPath}. ${restoreError.message}`); }
      }
      throw new Error(`Shared copy could not be applied; ${before.exists ? 'original restored' : 'no existing save was overwritten'}. ${error.message}`);
    }
    if (displaced) await removeOwnedTemporary(rollback).catch(() => {});
    return { id, at, gameName, root, relativePath, direction: side === 'local' ? 'to-local' : 'to-drive', files: current.files, bytes: current.bytes, backupPath, kind: 'shared' };
  } finally {
    if (staged) await removeOwnedTemporary(stage).catch(() => {});
    if (backupFolder && !backupVerified) await removeOwnedTemporary(backupFolder).catch(() => {});
    locks.delete(destinationPath);
  }
}
