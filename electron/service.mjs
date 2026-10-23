import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { discoverGames } from './discovery.mjs';
import { snapshot, compareSnapshots, comparisonToken, safeResolve, transferSave } from './sync.mjs';
import { normalizeSaveLocation } from './save-location.mjs';
import { captureCandidate, candidatePath, verifyCandidate, applyCandidate } from './edition-saves.mjs';

export const ROOTS = ['Local', 'LocalLow', 'Roaming'];
const emptyConfig = () => ({ gamesRoot: '', externalRoot: '', coverArt: true });
const emptyLibrary = () => ({ customMappings: [], manualGames: [], sharedGroups: [], ignoredMappings: [], confirmedMappings: [], baselines: {}, history: [] });

export function encodePortablePath(base, target, api = path) {
  if (!target) return '';
  if (api.parse(base).root.toLowerCase() === api.parse(target).root.toLowerCase()) {
    return { relative: api.relative(base, target) || '.' };
  }
  return { absolute: target };
}
export function decodePortablePath(base, value, api = path) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.relative === 'string') return api.resolve(base, value.relative);
  if (typeof value.absolute === 'string') return api.resolve(value.absolute);
  throw new Error('Invalid portable folder setting. Select your folders again.');
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}. Keep this file for recovery; it has not been replaced.`);
  }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
const contains = (a, b) => {
  const relative = path.relative(path.resolve(a).normalize('NFC').toLowerCase(), path.resolve(b).normalize('NFC').toLowerCase());
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
async function existingDirectory(value, name) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`Choose an absolute ${name} folder.`);
  const resolved = path.resolve(value);
  await safeResolve(resolved, '.wayfarer-path-check');
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${name} must be a folder.`);
  return resolved;
}
function normalizedKey(root, relativePath) { return `${root}/${relativePath.replaceAll('\\', '/').toLowerCase()}`; }

export class VaultService {
  constructor({ portableDir, localRoots, isWindows = process.platform === 'win32', onProgress = () => {}, allowNonWindows = false }) {
    this.portableDir = portableDir;
    this.localRoots = localRoots;
    this.isWindows = isWindows;
    this.allowNonWindows = allowNonWindows;
    this.onProgress = onProgress;
    this.config = emptyConfig();
    this.library = emptyLibrary();
    this.games = [];
    this.warnings = [];
    this.scannedAt = null;
    this.busy = false;
    this.verifiedThisSession = new Map();
    this.machine = createHash('sha256').update(`${os.hostname()}|${os.userInfo().username}|${JSON.stringify(localRoots)}`).digest('hex').slice(0, 20);
  }
  async initialize() {
    const configPath = await safeResolve(path.join(this.portableDir, '.wayfarer'), 'config.json');
    const saved = await readJson(configPath, null);
    if (saved) this.config = {
      gamesRoot: decodePortablePath(this.portableDir, saved.gamesRoot),
      externalRoot: decodePortablePath(this.portableDir, saved.externalRoot),
      coverArt: saved.coverArt !== false,
    };
    return this;
  }
  async exclusive(action, kind = 'working') {
    if (this.busy) throw new Error('Another scan or transfer is still running. Please wait.');
    this.busy = true;
    this.operation = kind;
    try { return await action(); } finally { this.busy = false; this.operation = null; }
  }
  state() {
    return { config: this.config, localRoots: this.localRoots, games: this.games, history: this.library.history, sharedGroups: this.library.sharedGroups.map(group => ({ ...group, verifications: group.verifications.filter(v => v.machine === this.machine && this.matchesSharedProof(group.id, v)) })),
      isWindows: this.isWindows, demo: false, warnings: this.warnings, scannedAt: this.scannedAt };
  }
  async getState() {
    if (this.config.gamesRoot && this.config.externalRoot && !this.scannedAt) await this.refresh();
    return this.state();
  }
  async saveSettings(config) {
    return this.exclusive(async () => {
      const gamesRoot = await existingDirectory(config.gamesRoot, 'game library');
      const externalRoot = await existingDirectory(config.externalRoot, 'external AppData');
      if (contains(externalRoot, gamesRoot) || contains(gamesRoot, externalRoot)) throw new Error('Your game library and external AppData folders must be separate, without one inside the other.');
      for (const local of Object.values(this.localRoots)) {
        if (contains(local, externalRoot) || contains(externalRoot, local) || contains(local, gamesRoot) || contains(gamesRoot, local)) {
          throw new Error('Choose folders on your external drive, separate from this computer’s AppData.');
        }
      }
      const library = await this.readLibrary(externalRoot);
      const next = { gamesRoot, externalRoot, coverArt: config.coverArt !== false };
      await writeJson(await safeResolve(path.join(this.portableDir, '.wayfarer'), 'config.json'), {
        version: 1, gamesRoot: encodePortablePath(this.portableDir, gamesRoot),
        externalRoot: encodePortablePath(this.portableDir, externalRoot), coverArt: next.coverArt,
      });
      if (next.gamesRoot !== this.config.gamesRoot || next.externalRoot !== this.config.externalRoot) this.verifiedThisSession.clear();
      this.config = next;
      this.library = library;
      await this.scan();
      return this.state();
    });
  }
  async readLibrary(externalRoot = this.config.externalRoot) {
    const saved = await readJson(await safeResolve(externalRoot, '.wayfarer/library.json'), emptyLibrary());
    saved.manualGames ??= [];
    saved.sharedGroups ??= [];
    if (!Array.isArray(saved.customMappings) || !Array.isArray(saved.ignoredMappings) || !Array.isArray(saved.confirmedMappings)
      || !Array.isArray(saved.history) || !Array.isArray(saved.manualGames) || !Array.isArray(saved.sharedGroups) || saved.sharedGroups.some(g => !g || !Array.isArray(g.members) || !Array.isArray(g.candidates) || !Array.isArray(g.verifications)) || !saved.baselines || typeof saved.baselines !== 'object') {
      throw new Error('The drive’s Wayfarer library metadata is invalid. Keep .wayfarer/library.json for recovery.');
    }
    return saved;
  }
  async saveLibrary() {
    await writeJson(await safeResolve(this.config.externalRoot, '.wayfarer/library.json'), this.library);
  }
  async refresh() { return this.exclusive(() => this.scan()); }
  async scan() {
    this.games = [];
    this.warnings = [];
    if (!this.config.gamesRoot || !this.config.externalRoot) return { games: [], warnings: [], scannedAt: null };
    try {
      await existingDirectory(this.config.gamesRoot, 'game library');
      await existingDirectory(this.config.externalRoot, 'external AppData');
    } catch (error) {
      this.warnings = [`Drive unavailable: ${error.message}. Reconnect the drive or update your folders in Settings.`];
      this.scannedAt = Date.now();
      return { games: [], warnings: this.warnings, scannedAt: this.scannedAt };
    }
    this.library = await this.readLibrary();
    const { games, warnings } = await discoverGames({ ...this.config, localRoots: this.localRoots,
      customMappings: this.library.customMappings, manualGames: this.library.manualGames, ignoredMappings: this.library.ignoredMappings,
      confirmedMappings: this.library.confirmedMappings, onProgress: this.onProgress });
    this.warnings = warnings;
    if (!this.isWindows) this.warnings.push('This is a non-Windows development session. Real transfers are available on Windows.');
    const cache = new Map();
    const snap = async file => {
      if (!cache.has(file)) cache.set(file, snapshot(file));
      return cache.get(file);
    };
    for (const game of games) {
      this.onProgress(`Comparing saves · ${game.name}`);
      game.coverUrl = this.config.coverArt && Number.isSafeInteger(Number(game.steamId)) && Number(game.steamId) > 0
        ? `https://cdn.akamai.steamstatic.com/steam/apps/${game.steamId}/library_600x900.jpg` : undefined;
      for (const mapping of game.mappings) {
        try {
          if (!ROOTS.includes(mapping.root)) throw new Error('Invalid AppData section.');
          mapping.localPath = await safeResolve(this.localRoots[mapping.root], mapping.relativePath);
          mapping.externalPath = await safeResolve(this.config.externalRoot, `${mapping.root}/${mapping.relativePath}`);
          [mapping.local, mapping.external] = await Promise.all([snap(mapping.localPath), snap(mapping.externalPath)]);
          const baseline = this.library.baselines[`${this.machine}:${mapping.id}`];
          mapping.status = compareSnapshots(mapping.local, mapping.external, baseline);
          mapping.token = comparisonToken(mapping.local, mapping.external);
          mapping.error = mapping.local.error || mapping.external.error;
        } catch (error) {
          mapping.status = 'error'; mapping.error = error.message; mapping.token = '';
          mapping.local = mapping.external = { exists: false, files: 0, bytes: 0, newest: null, fingerprint: '', error: error.message };
        }
      }
    }
    const all = games.flatMap(game => game.mappings.map(mapping => ({ game, mapping })));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const sharedSides = ['local', 'external'].filter(side => {
        const left = a.mapping[`${side}Path`], right = b.mapping[`${side}Path`];
        return left && right && (contains(left, right) || contains(right, left));
      });
      if (sharedSides.length) {
        const exact = sharedSides.every(side => contains(a.mapping[`${side}Path`], b.mapping[`${side}Path`]) && contains(b.mapping[`${side}Path`], a.mapping[`${side}Path`]));
        if (exact && ((a.game.identity && a.game.identity === b.game.identity) || (a.mapping.confidence === 'manual' && b.mapping.confidence === 'manual'))) {
          for (const [item, other] of [[a, b], [b, a]]) {
            item.mapping.sharedWith = [...new Set([...(item.mapping.sharedWith || []), other.game.name])];
            item.mapping.sharedOn ??= { local: [], external: [] };
            for (const side of sharedSides) item.mapping.sharedOn[side] = [...new Set([...item.mapping.sharedOn[side], other.game.name])];
          }
          continue;
        }
        const manual = [a, b].filter(item => item.mapping.confidence === 'manual');
        const blocked = manual.length === 1 ? [a, b].filter(item => item !== manual[0]) : [a, b];
        for (const item of blocked) { item.mapping.status = 'error'; item.mapping.error = manual.length === 1 ? `This automatic match conflicts with a location assigned manually to ${manual[0].game.name}. Correct or remove this automatic match.` : 'This save path overlaps another mapping. Select a game-specific folder or remove the incorrect mapping.'; }
      }
    }
    this.games = games;
    for (const [key, session] of this.verifiedThisSession) if (!this.matchesSharedProof(session.groupId, session.verification)) this.verifiedThisSession.delete(key);
    this.scannedAt = Date.now();
    return { games: this.games, warnings: this.warnings, scannedAt: this.scannedAt };
  }
  findGame(id) {
    const game = this.games.find(game => game.id === id);
    if (!game) throw new Error('Game no longer available. Refresh your library.');
    return game;
  }
  findMapping(gameId, mappingId) {
    const game = this.findGame(gameId);
    const mapping = game.mappings.find(mapping => mapping.id === mappingId);
    if (!mapping) throw new Error('Save mapping no longer available. Refresh your library.');
    return { game, mapping };
  }
  async transfer({ gameId, mappingId, direction, expectedToken }) {
    return this.exclusive(async () => {
      if (!this.isWindows && !this.allowNonWindows) throw new Error('Run the portable Windows app to transfer real saves.');
      const { game, mapping } = this.findMapping(gameId, mappingId);
      if (!mapping.confirmed && mapping.confidence === 'suggested') throw new Error('Review and confirm this suggested save folder first.');
      if (mapping.status === 'error') throw new Error(mapping.error || 'This mapping cannot be transferred.');
      if (expectedToken !== mapping.token) throw new Error('This comparison is out of date. Refresh first.');
      await existingDirectory(this.config.externalRoot, 'external AppData');
      await existingDirectory(this.config.gamesRoot, 'game library');
      const record = await transferSave({ localRoot: this.localRoots[mapping.root], externalRoot: this.config.externalRoot,
        root: mapping.root, relativePath: mapping.relativePath, direction, expectedToken, gameName: game.name,
        backupRoot: path.join(this.config.externalRoot, '.wayfarer', 'backups'), onProgress: this.onProgress });
      record.gameName = game.name; record.root = mapping.root; record.relativePath = mapping.relativePath;
      this.library.history.unshift(record);
      this.library.history = this.library.history.slice(0, 500);
      const source = direction === 'to-drive' ? mapping.local : mapping.external;
      this.library.baselines[`${this.machine}:${mapping.id}`] = { local: source.fingerprint, external: source.fingerprint };
      let metadataWarning;
      try { await this.saveLibrary(); } catch (error) { metadataWarning = `Transfer completed, but history could not be saved: ${error.message}`; }
      const result = await this.scan();
      if (metadataWarning) result.warnings.push(metadataWarning);
      return result;
    }, 'transfer');
  }
  normalizeLocation(input, root = 'Local') {
    return normalizeSaveLocation({ root, input, localRoots: this.localRoots, externalRoot: this.config.externalRoot });
  }
  async addMapping({ gameId, root, relativePath, replaceAuto = true }) {
    return this.exclusive(async () => {
      this.findGame(gameId);
      ({ root, relativePath } = this.normalizeLocation(relativePath, root));
      if (/^(microsoft|packages|temp|google|nvidia|discord|\.wayfarer)$/i.test(relativePath)) throw new Error('Choose a specific game subfolder, not a shared application folder.');
      const local = await safeResolve(this.localRoots[root], relativePath);
      const external = await safeResolve(this.config.externalRoot, `${root}/${relativePath}`);
      const found = await Promise.all([fs.lstat(local).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), fs.lstat(external).catch(error => { if (error.code === 'ENOENT') return null; throw error; })]);
      if (!found.some(Boolean)) throw new Error('That save path does not exist on this computer or the external drive. Check the relative path.');
      const key = normalizedKey(root, relativePath);
      this.library.customMappings = this.library.customMappings.filter(item => !(item.gameId === gameId && normalizedKey(item.root, item.relativePath) === key));
      this.library.customMappings.push({ gameId, root, relativePath, replaceAuto: replaceAuto !== false });
      await this.saveLibrary();
      return this.scan();
    });
  }
  async addGame({ installPath, name }) {
    return this.exclusive(async () => {
      if (!this.config.gamesRoot || !this.config.externalRoot) throw new Error('Choose your game library and external AppData folders in Settings first.');
      await existingDirectory(this.config.gamesRoot, 'game library');
      await existingDirectory(this.config.externalRoot, 'external AppData');
      if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Enter a game name of 1–200 characters.');
      const install = await existingDirectory(installPath, 'game installation');
      if (!contains(this.config.gamesRoot, install)) throw new Error('Choose an installation inside your configured games folder.');
      const relativeInstallPath = path.relative(this.config.gamesRoot, install).split(path.sep).join('/') || '.';
      for (const [key, session] of this.verifiedThisSession) if ([session.sourceGameId, session.targetGameId].some(id => this.games.find(game => game.id === id)?.relativeInstallPath.toLowerCase() === relativeInstallPath.toLowerCase())) this.verifiedThisSession.delete(key);
      this.library.manualGames = this.library.manualGames.filter(game => game.relativeInstallPath.toLowerCase() !== relativeInstallPath.toLowerCase());
      this.library.manualGames.push({ relativeInstallPath, name: name.trim() });
      await this.saveLibrary(); await this.scan(); return this.state();
    });
  }
  findShared(groupId, candidateId, memberId) {
    const group = this.library.sharedGroups.find(group => group.id === groupId);
    if (!group) throw new Error('Shared-save group not found.');
    const candidate = candidateId && group.candidates.find(candidate => candidate.id === candidateId);
    const member = memberId && group.members.find(member => member.id === memberId);
    if (candidateId && !candidate) throw new Error('Shared copy not found.');
    if (memberId && !member) throw new Error('Edition not found in this group.');
    return { group, candidate, member };
  }
  sharedTarget(member, side) {
    if (!['local', 'external'].includes(side)) throw new Error('Choose this PC or the external drive.');
    const { game, mapping } = this.findMapping(member.gameId, member.mappingId);
    if (mapping.error || mapping.status === 'error') throw new Error(mapping.error || 'Resolve this save mapping first.');
    if (!mapping.confirmed) throw new Error('Confirm the save mapping before linking editions.');
    return { game, mapping, destinationPath: side === 'local' ? mapping.localPath : mapping.externalPath, destinationRoot: side === 'local' ? this.localRoots[mapping.root] : path.join(this.config.externalRoot, mapping.root) };
  }
  matchesSharedProof(groupId, verification) {
    if (!verification) return false;
    const session = this.verifiedThisSession.get(`${groupId}:${verification.candidateId}:${verification.memberId}:${verification.side}`);
    const fields = ['candidateId', 'memberId', 'side', 'fingerprint', 'destinationToken', 'targetPath', 'at', 'machine'];
    if (!session || !fields.every(field => session.verification[field] === verification[field])) return false;
    try {
      const { group, candidate, member } = this.findShared(groupId, verification.candidateId, verification.memberId);
      const context = this.sharedProofContext(group, candidate, member, verification.side);
      return session.sourceEndpoint === context.sourceEndpoint && session.targetEndpoint === context.targetEndpoint && session.sourceLocator === context.sourceLocator && context.observedTargetToken === verification.destinationToken;
    } catch { return false; }
  }
  sharedProofContext(group, candidate, member, side) {
    const sourceMember = group.members.find(item => item.id === candidate.sourceMemberId);
    if (!sourceMember) throw new Error('The captured source edition is unavailable. Capture and test a new copy.');
    const descriptor = (edition, locationSide) => {
      const { game, mapping, destinationPath } = this.sharedTarget(edition, locationSide);
      return JSON.stringify([edition.id, game.id, game.name, game.identity || null, game.edition || 'unknown', game.relativeInstallPath,
        path.resolve(game.installPath).normalize('NFC').toLowerCase(), mapping.id, mapping.root,
        mapping.relativePath.replaceAll('\\', '/').normalize('NFC').toLowerCase(), path.resolve(destinationPath).normalize('NFC').toLowerCase()]);
    };
    const { mapping } = this.sharedTarget(member, side);
    const targetSnapshot = side === 'local' ? mapping.local : mapping.external;
    return { sourceGameId: sourceMember.gameId, targetGameId: member.gameId,
      sourceEndpoint: descriptor(sourceMember, candidate.sourceSide), targetEndpoint: descriptor(member, side),
      sourceLocator: JSON.stringify([candidate.sourceMemberId, candidate.sourceSide, candidate.sourceRoot, candidate.sourceRelativePath]),
      observedTargetToken: comparisonToken(targetSnapshot, targetSnapshot) };
  }
  async sharedSourcePath(group, candidate) {
    if (ROOTS.includes(candidate.sourceRoot) && typeof candidate.sourceRelativePath === 'string' && ['local', 'external'].includes(candidate.sourceSide)) {
      const sourceRoot = candidate.sourceSide === 'local' ? this.localRoots[candidate.sourceRoot] : path.join(this.config.externalRoot, candidate.sourceRoot);
      return safeResolve(sourceRoot, candidate.sourceRelativePath);
    }
    const member = group.members.find(member => member.id === candidate.sourceMemberId);
    if (!member) throw new Error('The captured source location is unavailable. Capture a new shared copy before applying it.');
    return this.sharedTarget(member, candidate.sourceSide).destinationPath;
  }
  async requireIndependentSharedTarget(group, candidate, destinationPath) {
    const sourcePath = await this.sharedSourcePath(group, candidate);
    if (contains(sourcePath, destinationPath) || contains(destinationPath, sourcePath)) throw new Error('These editions already use the same or overlapping save location. No copy is needed; the source stays protected.');
    return sourcePath;
  }
  async linkEditions({ name, members }) {
    return this.exclusive(async () => {
      if (typeof name !== 'string' || !name.trim() || name.length > 200 || !Array.isArray(members) || members.length < 2 || members.length > 10) throw new Error('Give the group a name and choose 2–10 edition save locations.');
      const unique = new Set();
      const linked = members.map(item => {
        const identity = `${item.gameId}:${item.mappingId}`;
        if (unique.has(identity)) throw new Error('Choose different save locations for each edition.');
        unique.add(identity);
        const member = { id: randomUUID(), gameId: item.gameId, mappingId: item.mappingId, label: String(item.label || '').slice(0, 200) };
        const { game } = this.sharedTarget(member, 'local');
        member.label ||= game.name;
        return member;
      });
      this.library.sharedGroups.push({ id: randomUUID(), name: name.trim(), members: linked, candidates: [], verifications: [] });
      await this.saveLibrary(); return this.state();
    });
  }
  async captureShared({ groupId, memberId, side, expectedToken }) {
    return this.exclusive(async () => {
      const { group, member } = this.findShared(groupId, null, memberId);
      const { mapping, destinationPath } = this.sharedTarget(member, side);
      if (expectedToken !== mapping.token) throw new Error('Refresh before capturing this save.');
      const candidate = await captureCandidate({ externalRoot: this.config.externalRoot, groupId, sourcePath: destinationPath, expectedSnapshot: side === 'local' ? mapping.local : mapping.external, onProgress: this.onProgress });
      group.candidates.unshift({ ...candidate, sourceMemberId: memberId, sourceSide: side, sourceRoot: mapping.root, sourceRelativePath: mapping.relativePath });
      await this.saveLibrary(); return this.state();
    }, 'transfer');
  }
  async verifyShared({ groupId, candidateId, memberId, side, tested }) {
    return this.exclusive(async () => {
      if (tested !== true) throw new Error('Confirm that this exact copy loaded successfully in the target edition using a separate test profile or copy.');
      const { group, candidate, member } = this.findShared(groupId, candidateId, memberId);
      const { destinationPath } = this.sharedTarget(member, side);
      const sourcePath = await this.requireIndependentSharedTarget(group, candidate, destinationPath);
      const proof = await verifyCandidate({ externalRoot: this.config.externalRoot, groupId, candidate, destinationPath });
      const context = this.sharedProofContext(group, candidate, member, side);
      if (context.observedTargetToken !== proof.destinationToken) throw new Error('The target changed since refresh. Refresh, inspect its latest save, and confirm the successful test again.');
      const verification = { ...proof, candidateId, memberId, side, at: Date.now(), machine: this.machine };
      group.verifications = group.verifications.filter(v => !(v.candidateId === candidateId && v.memberId === memberId && v.side === side));
      group.verifications.push(verification);
      await this.saveLibrary();
      this.verifiedThisSession.set(`${groupId}:${candidateId}:${memberId}:${side}`, { groupId, verification: structuredClone(verification), sourcePath, ...context });
      return this.state();
    });
  }
  async applyShared({ groupId, candidateId, memberId, side }) {
    return this.exclusive(async () => {
      if (!this.isWindows && !this.allowNonWindows) throw new Error('Run the Windows app to apply saves to an edition.');
      const { group, candidate, member } = this.findShared(groupId, candidateId, memberId);
      const { game, mapping, destinationPath, destinationRoot } = this.sharedTarget(member, side);
      const verification = group.verifications.find(v => v.candidateId === candidateId && v.memberId === memberId && v.side === side && v.machine === this.machine);
      if (!this.matchesSharedProof(groupId, verification)) throw new Error('Confirm a successful test of this exact copy for the target edition in this session. Originals are protected.');
      const sourcePath = await this.requireIndependentSharedTarget(group, candidate, destinationPath);
      const session = this.verifiedThisSession.get(`${groupId}:${candidateId}:${memberId}:${side}`);
      if (path.resolve(sourcePath).toLowerCase() !== path.resolve(session.sourcePath).toLowerCase()) throw new Error('The source mapping changed after testing. Capture a new shared copy and test it again.');
      const record = await applyCandidate({ externalRoot: this.config.externalRoot, groupId, candidate, destinationPath, destinationRoot, relativePath: mapping.relativePath, verification, gameName: game.name, root: mapping.root, side, onProgress: this.onProgress });
      this.verifiedThisSession.delete(`${groupId}:${candidateId}:${memberId}:${side}`);
      this.library.history.unshift(record);
      this.library.history = this.library.history.slice(0, 500);
      delete this.library.baselines[`${this.machine}:${mapping.id}`];
      let warning;
      try { await this.saveLibrary(); } catch (error) { warning = `Shared copy applied, but history could not be saved: ${error.message}`; }
      await this.scan();
      if (warning) this.warnings.push(warning);
      return this.state();
    }, 'transfer');
  }
  async resolveSharedPath({ groupId, candidateId }) {
    const { group, candidate } = this.findShared(groupId, candidateId);
    if (!candidate) throw new Error('Select a captured shared copy first.');
    const payload = await candidatePath({ externalRoot: this.config.externalRoot, groupId: group.id, candidateId: candidate.id });
    await fs.stat(payload);
    return path.dirname(payload);
  }
  async removeSharedGroup({ groupId }) {
    return this.exclusive(async () => {
      this.findShared(groupId);
      this.library.sharedGroups = this.library.sharedGroups.filter(group => group.id !== groupId);
      for (const key of this.verifiedThisSession.keys()) if (key.startsWith(`${groupId}:`)) this.verifiedThisSession.delete(key);
      await this.saveLibrary(); return this.state();
    });
  }
  async confirmMapping({ gameId, mappingId }) {
    return this.exclusive(async () => {
      this.findMapping(gameId, mappingId);
      if (!this.library.confirmedMappings.includes(mappingId)) this.library.confirmedMappings.push(mappingId);
      await this.saveLibrary(); return this.scan();
    });
  }
  async removeMapping({ gameId, mappingId }) {
    return this.exclusive(async () => {
      const { mapping } = this.findMapping(gameId, mappingId);
      this.library.customMappings = this.library.customMappings.filter(item => !(item.gameId === gameId && normalizedKey(item.root, item.relativePath) === normalizedKey(mapping.root, mapping.relativePath)));
      if (!this.library.ignoredMappings.includes(mappingId)) this.library.ignoredMappings.push(mappingId);
      await this.saveLibrary(); return this.scan();
    });
  }
  async resolveOpenPath({ target, gameId, mappingId }) {
    if (target === 'backups') {
      if (!this.config.externalRoot) throw new Error('Choose your external AppData folder first.');
      const folder = await safeResolve(this.config.externalRoot, '.wayfarer/backups');
      if (!(await fs.stat(folder).catch(() => null))) throw new Error('No backups yet. Backups are created when an existing save is replaced.');
      return folder;
    }
    if (target === 'game') {
      const game = this.findGame(gameId);
      if (game.relativeInstallPath === '.') return existingDirectory(this.config.gamesRoot, 'game library');
      return safeResolve(this.config.gamesRoot, game.relativeInstallPath);
    }
    const { mapping } = this.findMapping(gameId, mappingId);
    if (target === 'local') return safeResolve(this.localRoots[mapping.root], mapping.relativePath);
    if (target === 'external') return safeResolve(this.config.externalRoot, `${mapping.root}/${mapping.relativePath}`);
    throw new Error('Unknown folder target.');
  }
}
