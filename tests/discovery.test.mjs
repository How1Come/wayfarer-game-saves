import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverGames, mappingId } from '../electron/discovery.mjs';
import { compileManifest, compilePath } from '../scripts/update-catalog.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wayfarer-discovery-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const gamesRoot = path.join(home, 'Games');
  const externalRoot = path.join(home, 'DriveAppData');
  const localRoots = Object.fromEntries(['Local', 'LocalLow', 'Roaming'].map(root => [root, path.join(home, 'UserAppData', root)]));
  for (const dir of [gamesRoot, externalRoot, ...Object.values(localRoots)]) await fs.mkdir(dir, { recursive: true });
  const write = async (file, content = 'fixture') => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  return { home, gamesRoot, externalRoot, localRoots, write };
}

test('catalog compiler restricts paths to AppData and excludes broad publisher rules', () => {
  assert.deepEqual(compilePath('<winAppData>/../LocalLow/Studio/MyGame'), { root: 'LocalLow', pattern: 'Studio/MyGame' });
  assert.deepEqual(compilePath('<home>/AppData/Local/Game/<storeUserId>/*.sav'), { root: 'Local', pattern: 'Game/*/*.sav' });
  for (const unsafe of ['<winDocuments>/Game', '<winAppData>/../../other', '<winLocalAppData>/*', '<winAppData>', '<winAppData>/Microsoft', '<winAppData>/<unknown>/Game']) assert.equal(compilePath(unsafe), null, unsafe);
  const result = compileManifest({
    'One': { files: { '<winAppData>/Publisher': {}, '<winAppData>/Publisher/*': {}, '<winAppData>/Publisher/One/Saves/*.dat': {} } },
    'Two': { files: { '<winAppData>/Publisher/Two/Save': {}, '<winAppData>/Other': { when: [{ os: 'linux' }] } } },
  });
  assert.deepEqual(result.games[0].rules, [{ root: 'Roaming', pattern: 'Publisher/One/Saves/*.dat' }]);
  assert.equal(result.stats.rejectedSharedParents, 2);
  assert.equal(result.games[1].rules.length, 1);
});

test('discovers deeply nested games despite executables at the selected library root', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'launcher.exe'));
  await f.write(path.join(f.gamesRoot, 'MyCollectionTool.exe'));
  const nested = path.join(f.gamesRoot, ...Array.from({ length: 14 }, (_, i) => `group-${i}`), 'Stardew Valley');
  await f.write(path.join(nested, 'Stardew Valley.exe'));
  await f.write(path.join(nested, 'Stardew Valley_Data', 'Plugins', 'helper.exe'));
  await f.write(path.join(f.gamesRoot, '_CommonRedist', 'setup.exe'));
  await f.write(path.join(f.localRoots.Roaming, 'StardewValley', 'Saves', 'Farm_1', 'SaveGameInfo'));
  const result = await discoverGames(f);
  const game = result.games.find(x => x.name === 'Stardew Valley');
  assert.ok(game);
  assert.equal(game.steamId, 413150);
  assert.equal(game.installPath, nested);
  assert.equal(result.games.some(x => x.installPath.includes('_Data')), false);
  assert.equal(result.games.some(x => x.installPath.includes('_CommonRedist')), false);
  assert.ok(game.mappings.some(x => x.relativePath === 'StardewValley/Saves' && x.confidence === 'known'));
});

test('matches save files from the external drive on a fresh computer without widening globs', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Renamed adventure', 'hollow_knight.exe'));
  await f.write(path.join(f.externalRoot, 'LocalLow', 'Team Cherry', 'Hollow Knight', 'user1.dat'));
  await f.write(path.join(f.externalRoot, 'LocalLow', 'Team Cherry', 'Hollow Knight', 'readme.txt'));
  await f.write(path.join(f.externalRoot, 'LocalLow', 'Team Cherry', 'Another Game', 'user1.dat'));
  const result = await discoverGames(f);
  const game = result.games.find(x => x.name === 'Renamed adventure');
  assert.ok(game);
  assert.equal(game.mappings[0].confidence, 'suggested');
  assert.equal(game.mappings[0].confirmed, false);
  assert.ok(game.mappings.some(x => x.relativePath === 'Team Cherry/Hollow Knight/user1.dat'));
  assert.equal(game.mappings.some(x => /readme|Another Game/.test(x.relativePath)), false);
  assert.equal(game.mappings.some(x => x.relativePath === 'Team Cherry'), false);
  assert.equal(game.mappings[0].localPath, path.join(f.localRoots.LocalLow, ...game.mappings[0].relativePath.split('/')));
});

test('Steam manifests identify games and preserve account folders found only on the drive', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'steamapps', 'appmanifest_1245620.acf'), '"AppState" { "appid" "1245620" "name" "ELDEN RING" "installdir" "EldenInstall" }');
  await f.write(path.join(f.gamesRoot, 'steamapps', 'common', 'EldenInstall', 'Game', 'start_protected_game.exe'));
  await f.write(path.join(f.externalRoot, 'Roaming', 'EldenRing', '76561198000000000', 'ER0000.sl2'));
  const { games } = await discoverGames(f);
  assert.equal(games.length, 1);
  assert.equal(games[0].name, 'Elden Ring');
  assert.equal(games[0].source, 'Steam library');
  assert.ok(games[0].mappings.some(x => x.relativePath === 'EldenRing/76561198000000000'));
  const fromCommon = await discoverGames({ ...f, gamesRoot: path.join(f.gamesRoot, 'steamapps', 'common') });
  assert.equal(fromCommon.games[0].source, 'Steam library');
});

test('name guesses require confirmation; manual re-add wins over a previously ignored mapping', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Unknown Puzzle Adventure', 'Binaries', 'Win64', 'puzzler-Win64-Shipping.exe'));
  await f.write(path.join(f.localRoots.LocalLow, 'Small Studio', 'Unknown Puzzle Adventure', 'profile.sav'));
  let result = await discoverGames(f);
  assert.equal(result.games.length, 1);
  const game = result.games[0];
  assert.equal(game.name, 'Unknown Puzzle Adventure');
  assert.equal(game.mappings.length, 1);
  const mapping = game.mappings[0];
  assert.equal(mapping.confidence, 'suggested');
  assert.equal(mapping.confirmed, false);
  result = await discoverGames({ ...f, confirmedMappings: [mapping.id] });
  assert.equal(result.games[0].mappings[0].confirmed, true);
  result = await discoverGames({ ...f, ignoredMappings: [mapping.id] });
  assert.equal(result.games[0].mappings.length, 0);
  result = await discoverGames({ ...f, ignoredMappings: [mapping.id], customMappings: [{ gameId: game.id, root: mapping.root, relativePath: mapping.relativePath }] });
  assert.equal(result.games[0].mappings[0].confidence, 'manual');
  assert.equal(result.games[0].mappings[0].id, mappingId(game.id, mapping.root, mapping.relativePath));
});

test('does not traverse linked installations or save folders, or escaping Steam manifests', async t => {
  const f = await fixture(t);
  const outside = path.join(f.home, 'Outside');
  await f.write(path.join(outside, 'Stardew Valley.exe'));
  await fs.symlink(outside, path.join(f.gamesRoot, 'Stardew Valley'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.write(path.join(f.gamesRoot, 'Hollow Knight', 'hollow_knight.exe'));
  await f.write(path.join(outside, 'user1.dat'));
  await fs.mkdir(path.join(f.localRoots.LocalLow, 'Team Cherry'), { recursive: true });
  await fs.symlink(outside, path.join(f.localRoots.LocalLow, 'Team Cherry', 'Hollow Knight'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.write(path.join(f.gamesRoot, 'steamapps', 'appmanifest_413150.acf'), '"AppState" { "appid" "413150" "installdir" "../../../Outside" }');
  const { games } = await discoverGames(f);
  assert.equal(games.length, 1);
  assert.equal(games[0].name, 'Hollow Knight');
  assert.equal(games[0].mappings.length, 0);
});

test('game and mapping IDs survive a different drive root', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Stardew Valley', 'Stardew Valley.exe'));
  const original = await discoverGames(f);
  const relocated = path.join(f.home, 'OtherDrive', 'Games');
  await fs.cp(f.gamesRoot, relocated, { recursive: true });
  const moved = await discoverGames({ ...f, gamesRoot: relocated });
  assert.equal(original.games[0].id, moved.games[0].id);
  assert.deepEqual(original.games[0].mappings.map(x => x.id), moved.games[0].mappings.map(x => x.id));
});

test('missing catalog paths still allow a real folder-name suggestion', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Stardew Valley', 'game.exe'));
  await f.write(path.join(f.localRoots.LocalLow, 'Alternate Studio', 'Stardew Valley', 'save.dat'));
  const { games } = await discoverGames(f);
  assert.ok(games[0].mappings.some(x => x.relativePath === 'StardewValley/Saves'));
  const fallback = games[0].mappings.find(x => x.relativePath === 'Alternate Studio/Stardew Valley');
  assert.ok(fallback);
  assert.equal(fallback.confidence, 'suggested');
  assert.equal(fallback.confirmed, false);
});

test('manual saves override automatic mappings and keep an exact manual child', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Stardew Valley', 'game.exe'));
  await f.write(path.join(f.localRoots.Roaming, 'StardewValley', 'Saves', 'Farm_1', 'save.dat'));
  await f.write(path.join(f.localRoots.LocalLow, 'Different Save', 'manual.dat'));
  const { games: original } = await discoverGames(f);
  const gameId = original[0].id;
  for (const replaceAuto of [undefined, true, false]) {
    const result = await discoverGames({ ...f, customMappings: [{ gameId, root: 'Roaming', relativePath: 'StardewValley/Saves/Farm_1', replaceAuto }] });
    const mappings = result.games[0].mappings;
    assert.ok(mappings.some(x => x.relativePath === 'StardewValley/Saves/Farm_1' && x.confidence === 'manual'));
    assert.equal(mappings.some(x => x.relativePath === 'StardewValley/Saves'), false);
    assert.equal(mappings.length, replaceAuto === false ? 2 : 1);
  }
  const exact = await discoverGames({ ...f, customMappings: [{ gameId, root: 'Roaming', relativePath: 'StardewValley/Saves', replaceAuto: false }] });
  const save = exact.games[0].mappings.find(x => x.relativePath === 'StardewValley/Saves');
  assert.equal(save.confidence, 'manual');
  assert.equal(save.id, original[0].mappings.find(x => x.relativePath === 'StardewValley/Saves').id);
  const multiple = await discoverGames({ ...f, customMappings: [{ gameId, root: 'Roaming', relativePath: 'StardewValley/Saves/Farm_1' }, { gameId, root: 'LocalLow', relativePath: 'Different Save' }] });
  assert.equal(multiple.games[0].mappings.length, 2);
  assert.ok(multiple.games[0].mappings.every(x => x.confidence === 'manual'));
});

test('edition and version folder suffixes are suggestions, never Steam installation evidence', async t => {
  const f = await fixture(t);
  const names = ['Stardew Valley (Steam)', 'Stardew Valley [GOG]', 'Stardew Valley standalone', 'Stardew Valley (GOG) v1.6.8'];
  for (const name of names) await f.write(path.join(f.gamesRoot, name, 'game.exe'));
  const { games } = await discoverGames(f);
  assert.equal(games.length, names.length);
  for (const game of games) {
    assert.equal(game.steamId, 413150);
    assert.equal(game.identity, undefined);
    assert.equal(game.edition, 'unknown');
    assert.ok(game.mappings.length);
    assert.ok(game.mappings.every(x => x.confidence === 'suggested' && !x.confirmed));
  }
});

test('a Steam app ID identifies the game but only a manifest identifies its Steam edition', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Standalone copy', 'game.exe'));
  await f.write(path.join(f.gamesRoot, 'Standalone copy', 'steam_appid.txt'), '413150');
  await f.write(path.join(f.gamesRoot, 'steamapps', 'appmanifest_413150.acf'), '"AppState" { "appid" "413150" "name" "Stardew Valley" "installdir" "Stardew Valley" }');
  await f.write(path.join(f.gamesRoot, 'steamapps', 'common', 'Stardew Valley', 'game.exe'));
  await f.write(path.join(f.localRoots.Roaming, 'StardewValley', 'Saves', 'Farm', 'save.dat'));
  const { games, warnings } = await discoverGames(f);
  const standalone = games.find(x => x.relativeInstallPath === 'Standalone copy');
  const steam = games.find(x => x.source === 'Steam library');
  assert.equal(standalone.identity, steam.identity);
  assert.equal(standalone.edition, 'unknown');
  assert.equal(steam.edition, 'steam');
  assert.match(steam.editionEvidence[0], /appmanifest/);
  assert.ok(games.every(game => game.mappings.every(x => x.confidence === 'known')));
  assert.equal(warnings.some(x => x.includes('shared with another installed game')), false);
});

test('validated GOG metadata identifies a standalone edition without relying on its artwork ID', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Offline farm', 'game.exe'));
  await f.write(path.join(f.gamesRoot, 'Offline farm', 'goggame-1453375253.info'), JSON.stringify({ gameId: '1453375253', name: 'Stardew Valley' }));
  const { games } = await discoverGames(f);
  assert.equal(games[0].identity, 'ludusavi:Stardew Valley');
  assert.equal(games[0].edition, 'standalone');
  assert.equal(games[0].steamId, 413150);
  assert.match(games[0].editionEvidence[0], /GOG/);
});

test('Unity product metadata resolves renamed installs and confines suggested paths to its publisher and product', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Renamed platformer', 'game.exe'));
  await f.write(path.join(f.gamesRoot, 'Renamed platformer', 'game_Data', 'app.info'), 'Team Cherry\nHollow Knight\n');
  await f.write(path.join(f.localRoots.LocalLow, 'Team Cherry', 'Hollow Knight', 'user1.dat'));
  await f.write(path.join(f.gamesRoot, 'Unlisted title', 'game.exe'));
  await f.write(path.join(f.gamesRoot, 'Unlisted title', 'game_Data', 'app.info'), 'Test Studio\nA Bright Unlisted Product\n');
  await f.write(path.join(f.localRoots.LocalLow, 'Test Studio', 'A Bright Unlisted Product', 'slot.dat'));
  const { games } = await discoverGames(f);
  const known = games.find(x => x.relativeInstallPath === 'Renamed platformer');
  assert.equal(known.identity, 'ludusavi:Hollow Knight');
  assert.ok(known.mappings.every(x => x.confidence === 'known'));
  const unknown = games.find(x => x.relativeInstallPath === 'Unlisted title');
  assert.equal(unknown.mappings.length, 1);
  assert.equal(unknown.mappings[0].relativePath, 'Test Studio/A Bright Unlisted Product');
  assert.equal(unknown.mappings[0].confidence, 'suggested');
});

test('nested Unreal shipping binaries resolve once to the installation above the project folder', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.gamesRoot, 'Unlisted Adventure', 'ProjectName', 'Binaries', 'Win64', 'ProjectName-Win64-Shipping.exe'));
  await f.write(path.join(f.gamesRoot, 'Unlisted Adventure', 'Engine', 'Binaries', 'Win64', 'UnrealCEFSubProcess.exe'));
  await f.write(path.join(f.gamesRoot, 'Unlisted Adventure', 'Engine', 'Binaries', 'Win64', 'UE4Game.exe'));
  const { games } = await discoverGames(f);
  assert.equal(games.length, 1);
  assert.equal(games[0].relativeInstallPath, 'Unlisted Adventure');
  assert.equal(games[0].name, 'Unlisted Adventure');
});

test('manual game names add missing executables and replace wrong identities without changing IDs', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.gamesRoot, 'No executable'), { recursive: true });
  await f.write(path.join(f.gamesRoot, 'Wrong inferred name', 'hollow_knight.exe'));
  const initial = await discoverGames(f);
  const prior = initial.games.find(x => x.relativeInstallPath === 'Wrong inferred name');
  const result = await discoverGames({ ...f, manualGames: [{ relativeInstallPath: 'No executable', name: 'Stardew Valley' }, { relativeInstallPath: 'Wrong inferred name', name: 'My custom title' }] });
  assert.equal(result.games.length, 2);
  const added = result.games.find(x => x.relativeInstallPath === 'No executable');
  assert.equal(added.identity, 'ludusavi:Stardew Valley');
  const corrected = result.games.find(x => x.relativeInstallPath === 'Wrong inferred name');
  assert.equal(corrected.id, prior.id);
  assert.equal(corrected.name, 'My custom title');
  assert.equal(corrected.identity, undefined);
  assert.equal(corrected.steamId, undefined);
  assert.equal(corrected.mappings.length, 0);
});

test('manual installations reject traversal, links and nonexistent directories', async t => {
  const f = await fixture(t);
  const outside = path.join(f.home, 'OutsideGame');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.gamesRoot, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { games } = await discoverGames({ ...f, manualGames: [{ relativeInstallPath: '../OutsideGame', name: 'Stardew Valley' }, { relativeInstallPath: 'Linked', name: 'Hollow Knight' }, { relativeInstallPath: 'Missing', name: 'Elden Ring' }] });
  assert.equal(games.length, 0);
});
