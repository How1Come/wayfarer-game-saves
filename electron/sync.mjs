import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const APPDATA_ROOTS = new Set(['Local', 'LocalLow', 'Roaming']);
const MISSING_FINGERPRINT = createHash('sha256').update('missing').digest('hex');
const activeTransfers = new Set();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const pathKey = (value) => path.resolve(value).normalize('NFC').toLowerCase();
const overlaps = (a, b) => {
  const x = pathKey(a), y = pathKey(b);
  return x === y || x.startsWith(`${y}${path.sep}`) || y.startsWith(`${x}${path.sep}`);
};
const messageOf = (error) => error instanceof Error ? error.message : String(error);
const isMissing = (error) => error?.code === 'ENOENT';

async function statOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

function requireAbsoluteRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Select an absolute folder path.');
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) throw new Error('A drive or filesystem root cannot be used as a save folder.');
  return resolved;
}

function relativeParts(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new Error('Choose a specific save file or folder below the AppData root.');
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error('The save path contains traversal or an invalid Windows filename.');
  }
  return parts;
}

async function assertNoLinks(target, { directory = false } = {}) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await statOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not supported: ${current}`);
    if ((index < parts.length - 1 || directory) && !stat.isDirectory()) throw new Error(`Expected a folder: ${current}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported filesystem entry: ${current}`);
  }
}

export async function safeResolve(root, relativePath) {
  const base = requireAbsoluteRoot(root);
  const parts = relativeParts(relativePath);
  await assertNoLinks(base, { directory: true });
  const target = path.resolve(base, ...parts);
  if (!pathKey(target).startsWith(`${pathKey(base)}${path.sep}`)) throw new Error('Save path escapes its AppData root.');
  await assertNoLinks(target);
  return target;
}

function sameFileStat(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

async function withReadFile(target, callback) {
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Save contains a link or non-regular file: ${target}`);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileStat(before, opened)) throw new Error(`Save changed while being read: ${target}`);
    const result = await callback(handle, opened);
    const [after, stillAtPath] = await Promise.all([handle.stat(), fs.lstat(target)]);
    if (!sameFileStat(opened, after) || !sameFileStat(opened, stillAtPath) || stillAtPath.isSymbolicLink()) {
      throw new Error(`Save changed while being read: ${target}`);
    }
    return result;
  } finally { await handle.close(); }
}

async function readContents(handle, consume) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    await consume(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

export async function snapshot(target) {
  const result = { exists: false, files: 0, bytes: 0, newest: null, fingerprint: MISSING_FINGERPRINT };
  try {
    await assertNoLinks(target);
    const initial = await statOrNull(target);
    if (!initial) return result;
    result.exists = true;
    const entries = [];
    async function visit(current, relative) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Save contains a symbolic link or junction: ${current}`);
      if (stat.isDirectory()) {
        entries.push(['directory', relative]);
        const names = (await fs.readdir(current)).sort();
        const folded = new Set();
        for (const name of names) {
          relativeParts(name);
          const key = name.normalize('NFC').toLowerCase();
          if (folded.has(key)) throw new Error(`Case-conflicting Windows filenames in ${current}`);
          folded.add(key);
          await visit(path.join(current, name), relative ? `${relative}/${name}` : name);
        }
        const after = await fs.lstat(current);
        if (!after.isDirectory() || after.isSymbolicLink() || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs
          || JSON.stringify(names) !== JSON.stringify((await fs.readdir(current)).sort())) {
          throw new Error(`Save folder changed while being read: ${current}`);
        }
      } else if (stat.isFile()) {
        await withReadFile(current, async (handle, opened) => {
          const digest = createHash('sha256');
          await readContents(handle, async (chunk) => { digest.update(chunk); });
          entries.push(['file', relative, opened.size, digest.digest('hex')]);
          result.files++;
          result.bytes += opened.size;
          result.newest = Math.max(result.newest ?? -Infinity, opened.mtimeMs);
        });
      } else throw new Error(`Save contains an unsupported filesystem entry: ${current}`);
    }
    await visit(target, '');
    result.fingerprint = hash(JSON.stringify(entries));
    return result;
  } catch (error) {
    return { ...result, fingerprint: '', error: messageOf(error) };
  }
}

function baselineSides(baseline) {
  if (typeof baseline === 'string') return [baseline, baseline];
  const fingerprint = (value) => typeof value === 'string' ? value : value?.fingerprint;
  return [fingerprint(baseline?.local) ?? baseline?.localFingerprint ?? baseline?.fingerprint,
    fingerprint(baseline?.external) ?? baseline?.externalFingerprint ?? baseline?.fingerprint];
}

export function compareSnapshots(local, external, baseline) {
  if (local.error || external.error) return 'error';
  if (!local.files && !external.files) return 'empty';
  if (!external.files) return 'local-only';
  if (!local.files) return 'drive-only';
  if (local.fingerprint === external.fingerprint) return 'synced';
  const [oldLocal, oldExternal] = baselineSides(baseline);
  if (oldLocal && oldExternal) {
    const localChanged = local.fingerprint !== oldLocal, externalChanged = external.fingerprint !== oldExternal;
    if (localChanged && externalChanged) return 'conflict';
    if (localChanged) return 'local-newer';
    if (externalChanged) return 'drive-newer';
    return 'conflict';
  }
  if (local.newest === external.newest || local.newest === null || external.newest === null) return 'conflict';
  return local.newest > external.newest ? 'local-newer' : 'drive-newer';
}

export function comparisonToken(local, external) {
  const fields = (item) => [item.exists, item.files, item.bytes, item.newest, item.fingerprint, item.error ?? null];
  return hash(JSON.stringify([fields(local), fields(external)]));
}

async function ensureDirectory(target) {
  await assertNoLinks(target, { directory: true });
  const stat = await statOrNull(target);
  if (stat) return;
  await ensureDirectory(path.dirname(target));
  try { await fs.mkdir(target); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assertNoLinks(target, { directory: true });
}

async function copyEntry(source, destination) {
  await assertNoLinks(source);
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Save contains a symbolic link or junction: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination);
    for (const name of (await fs.readdir(source)).sort()) {
      relativeParts(name);
      await copyEntry(path.join(source, name), path.join(destination, name));
    }
    await fs.utimes(destination, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  } else if (stat.isFile()) {
    await withReadFile(source, async (input, opened) => {
      const output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), opened.mode & 0o777);
      try {
        await readContents(input, async (chunk) => {
          let written = 0;
          while (written < chunk.length) {
            const { bytesWritten } = await output.write(chunk, written, chunk.length - written);
            if (!bytesWritten) throw new Error('Could not write save data.');
            written += bytesWritten;
          }
        });
        await output.utimes(opened.atimeMs / 1000, opened.mtimeMs / 1000);
        await output.sync();
      } finally { await output.close(); }
    });
  } else throw new Error(`Unsupported save entry: ${source}`);
}

async function removeOwnedTemporary(target) {
  await assertNoLinks(path.dirname(target), { directory: true });
  await fs.rm(target, { recursive: true, force: true });
}

export async function transferSave({ localRoot, externalRoot, root, relativePath, direction, expectedToken,
  backupRoot, gameName = 'Game', onProgress = () => {} }) {
  if (!APPDATA_ROOTS.has(root)) throw new Error('Choose Local, LocalLow or Roaming.');
  if (direction !== 'to-drive' && direction !== 'to-local') throw new Error('Invalid transfer direction.');
  const localBase = requireAbsoluteRoot(localRoot), externalBase = requireAbsoluteRoot(externalRoot);
  if (overlaps(localBase, externalBase)) throw new Error('Local AppData and the external save archive must be separate folders.');
  for (const base of [localBase, externalBase]) {
    await assertNoLinks(base, { directory: true });
    const stat = await statOrNull(base);
    if ((base === externalBase && !stat) || (stat && !stat.isDirectory())) throw new Error(`The selected root folder is unavailable: ${base}`);
  }
  const localPath = await safeResolve(localBase, relativePath);
  const externalAppData = await safeResolve(externalBase, root);
  const externalPath = await safeResolve(externalAppData, relativePath);
  const requiredBackupRoot = await safeResolve(externalBase, '.wayfarer/backups');
  const backups = backupRoot ? requireAbsoluteRoot(backupRoot) : requiredBackupRoot;
  if (pathKey(backups) !== pathKey(requiredBackupRoot) && !pathKey(backups).startsWith(`${pathKey(requiredBackupRoot)}${path.sep}`)) {
    throw new Error('Backups must remain inside external AppData/.wayfarer/backups.');
  }
  await assertNoLinks(backups, { directory: true });
  if ([localPath, externalPath].some((save) => overlaps(save, backups)) || overlaps(localPath, externalPath)) {
    throw new Error('Save locations and backup folders must not overlap.');
  }
  const resources = [localPath, externalPath];
  if ([...activeTransfers].some((active) => resources.some((save) => overlaps(active, save)))) {
    throw new Error('A transfer for this save is already running.');
  }
  resources.forEach((save) => activeTransfers.add(save));
  const id = randomUUID(), at = Date.now();
  const source = direction === 'to-drive' ? localPath : externalPath;
  const destination = direction === 'to-drive' ? externalPath : localPath;
  const stage = path.join(path.dirname(destination), `.wayfarer-stage-${id}`);
  const rollback = path.join(path.dirname(destination), `.wayfarer-rollback-${id}`);
  let stageCreated = false, displaced = false, backupPath, backupTransaction, backupVerified = false;
  try {
    await onProgress(`Checking ${gameName} saves…`);
    const [local, external] = await Promise.all([snapshot(localPath), snapshot(externalPath)]);
    for (const item of [local, external]) if (item.error) throw new Error(item.error);
    if (!expectedToken || comparisonToken(local, external) !== expectedToken) throw new Error('The saves changed since the last refresh. Refresh and compare again.');
    const sourceSnapshot = direction === 'to-drive' ? local : external;
    const destinationSnapshot = direction === 'to-drive' ? external : local;
    if (!sourceSnapshot.exists || !sourceSnapshot.files) throw new Error('The source save is missing or empty. An empty source will never overwrite a save.');
    await ensureDirectory(path.dirname(destination));
    await onProgress(`Staging ${sourceSnapshot.files} file${sourceSnapshot.files === 1 ? '' : 's'} for ${gameName}…`);
    stageCreated = true;
    await copyEntry(source, stage);
    const staged = await snapshot(stage);
    if (staged.error || staged.fingerprint !== sourceSnapshot.fingerprint) throw new Error('The source save changed during staging. Refresh before transferring.');
    const assertUnchanged = async () => {
      const [nowLocal, nowExternal] = await Promise.all([snapshot(localPath), snapshot(externalPath)]);
      if (nowLocal.error || nowExternal.error || comparisonToken(nowLocal, nowExternal) !== expectedToken) {
        throw new Error('A save changed while the transfer was being prepared. Nothing was overwritten; refresh and try again.');
      }
    };
    await onProgress('Staged save; verifying both locations…');
    await assertUnchanged();
    if (destinationSnapshot.exists) {
      await onProgress('Backing up the existing destination to the external drive…');
      const label = String(gameName).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'Game';
      backupTransaction = await safeResolve(backups, `${new Date(at).toISOString().replace(/[:.]/g, '-')}-${label}-${id}`);
      backupPath = await safeResolve(backupTransaction, [root, ...relativeParts(relativePath)].join('/'));
      await ensureDirectory(path.dirname(backupPath));
      await copyEntry(destination, backupPath);
      const backedUp = await snapshot(backupPath);
      if (backedUp.error || backedUp.fingerprint !== destinationSnapshot.fingerprint) throw new Error('The destination changed during backup. Nothing was overwritten.');
      await fs.writeFile(path.join(backupTransaction, 'metadata.json'), JSON.stringify({ id, at, gameName, root, relativePath,
        direction, originalPath: destination, fingerprint: destinationSnapshot.fingerprint }, null, 2), { flag: 'wx' });
      backupVerified = true;
    }
    await onProgress('Backup ready; checking for changes before replacement…');
    await assertUnchanged();
    await Promise.all([assertNoLinks(source), assertNoLinks(destination), assertNoLinks(stage)]);
    if (destinationSnapshot.exists) {
      await fs.rename(destination, rollback);
      displaced = true;
    }
    try {
      await fs.rename(stage, destination);
      stageCreated = false;
    } catch (commitError) {
      if (displaced) {
        try {
          if (await statOrNull(destination)) throw new Error('Another process created the destination during replacement.');
          await fs.rename(rollback, destination);
          displaced = false;
        } catch (restoreError) {
          throw new Error(`Replacement failed and automatic rollback could not finish: ${messageOf(restoreError)}. Your original save remains at ${rollback}; external backup: ${backupPath}.`);
        }
      }
      throw new Error(`Could not replace the save; ${destinationSnapshot.exists ? 'the original destination was restored' : 'no existing save was overwritten'}. ${messageOf(commitError)}`);
    }
    if (displaced) {
      try { await removeOwnedTemporary(rollback); displaced = false; }
      catch { }
    }
    try { await onProgress(`Transferred ${gameName}. Your previous save is ${backupPath ? 'retained in Backups' : 'unchanged (no previous destination)'}.`); } catch { }
    return { id, at, gameName, root, relativePath, direction, files: sourceSnapshot.files, bytes: sourceSnapshot.bytes,
      ...(backupPath ? { backupPath } : {}) };
  } finally {
    if (stageCreated) { try { await removeOwnedTemporary(stage); } catch { } }
    if (backupTransaction && !backupVerified) { try { await removeOwnedTemporary(backupTransaction); } catch { } }
    resources.forEach((save) => activeTransfers.delete(save));
  }
}

export { ensureDirectory, copyEntry, assertNoLinks, removeOwnedTemporary };
