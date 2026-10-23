import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

export const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
const LICENSE_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/LICENSE';
const appRoots = { winAppData: 'Roaming', winLocalAppData: 'Local', winLocalAppDataLow: 'LocalLow' };
const knownRoots = new Set(Object.values(appRoots));
const magic = /[*?\[\]{}!()]/;

export function compilePath(input) {
  let value = input.replaceAll('\\', '/');
  value = value.replace(/^<home>\/AppData\//i, '');
  for (const [token, root] of Object.entries(appRoots)) value = value.replace(`<${token}>`, root);
  value = value.replaceAll('<storeUserId>', '*').replaceAll('<osUserName>', '*');
  if (/<[^>]*>/.test(value) || !/^(Local|LocalLow|Roaming)\//.test(value)) return null;
  const normalized = path.posix.normalize(value);
  const [root, ...rest] = normalized.split('/');
  if (!knownRoots.has(root) || !rest.length || rest.some(x => !x || x === '..' || x === '.' || x.includes(':'))) return null;
  if (magic.test(rest[0])) return null;
  const pattern = rest.join('/').replace(/\/$/, '');
  if (!pattern || /^(Microsoft|Packages|Temp|Unity|UnrealEngine|EpicGamesLauncher|NVIDIA|Google|Mozilla)$/i.test(pattern)) return null;
  return { root, pattern };
}

export function compileManifest(manifest) {
  const games = [];
  let outsideAppData = 0;
  let rejected = 0;
  for (const [name, record] of Object.entries(manifest)) {
    const rules = [];
    let omitted = 0;
    for (const [rawPath, info] of Object.entries(record.files || {})) {
      if (info.when?.length && !info.when.some(x => !x.os || x.os === 'windows')) continue;
      const compiled = compilePath(rawPath);
      if (!compiled) { outsideAppData++; omitted++; continue; }
      if (!rules.some(x => x.root === compiled.root && x.pattern === compiled.pattern)) rules.push(compiled);
    }
    const ids = [record.steam?.id, ...(record.id?.steamExtra || [])].filter(x => Number.isInteger(x) && x > 0);
    const executables = Object.keys(record.launch || {}).flatMap(p => {
      if (!p.startsWith('<base>/') || !/\.exe$/i.test(p)) return [];
      const exe = path.posix.basename(p.slice(7));
      return magic.test(exe) ? [] : [exe];
    });
    games.push({ name, installDirs: Object.keys(record.installDir || {}), steamIds: ids, executables: [...new Set(executables)], rules, omittedPaths: omitted + (Object.keys(record.registry || {}).length ? 1 : 0) });
  }
  const prefixes = new Map();
  for (const game of games) for (const rule of game.rules) {
    const segments = rule.pattern.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (segments.slice(0, i).some(x => magic.test(x))) break;
      const key = `${rule.root}/${segments.slice(0, i).join('/')}`.toLowerCase();
      if (!prefixes.has(key)) prefixes.set(key, new Set());
      prefixes.get(key).add(game.name);
    }
  }
  for (const game of games) game.rules = game.rules.filter(rule => {
    const fixed = rule.pattern.split('/').slice(0, rule.pattern.split('/').findIndex(x => magic.test(x)) === -1 ? undefined : rule.pattern.split('/').findIndex(x => magic.test(x))).join('/');
    const owners = prefixes.get(`${rule.root}/${fixed}`.toLowerCase());
    if (owners && [...owners].some(n => n !== game.name)) {
      game.omittedPaths++; rejected++; return false;
    }
    return true;
  });
  return { games, stats: { games: games.length, appDataGames: games.filter(x => x.rules.length).length, rules: games.reduce((n, x) => n + x.rules.length, 0), omittedPaths: outsideAppData, rejectedSharedParents: rejected } };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return response.text();
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await download(MANIFEST_URL);
  console.log('Compiling official Ludusavi manifest…');
  const result = compileManifest(parse(source, { maxAliasCount: 1000, uniqueKeys: false }));
  const generatedAt = new Date().toISOString();
  const metadata = { formatVersion: 1, generatedAt, source: MANIFEST_URL, sourceSha256: createHash('sha256').update(source).digest('hex'), license: 'MIT', ...result.stats };
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data/catalog.json'), JSON.stringify({ metadata, games: result.games }));
  await writeFile(path.join(root, 'data/LUDUSAVI-LICENSE.txt'), await download(LICENSE_URL));
  await writeFile(path.join(root, 'data/README.md'), `# Offline game catalog\n\nGenerated ${generatedAt} from the [official Ludusavi manifest](${MANIFEST_URL}).\n\n${metadata.games} game identities, ${metadata.appDataGames} with supported AppData paths, ${metadata.rules} AppData rules. Source SHA-256: \`${metadata.sourceSha256}\`.\n\nLudusavi Manifest is Copyright (c) 2020 Matthew T. Kennerly (mtkennerly), distributed under the MIT license in [LUDUSAVI-LICENSE.txt](./LUDUSAVI-LICENSE.txt). Its primary manifest is compiled from PCGamingWiki and Steam installation-directory metadata.\n\nThis is a restricted derivative: Windows Local, LocalLow and Roaming paths only. Registry, Documents, Saved Games, installation-directory saves and unresolved placeholders are excluded. Broad shared publisher or engine directories are excluded. Wildcards select individual existing files/folders on either computer or drive; account folders retain their names. No secondary manifests or executable code from games are loaded.\n\nRun \`npm run catalog:update\` to rebuild from the current upstream catalog, or \`node scripts/update-catalog.mjs manifest.yaml\` to compile a reviewed local copy. Updating the catalog is a developer action; the packaged app works offline.\n`);
  console.log(JSON.stringify(metadata, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
