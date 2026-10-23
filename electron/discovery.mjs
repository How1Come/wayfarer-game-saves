import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import picomatch from 'picomatch';

const ROOTS = ['Local', 'LocalLow', 'Roaming'];
const MAGIC = /[*?\[\]{}!()]/;
const SKIP_GAME_DIRS = /^(?:\.git|\.wayfarer|node_modules|\$RECYCLE\.BIN|System Volume Information|_?CommonRedist|redist|redistributables|DirectX|DotNet|vcredist|__Installer)$/i;
const ENGINE_DIRS = /^(?:Binaries|Bin|Win32|Win64|x86|x64|Game|Windows|WindowsNoEditor)$/i;
const NON_GAME_EXE = /^(?:unins\d*|uninstall.*|setup.*|install.*|dxsetup|vcredist.*|vc_redist.*|dotnet.*|crash.*|UnityCrashHandler.*|UE[45]Prereq.*|EAC.*|EasyAntiCheat.*|BattlEye.*|REDprelauncher|7z.*|wayfarer.*|steam|steamwebhelper|EpicGamesLauncher|GalaxyClient|Origin|EA|UbisoftConnect|launcher|launch|start|UnrealCEFSubProcess|UnrealEditor.*|UE4Editor.*|UnrealPak|ShaderCompileWorker|BootstrapPackagedGame|EOSOverlayRenderer.*)$/i;
const GAME_INTERNAL_DIRS = /^(?:Binaries|Bin|Win32|Win64|x86|x64|Game|Windows|WindowsNoEditor|Engine|Content|Data|Resources|Plugins|Managed|Support|Tools|Extras|Movies|Audio|StreamingAssets|.*_Data)$/i;
const GENERIC_EXE = /^(?:game|start|launch|launcher|runner|main|win32|win64|rpg|nw|python|javaw?|ue[45]game|start_protected_game)$/i;
const SKIP_SAVE_DIRS = /^(?:\.wayfarer|\.git|node_modules|Temp|INetCache|INetCookies|GPUCache|Code Cache|Cache|Caches|cache2|CrashDumps|D3DSCache|ShaderCache|Service Worker)$/i;
const SKIP_SAVE_TOP = /^(?:Microsoft|Google|Mozilla|Opera Software|BraveSoftware|NVIDIA|NVIDIA Corporation|AMD|Discord|Slack|Teams|Docker|pip|npm|NuGet|VisualStudio)$/i;
const normalize = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const stableId = value => createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 20);
export const mappingId = (gameId, root, relativePath) => stableId(`${gameId}:${root}/${cleanRelative(relativePath)}`);
const portable = value => value.split(path.sep).join('/');
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const overlaps = (left, right) => left.root === right.root && (left.relativePath.toLowerCase() === right.relativePath.toLowerCase() || left.relativePath.toLowerCase().startsWith(right.relativePath.toLowerCase() + '/') || right.relativePath.toLowerCase().startsWith(left.relativePath.toLowerCase() + '/'));
const identityFor = entry => entry ? `ludusavi:${entry.name}` : undefined;

function titleWithoutSuffix(value) {
  let previous;
  let result = value.trim();
  do {
    previous = result;
    result = result.replace(/\s*[([_\-]\s*(?:steam|gog(?:\.com)?|epic|stand-?alone|portable|pc|windows|v(?:ersion)?\s*\d+(?:\.\d+)+(?:[-._a-z0-9]*))\s*[)\]]?\s*$/i, '').replace(/\s+(?:stand-?alone|portable|v(?:ersion)?\s*\d+(?:\.\d+)+(?:[-._a-z0-9]*))\s*$/i, '').trim();
  } while (result && result !== previous);
  return result || value;
}

async function smallText(directory, relative, limit = 16_384) {
  if (!await noLinks(directory, relative)) return null;
  let handle;
  try {
    handle = await fs.open(path.join(directory, ...relative.split('/')), 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead <= limit ? buffer.subarray(0, bytesRead).toString('utf8') : null;
  } catch { return null; }
  finally { await handle?.close(); }
}

async function installationMetadata(directory, entries) {
  const result = { edition: 'unknown', editionEvidence: [] };
  for (const item of entries) {
    if (item.isDirectory() && !item.isSymbolicLink() && /_Data$/i.test(item.name)) {
      const text = await smallText(directory, `${item.name}/app.info`);
      if (text) {
        const [company, product] = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(x => x.trim());
        if (company && product && company.length <= 200 && product.length <= 200 && !/[\x00-\x1f/\\]/.test(company + product)) {
          try { cleanRelative(`${company}/${product}`); result.unity = { company, product }; } catch {}
        }
      }
    }
    if (item.isFile() && /^goggame-\d+\.info$/i.test(item.name)) {
      const text = await smallText(directory, item.name);
      try {
        const metadata = text && JSON.parse(text);
        if (metadata && /^\d+$/.test(String(metadata.gameId)) && item.name.toLowerCase() === `goggame-${metadata.gameId}.info` && typeof metadata.name === 'string' && metadata.name.trim()) {
          result.gogName = metadata.name.trim(); result.edition = 'standalone'; result.editionEvidence = [`GOG installation metadata: ${item.name}`];
        }
      } catch {}
    }
  }
  return result;
}

async function installationRoot(directory, gamesRoot) {
  let result = directory;
  while (result !== gamesRoot && ENGINE_DIRS.test(path.basename(result)) && inside(gamesRoot, path.dirname(result))) result = path.dirname(result);
  if (result !== directory && result !== gamesRoot) {
    const parent = path.dirname(result);
    try {
      const entries = await fs.readdir(parent, { withFileTypes: true });
      if (inside(gamesRoot, parent) && entries.some(x => x.isDirectory() && !x.isSymbolicLink() && x.name.toLowerCase() === 'engine')) result = parent;
    } catch {}
  }
  return result;
}

function cleanRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[\\/]/.test(value) || /:/.test(value)) throw new Error('Expected a path inside an AppData subfolder.');
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some(x => !x || x === '.' || x === '..' || /[<>:"|?*]/.test(x) || /[. ]$/.test(x))) throw new Error('Invalid relative save path.');
  return segments.join('/');
}

let catalogPromise;
async function loadCatalog() {
  if (!catalogPromise) catalogPromise = fs.readFile(new URL('../data/catalog.json', import.meta.url), 'utf8').then(JSON.parse).then(catalog => {
    const byName = new Map(), byExe = new Map(), bySteam = new Map();
    const add = (map, key, value) => { if (!key) return; if (!map.has(key)) map.set(key, []); if (!map.get(key).includes(value)) map.get(key).push(value); };
    for (const entry of catalog.games) {
      for (const name of [entry.name, ...entry.installDirs]) add(byName, normalize(name), entry);
      for (const exe of entry.executables) {
        const stem = exe.replace(/\.exe$/i, '');
        if (normalize(stem).length > 3 && !GENERIC_EXE.test(stem) && !NON_GAME_EXE.test(stem)) add(byExe, normalize(stem), entry);
      }
      for (const id of entry.steamIds) add(bySteam, String(id), entry);
    }
    return { ...catalog, byName, byExe, bySteam };
  });
  return catalogPromise;
}

async function safeDirectory(directory) {
  const stat = await fs.lstat(directory);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function parseAcf(text) {
  const values = {};
  for (const [, key, value] of text.matchAll(/"([^"\\]+)"\s*"((?:[^"\\]|\\.)*)"/g)) values[key.toLowerCase()] = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const steamId = Number(values.appid);
  if (!Number.isInteger(steamId) || steamId <= 0 || !values.installdir) return null;
  let relative;
  try { relative = cleanRelative(values.installdir); } catch { return null; }
  return { steamId, name: values.name || values.installdir, relative };
}

async function discoverInstalls(gamesRoot, catalog, warnings, onProgress) {
  const found = new Map();
  const rel = directory => portable(path.relative(gamesRoot, directory)) || '.';
  const add = (directory, { entry, name, steamId, source, inferred = false, inferenceReason, edition = 'unknown', editionEvidence = [], unity }) => {
    if (!inside(gamesRoot, directory)) return;
    const key = directory.toLowerCase();
    if (found.has(key)) {
      if (unity) found.get(key)._unity = unity;
      return;
    }
    found.set(key, { id: stableId(`game:${rel(directory)}`), name: inferred ? name || path.basename(directory) : entry?.name || name || path.basename(directory), installPath: directory, relativeInstallPath: rel(directory), ...(steamId || entry?.steamIds[0] ? { steamId: steamId || entry.steamIds[0] } : {}), ...(entry && !inferred ? { identity: identityFor(entry) } : {}), edition, editionEvidence, source, mappings: [], _entry: entry, _inferred: inferred, _inferenceReason: inferenceReason, _unity: unity });
  };
  const readSteam = async steamapps => {
    let entries;
    try { if (!await safeDirectory(steamapps)) return; entries = await fs.readdir(steamapps, { withFileTypes: true }); } catch { return; }
    for (const item of entries) if (item.isFile() && /^appmanifest_\d+\.acf$/i.test(item.name)) {
      try {
        const text = await smallText(steamapps, item.name, 128_000);
        const info = text && parseAcf(text);
        if (!info) continue;
        const installPath = path.join(steamapps, 'common', ...info.relative.split('/'));
        if (!inside(gamesRoot, installPath) || !await noLinks(gamesRoot, portable(path.relative(gamesRoot, installPath))) || !await safeDirectory(installPath)) continue;
        const matches = catalog.bySteam.get(String(info.steamId)) || [];
        add(installPath, { entry: matches.length === 1 ? matches[0] : undefined, name: info.name, steamId: info.steamId, source: 'Steam library', edition: 'steam', editionEvidence: [`Steam library manifest: ${item.name}`] });
      } catch (error) { if (error.code !== 'ENOENT') warnings.add(`Could not read Steam manifest ${item.name}: ${error.message}`); }
    }
  };
  if (path.basename(gamesRoot).toLowerCase() === 'common' && path.basename(path.dirname(gamesRoot)).toLowerCase() === 'steamapps') await readSteam(path.dirname(gamesRoot));
  const queue = [gamesRoot];
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const directory = queue[cursor];
    const owner = [...found.values()].find(game => directory !== game.installPath && inside(game.installPath, directory));
    if (owner && path.relative(owner.installPath, directory).split(path.sep).some(x => GAME_INTERNAL_DIRS.test(x))) continue;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { warnings.add(`Skipped unreadable game folder ${directory}: ${error.code || error.message}`); continue; }
    if (++visited % 100 === 0) onProgress(`Looking for games · ${visited.toLocaleString()} folders checked`);
    if (entries.some(x => x.isFile() && /^appmanifest_\d+\.acf$/i.test(x.name))) await readSteam(directory);
    const executables = entries.filter(x => x.isFile() && /\.exe$/i.test(x.name) && !NON_GAME_EXE.test(x.name.slice(0, -4)));
    const childDirs = entries.filter(x => x.isDirectory() && !x.isSymbolicLink() && !SKIP_GAME_DIRS.test(x.name) && x.name.toLowerCase() !== 'engine');
    if (executables.length) {
      const installPath = await installationRoot(directory, gamesRoot);
      let installEntries = entries;
      if (installPath !== directory) {
        try { installEntries = await fs.readdir(installPath, { withFileTypes: true }); } catch {}
      }
      const metadata = await installationMetadata(installPath, installEntries);
      let steamId;
      const steamFile = installEntries.find(x => x.isFile() && x.name.toLowerCase() === 'steam_appid.txt') || entries.find(x => x.isFile() && x.name.toLowerCase() === 'steam_appid.txt');
      if (steamFile) {
        const sourceDirectory = installEntries.includes(steamFile) ? installPath : directory;
        const value = (await smallText(sourceDirectory, steamFile.name, 64))?.trim();
        if (value && /^\d{1,10}$/.test(value) && Number(value) > 0) steamId = Number(value);
      }
      let inferred = false;
      let inferenceReason;
      let candidates = steamId ? catalog.bySteam.get(String(steamId)) || [] : [];
      if (candidates.length !== 1 && metadata.gogName) candidates = catalog.byName.get(normalize(metadata.gogName)) || [];
      if (candidates.length !== 1) candidates = catalog.byName.get(normalize(path.basename(installPath))) || [];
      if (candidates.length !== 1 && metadata.unity) {
        candidates = catalog.byName.get(normalize(metadata.unity.product)) || [];
        if (candidates.length === 1) {
          const namespace = `${metadata.unity.company}/${metadata.unity.product}`.toLowerCase();
          inferred = !candidates[0].rules.some(rule => rule.root === 'LocalLow' && (rule.pattern.toLowerCase() === namespace || rule.pattern.toLowerCase().startsWith(namespace + '/')));
          if (inferred) inferenceReason = `Unity product metadata suggests ${candidates[0].name}, but its publisher save namespace is unverified.`;
        }
      }
      if (candidates.length !== 1) {
        const stripped = titleWithoutSuffix(path.basename(installPath));
        if (stripped !== path.basename(installPath)) {
          candidates = catalog.byName.get(normalize(stripped)) || [];
          if (candidates.length === 1) { inferred = true; inferenceReason = `The folder name, after removing an edition or version suffix, suggests ${candidates[0].name}.`; }
        }
      }
      if (candidates.length !== 1) {
        const exes = new Set(executables.flatMap(x => catalog.byExe.get(normalize(x.name.slice(0, -4))) || []));
        if (exes.size === 1) { candidates = [...exes]; inferred = true; inferenceReason = `An executable name suggests ${candidates[0].name}, but the installation name does not match.`; }
      }
      const entry = candidates.length === 1 ? candidates[0] : undefined;
      add(installPath, { entry, steamId, inferred, inferenceReason, ...metadata, source: inferred ? 'Possible catalog match' : entry ? 'Game catalog' : 'Executable discovery', name: path.basename(installPath).replaceAll('_', ' ') });
    }
    for (const item of childDirs) queue.push(path.join(directory, item.name));
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function noLinks(root, relative) {
  let current = path.resolve(root);
  try { if ((await fs.lstat(current)).isSymbolicLink()) return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  }
  return true;
}

async function expandRule(base, pattern, warnings) {
  const segments = pattern.split('/');
  let prefixLength = segments.findIndex(x => MAGIC.test(x));
  if (prefixLength === -1) prefixLength = segments.length;
  let prefixes = [''];
  for (const segment of segments.slice(0, prefixLength)) {
    const next = [];
    for (const prefix of prefixes) {
      const directory = path.join(base, prefix);
      try {
        if (!await noLinks(base, prefix)) { warnings.add(`Skipped a symbolic link in ${directory}.`); continue; }
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const item of entries) if (item.name.toLowerCase() === segment.toLowerCase() && !item.isSymbolicLink()) next.push(prefix ? `${prefix}/${item.name}` : item.name);
      } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') warnings.add(`Cannot read save folder ${directory}: ${e.code || e.message}`); }
    }
    prefixes = next;
    if (!prefixes.length) break;
  }
  if (prefixLength === segments.length) return prefixes;
  const matches = new Set();
  const test = picomatch(pattern, { nocase: true, dot: true, bash: false });
  const queue = [...prefixes];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const relative = queue[cursor];
    const current = path.join(base, ...relative.split('/'));
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) continue;
      if (test(relative)) { matches.add(relative); continue; }
      if (!stat.isDirectory()) continue;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const item of entries) if (!item.isSymbolicLink()) queue.push(`${relative}/${item.name}`);
    } catch (e) { if (e.code !== 'ENOENT') warnings.add(`Cannot inspect save path ${current}: ${e.code || e.message}`); }
  }
  return [...matches];
}

function makeMapping(game, root, relativePath, confidence, reason, localRoots, externalRoot, confirmed) {
  const normalized = cleanRelative(relativePath);
  const id = mappingId(game.id, root, normalized);
  return { id, root, relativePath: normalized, confidence, reason, confirmed: confidence !== 'suggested' || confirmed.has(id), localPath: path.join(localRoots[root], ...normalized.split('/')), externalPath: path.join(externalRoot, root, ...normalized.split('/')) };
}

async function findSuggestions(games, localRoots, externalRoot, warnings, onProgress) {
  const aliases = new Map();
  for (const game of games) if (!game._hasExistingSaves && !game._replaceAuto) {
    for (const alias of [game.name, titleWithoutSuffix(game.name), path.basename(game.installPath), titleWithoutSuffix(path.basename(game.installPath)), game._entry?.name, game._unity?.product, ...(game._entry?.installDirs || [])].filter(Boolean)) {
      const normalized = normalize(alias);
      if (normalized.length < 4) continue;
      if (!aliases.has(normalized)) aliases.set(normalized, new Set());
      aliases.get(normalized).add(game);
    }
  }
  if (!aliases.size) return [];
  const suggestions = [];
  const seen = new Set();
  let visited = 0;
  for (const root of ROOTS) for (const base of [localRoots[root], path.join(externalRoot, root)]) {
    const queue = [''];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const relative = queue[cursor];
      const current = path.join(base, ...relative.split('/'));
      let entries;
      try {
        if (!await noLinks(base, relative)) continue;
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (error) { if (error.code !== 'ENOENT') warnings.add(`Skipped unreadable AppData folder ${current}: ${error.code || error.message}`); continue; }
      if (++visited % 250 === 0) onProgress(`Matching save folders · ${visited.toLocaleString()} folders checked`);
      for (const item of entries) {
        if (!item.isDirectory() || item.isSymbolicLink() || SKIP_SAVE_DIRS.test(item.name) || (!relative && SKIP_SAVE_TOP.test(item.name))) continue;
        const next = relative ? `${relative}/${item.name}` : item.name;
        const matched = aliases.get(normalize(item.name));
        const matchedGames = [...(matched || [])];
        if (matchedGames.length === 1 || (matchedGames.length > 1 && matchedGames[0].identity && matchedGames.every(game => game.identity === matchedGames[0].identity))) {
          for (const game of matchedGames) {
            const key = `${game.id}:${root}/${next}`.toLowerCase();
            if (!seen.has(key)) { suggestions.push({ game, root, relativePath: next }); seen.add(key); }
          }
          continue;
        }
        queue.push(next);
      }
    }
  }
  return suggestions;
}

export async function discoverGames({ gamesRoot, externalRoot, localRoots, customMappings = [], manualGames = [], ignoredMappings = [], confirmedMappings = [], onProgress = () => {} }) {
  const warnings = new Set();
  if (!gamesRoot || !externalRoot) return { games: [], warnings: [] };
  gamesRoot = path.resolve(gamesRoot);
  externalRoot = path.resolve(externalRoot);
  if (ROOTS.some(root => !localRoots?.[root])) throw new Error('Local, LocalLow and Roaming roots are required.');
  try { if (!await safeDirectory(gamesRoot)) throw new Error('The game library must be a regular folder, not a symbolic link.'); }
  catch (e) { return { games: [], warnings: [`Cannot scan the game library: ${e.message}`] }; }
  let catalog;
  try { catalog = await loadCatalog(); }
  catch (e) { warnings.add(`The bundled game catalog could not be loaded: ${e.message}`); catalog = { byName: new Map(), byExe: new Map(), bySteam: new Map() }; }
  onProgress('Searching the game library and its subfolders…');
  const games = await discoverInstalls(gamesRoot, catalog, warnings, onProgress);
  for (const custom of manualGames) {
    try {
      const relative = custom.relativeInstallPath === '.' ? '.' : cleanRelative(custom.relativeInstallPath);
      const installPath = path.resolve(gamesRoot, relative);
      if (!inside(gamesRoot, installPath) || !await noLinks(gamesRoot, relative === '.' ? '' : relative) || !await safeDirectory(installPath)) continue;
      if (typeof custom.name !== 'string' || !custom.name.trim() || custom.name.length > 200 || /[\x00-\x1f]/.test(custom.name)) continue;
      const name = custom.name.trim();
      const matches = catalog.byName.get(normalize(name)) || [];
      const entry = matches.length === 1 ? matches[0] : undefined;
      const id = stableId(`game:${relative}`);
      const previous = games.findIndex(game => game.id === id);
      const game = { id, name, installPath, relativeInstallPath: relative, source: 'Added by you', identity: identityFor(entry), edition: previous >= 0 ? games[previous].edition : 'unknown', editionEvidence: previous >= 0 ? games[previous].editionEvidence : [], steamId: entry?.steamIds[0], mappings: [], _entry: entry, _inferred: false };
      if (previous >= 0) games[previous] = game; else games.push(game);
    } catch (error) { warnings.add(`Could not use a manually added game: ${error.message}`); }
  }
  const confirmed = new Set(confirmedMappings);
  const ignored = new Set(ignoredMappings);
  for (const custom of customMappings) {
    const game = games.find(x => x.id === custom.gameId);
    if (!game || !ROOTS.includes(custom.root)) continue;
    try {
      game.mappings.push(makeMapping(game, custom.root, custom.relativePath, 'manual', 'Save location added by you.', localRoots, externalRoot, confirmed));
      if (custom.replaceAuto !== false) game._replaceAuto = true;
    } catch { warnings.add(`An invalid manual path for ${game.name} was skipped.`); }
  }
  for (const game of games) {
    onProgress(`Matching saves for ${game.name}…`);
    if (game._replaceAuto) continue;
    for (const rule of game._entry?.rules || []) {
      const [local, external] = await Promise.all([expandRule(localRoots[rule.root], rule.pattern, warnings), expandRule(path.join(externalRoot, rule.root), rule.pattern, warnings)]);
      if (local.length || external.length) game._hasExistingSaves = true;
      const paths = new Map([...local, ...external].map(p => [p.toLowerCase(), p]));
      if (!MAGIC.test(rule.pattern) && !paths.size) paths.set(rule.pattern.toLowerCase(), rule.pattern);
      for (const relativePath of paths.values()) {
        try { game.mappings.push(makeMapping(game, rule.root, relativePath, game._inferred ? 'suggested' : 'known', game._inferred ? `${game._inferenceReason || `The installation suggests ${game._entry.name}.`} Review and confirm this catalog path before transferring.` : 'Matched a Windows AppData rule in the bundled Ludusavi catalog.', localRoots, externalRoot, confirmed)); }
        catch { warnings.add(`Skipped an unsafe catalog path for ${game.name}.`); }
      }
    }
    if (!game._hasExistingSaves && game._unity) {
      const relative = `${game._unity.company}/${game._unity.product}`;
      const matches = await Promise.all([expandRule(localRoots.LocalLow, relative, warnings), expandRule(path.join(externalRoot, 'LocalLow'), relative, warnings)]);
      const existing = matches.flat();
      if (existing.length) {
        game.mappings.push(makeMapping(game, 'LocalLow', existing[0], 'suggested', 'Unity company and product metadata point to this save folder. Review and confirm it before transferring.', localRoots, externalRoot, confirmed));
        game._hasExistingSaves = true;
      }
    }
    if (game._entry?.omittedPaths) warnings.add(`${game.name}: the catalog also lists unsupported or excluded locations. Only AppData data is included; Documents, registry and saves inside the game folder are not transferred.`);
  }
  for (const item of await findSuggestions(games, localRoots, externalRoot, warnings, onProgress)) {
    try { item.game.mappings.push(makeMapping(item.game, item.root, item.relativePath, 'suggested', 'Folder name matches this game. Review its contents and confirm before transferring.', localRoots, externalRoot, confirmed)); }
    catch { warnings.add(`Skipped an unsafe suggested path for ${item.game.name}.`); }
  }
  for (const game of games) {
    const unique = new Map();
    for (const mapping of game.mappings) if ((mapping.confidence === 'manual' || !ignored.has(mapping.id)) && unique.get(mapping.id)?.confidence !== 'manual') unique.set(mapping.id, mapping);
    const manual = [...unique.values()].filter(item => item.confidence === 'manual');
    const automatic = [...unique.values()].filter(item => item.confidence !== 'manual' && !manual.some(other => overlaps(item, other)));
    game.mappings = [...manual, ...automatic.filter(item => !automatic.some(parent => parent !== item && parent.root === item.root && item.relativePath.toLowerCase().startsWith(parent.relativePath.toLowerCase() + '/')))];
  }
  for (const game of games) for (const mapping of game.mappings) {
    const overlap = games.some(other => other !== game && other.mappings.some(m => overlaps(m, mapping) && !(game.identity && game.identity === other.identity && m.relativePath.toLowerCase() === mapping.relativePath.toLowerCase())));
    if (overlap && mapping.confidence !== 'manual') {
      mapping.confidence = 'suggested'; mapping.confirmed = confirmed.has(mapping.id);
      mapping.reason = 'This save path overlaps another installed game. Review and confirm the mapping before transferring.';
      warnings.add(`${game.name}: a save path is shared with another installed game and requires your review.`);
    }
  }
  for (const game of games) {
    if (game.steamId) game.coverUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steamId}/library_600x900_2x.jpg`;
    delete game._entry;
    delete game._inferred;
    delete game._hasExistingSaves;
    delete game._replaceAuto;
    delete game._unity;
    delete game._inferenceReason;
  }
  return { games: games.sort((a, b) => a.name.localeCompare(b.name)), warnings: [...warnings] };
}
