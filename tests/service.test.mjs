import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultService, encodePortablePath, decodePortablePath } from '../electron/service.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wayfarer-service-'));
  const base = await fs.realpath(temporary);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const portableDir = path.join(base, 'portable');
  const gamesRoot = path.join(base, 'games');
  const externalRoot = path.join(base, 'drive', 'Appdata');
  const localRoots = Object.fromEntries(['Local', 'LocalLow', 'Roaming'].map(root => [root, path.join(base, 'computer', 'AppData', root)]));
  await Promise.all([portableDir, gamesRoot, externalRoot, ...Object.values(localRoots)].map(folder => fs.mkdir(folder, { recursive: true })));
  const install = path.join(gamesRoot, 'Indies', 'Moon Orchard');
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(path.join(install, 'MoonOrchard.exe'), 'test executable placeholder');
  const source = path.join(localRoots.LocalLow, 'Example Studio', 'Moon Orchard');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'save.dat'), 'progress from computer one');
  const service = await new VaultService({ portableDir, localRoots, isWindows: true }).initialize();
  return { service, portableDir, gamesRoot, externalRoot, localRoots, source, base };
}

test('portable Windows configuration follows the executable volume letter', () => {
  const api = path.win32;
  const encoded = encodePortablePath('E:\\Tools\\Wayfarer', 'E:\\Windows\\Appdata', api);
  assert.deepEqual(encoded, { relative: '..\\..\\Windows\\Appdata' });
  assert.equal(decodePortablePath('F:\\Tools\\Wayfarer', encoded, api), 'F:\\Windows\\Appdata');
  assert.deepEqual(encodePortablePath('E:\\Tools', 'C:\\Saves', api), { absolute: 'C:\\Saves' });
});

test('end-to-end: nested discovery, confirmed suggestion, backup, portable restart and restore to fresh PC', async t => {
  const fixtureData = await fixture(t);
  const { service, gamesRoot, externalRoot, portableDir, base } = fixtureData;
  const state = await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  assert.equal(state.games.length, 1);
  const game = state.games[0];
  const mapping = game.mappings[0];
  assert.equal(mapping.status, 'local-only');
  assert.equal(mapping.confidence, 'suggested');
  await assert.rejects(service.transfer({ gameId: game.id, mappingId: mapping.id, direction: 'to-drive', expectedToken: mapping.token }), /confirm/i);
  await service.confirmMapping({ gameId: game.id, mappingId: mapping.id });
  const result = await service.transfer({ gameId: game.id, mappingId: mapping.id, direction: 'to-drive', expectedToken: service.games[0].mappings[0].token });
  assert.equal(result.games[0].mappings[0].status, 'synced');
  const driveSave = path.join(externalRoot, 'LocalLow', 'Example Studio', 'Moon Orchard', 'save.dat');
  assert.equal(await fs.readFile(driveSave, 'utf8'), 'progress from computer one');
  assert.equal(service.library.history.length, 1);
  const localRoots = Object.fromEntries(['Local', 'LocalLow', 'Roaming'].map(root => [root, path.join(base, 'new-computer', 'AppData', root)]));
  const second = await new VaultService({ portableDir, localRoots, isWindows: true }).initialize();
  const next = await second.getState();
  assert.equal(next.games[0].mappings[0].status, 'drive-only');
  assert.equal(next.games[0].mappings[0].confirmed, true);
  await second.transfer({ gameId: game.id, mappingId: mapping.id, direction: 'to-local', expectedToken: next.games[0].mappings[0].token });
  assert.equal(await fs.readFile(path.join(localRoots.LocalLow, 'Example Studio', 'Moon Orchard', 'save.dat'), 'utf8'), 'progress from computer one');
});

test('disconnected drive clears actionable mappings and reports the problem', async t => {
  const { service, gamesRoot, externalRoot } = await fixture(t);
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  await fs.rename(externalRoot, `${externalRoot}-disconnected`);
  const result = await service.refresh();
  assert.equal(result.games.length, 0);
  assert.match(result.warnings.join(' '), /Drive unavailable/);
  assert.equal(await fs.stat(externalRoot).catch(() => null), null);
});

test('configuration rejects overlapping AppData and library roots', async t => {
  const { service, gamesRoot, localRoots } = await fixture(t);
  await assert.rejects(service.saveSettings({ gamesRoot, externalRoot: localRoots.Local, coverArt: false }), /separate from this computer/);
  const nested = path.join(gamesRoot, 'AppData');
  await fs.mkdir(nested);
  await assert.rejects(service.saveSettings({ gamesRoot, externalRoot: nested, coverArt: false }), /separate/);
});

test('malformed portable metadata is never silently replaced', async t => {
  const { service, gamesRoot, externalRoot } = await fixture(t);
  await fs.mkdir(path.join(externalRoot, '.wayfarer'));
  await fs.writeFile(path.join(externalRoot, '.wayfarer', 'library.json'), '{broken');
  await assert.rejects(service.saveSettings({ gamesRoot, externalRoot, coverArt: false }), /has not been replaced/);
  assert.equal(await fs.readFile(path.join(externalRoot, '.wayfarer', 'library.json'), 'utf8'), '{broken');
});

test('ambiguous overlapping save mappings cannot overwrite another mapping', async t => {
  const { service, gamesRoot, externalRoot } = await fixture(t);
  const secondInstall = path.join(gamesRoot, 'Other Adventure');
  await fs.mkdir(secondInstall);
  await fs.writeFile(path.join(secondInstall, 'adventure.exe'), 'fixture');
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const game = service.games.find(game => game.name === 'Moon Orchard');
  const other = service.games.find(game => game.relativeInstallPath === 'Other Adventure');
  await service.addMapping({ gameId: game.id, root: 'LocalLow', relativePath: 'Example Studio' });
  await service.addMapping({ gameId: other.id, root: 'LocalLow', relativePath: 'Example Studio/Moon Orchard' });
  assert.ok(service.games.flatMap(game => game.mappings).every(mapping => mapping.status === 'error'));
  const mapping = service.findGame(game.id).mappings[0];
  await assert.rejects(service.transfer({ gameId: game.id, mappingId: mapping.id, direction: 'to-drive', expectedToken: mapping.token }), /overlaps/);
});

test('redirected AppData roots cannot hide a parent mapping that replaces another game’s save', async t => {
  const { service, gamesRoot, externalRoot, localRoots, source } = await fixture(t);
  service.localRoots.Roaming = localRoots.LocalLow;
  const otherInstall = path.join(gamesRoot, 'Other Adventure');
  await fs.mkdir(otherInstall);
  await fs.writeFile(path.join(otherInstall, 'adventure.exe'), 'fixture');
  const archivedParent = path.join(externalRoot, 'LocalLow', 'Example Studio');
  await fs.mkdir(archivedParent, { recursive: true });
  await fs.writeFile(path.join(archivedParent, 'other.dat'), 'archive parent contents');
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const parent = service.games.find(game => game.name === 'Moon Orchard');
  const child = service.games.find(game => game.relativeInstallPath === 'Other Adventure');
  await service.addMapping({ gameId: parent.id, root: 'LocalLow', relativePath: 'Example Studio' });
  await service.addMapping({ gameId: child.id, root: 'Roaming', relativePath: 'Example Studio/Moon Orchard' });
  for (const game of [parent, child]) assert.equal(service.findGame(game.id).mappings[0].status, 'error');
  const mapping = service.findGame(parent.id).mappings[0];
  await assert.rejects(service.transfer({ gameId: parent.id, mappingId: mapping.id, direction: 'to-local', expectedToken: mapping.token }), /overlaps/);
  assert.equal(await fs.readFile(path.join(source, 'save.dat'), 'utf8'), 'progress from computer one');
  assert.equal(await fs.readFile(path.join(archivedParent, 'other.dat'), 'utf8'), 'archive parent contents');
});

test('exact saves shared through redirected AppData roots identify the shared side', async t => {
  const { service, gamesRoot, externalRoot, localRoots } = await fixture(t);
  service.localRoots.Roaming = localRoots.LocalLow;
  const otherInstall = path.join(gamesRoot, 'Other Adventure');
  await fs.mkdir(otherInstall);
  await fs.writeFile(path.join(otherInstall, 'adventure.exe'), 'fixture');
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const first = service.games.find(game => game.name === 'Moon Orchard');
  const second = service.games.find(game => game.relativeInstallPath === 'Other Adventure');
  await service.addMapping({ gameId: first.id, root: 'LocalLow', relativePath: 'Example Studio/Moon Orchard' });
  await service.addMapping({ gameId: second.id, root: 'Roaming', relativePath: 'Example Studio/Moon Orchard' });
  for (const game of [first, second]) {
    const mapping = service.findGame(game.id).mappings[0];
    assert.equal(mapping.error, undefined);
    assert.deepEqual(mapping.sharedOn.local, [game.id === first.id ? second.name : first.name]);
    assert.deepEqual(mapping.sharedOn.external, []);
  }
  assert.notEqual(service.findGame(first.id).mappings[0].externalPath, service.findGame(second.id).mappings[0].externalPath);
});

test('selecting an existing suggested save makes it authoritative and survives a portable restart', async t => {
  const { service, portableDir, gamesRoot, externalRoot, localRoots, source } = await fixture(t);
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const game = service.games[0];
  const suggested = game.mappings[0];
  assert.equal(suggested.confidence, 'suggested');
  assert.equal(suggested.confirmed, false);
  await service.addMapping({ gameId: game.id, root: 'Roaming', relativePath: source });
  await service.addMapping({ gameId: game.id, root: 'LocalLow', relativePath: 'Example Studio/Moon Orchard' });
  assert.equal(service.library.customMappings.length, 1);
  const restart = await new VaultService({ portableDir, localRoots, isWindows: true }).initialize();
  const state = await restart.getState();
  const selected = state.games.find(item => item.id === game.id).mappings;
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, suggested.id);
  assert.equal(selected[0].confidence, 'manual');
  assert.equal(selected[0].confirmed, true);
  assert.equal(selected[0].status, 'local-only');
  await restart.transfer({ gameId: game.id, mappingId: selected[0].id, direction: 'to-drive', expectedToken: selected[0].token });
  assert.equal(await fs.readFile(path.join(externalRoot, 'LocalLow', 'Example Studio', 'Moon Orchard', 'save.dat'), 'utf8'), 'progress from computer one');
});

test('an explicit save file replaces its automatic parent folder without remaining unclear', async t => {
  const { service, gamesRoot, externalRoot, source } = await fixture(t);
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const game = service.games[0];
  await service.addMapping({ gameId: game.id, root: 'LocalLow', relativePath: path.join(source, 'save.dat') });
  const mappings = service.findGame(game.id).mappings;
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].relativePath, 'Example Studio/Moon Orchard/save.dat');
  assert.equal(mappings[0].confidence, 'manual');
  assert.equal(mappings[0].confirmed, true);
  assert.equal(mappings[0].error, undefined);
  assert.equal((await fs.stat(mappings[0].localPath)).isFile(), true);
});

test('an absolute archive path can be selected on a PC with no local save', async t => {
  const { service, gamesRoot, externalRoot } = await fixture(t);
  const save = path.join(externalRoot, 'Roaming', 'Portable Game', 'slot.sav');
  await fs.mkdir(path.dirname(save), { recursive: true });
  await fs.writeFile(save, 'archive progress');
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const game = service.games[0];
  await service.addMapping({ gameId: game.id, root: 'Local', relativePath: save });
  const mappings = service.findGame(game.id).mappings;
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].root, 'Roaming');
  assert.equal(mappings[0].relativePath, 'Portable Game/slot.sav');
  assert.equal(mappings[0].status, 'drive-only');
  assert.equal(mappings[0].confirmed, true);
});

test('two installations with the same canonical identity may share their exact save path', async t => {
  const { service, gamesRoot, externalRoot, localRoots } = await fixture(t);
  const standalone = path.join(gamesRoot, 'Offline Farm');
  const steam = path.join(gamesRoot, 'steamapps', 'common', 'Steam Farm');
  await fs.mkdir(standalone, { recursive: true });
  await fs.mkdir(steam, { recursive: true });
  await fs.writeFile(path.join(standalone, 'game.exe'), 'fixture');
  await fs.writeFile(path.join(standalone, 'steam_appid.txt'), '413150');
  await fs.writeFile(path.join(steam, 'game.exe'), 'fixture');
  await fs.writeFile(path.join(gamesRoot, 'steamapps', 'appmanifest_413150.acf'), '"AppState" { "appid" "413150" "name" "Stardew Valley" "installdir" "Steam Farm" }');
  const save = path.join(localRoots.Roaming, 'StardewValley', 'Saves', 'Farm_1');
  await fs.mkdir(save, { recursive: true });
  await fs.writeFile(path.join(save, 'SaveGameInfo'), 'farm progress');
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const editions = service.games.filter(game => game.identity === 'ludusavi:Stardew Valley');
  assert.equal(editions.length, 2);
  for (const edition of editions) {
    const mapping = edition.mappings.find(item => item.relativePath === 'StardewValley/Saves');
    assert.equal(mapping.status, 'local-only');
    assert.equal(mapping.error, undefined);
    assert.equal(mapping.confirmed, true);
    assert.equal(mapping.sharedWith.length, 1);
    assert.equal(mapping.sharedOn.local.length, 1);
    assert.equal(mapping.sharedOn.external.length, 1);
  }
});

test('a manual assignment remains usable when another game has a conflicting automatic match', async t => {
  const { service, gamesRoot, externalRoot, source } = await fixture(t);
  const otherInstall = path.join(gamesRoot, 'Other Adventure');
  await fs.mkdir(otherInstall);
  await fs.writeFile(path.join(otherInstall, 'adventure.exe'), 'fixture');
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const automatic = service.games.find(game => game.name === 'Moon Orchard');
  const assigned = service.games.find(game => game.relativeInstallPath === 'Other Adventure');
  await service.addMapping({ gameId: assigned.id, root: 'LocalLow', relativePath: source });
  const manual = service.findGame(assigned.id).mappings[0];
  assert.equal(manual.confidence, 'manual');
  assert.equal(manual.status, 'local-only');
  assert.equal(manual.error, undefined);
  const blocked = service.findGame(automatic.id).mappings[0];
  assert.equal(blocked.status, 'error');
  assert.match(blocked.error, /assigned manually/);
  await assert.rejects(service.transfer({ gameId: automatic.id, mappingId: blocked.id, direction: 'to-drive', expectedToken: blocked.token }), /confirm|assigned manually/);
});

test('manual game correction keeps its identity stable and is saved across restarts', async t => {
  const { service, gamesRoot, externalRoot, portableDir, localRoots } = await fixture(t);
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const existing = service.games[0];
  await service.addGame({ installPath: existing.installPath, name: 'Corrected Adventure' });
  assert.equal(service.findGame(existing.id).name, 'Corrected Adventure');
  const installPath = path.join(gamesRoot, 'No executable');
  await fs.mkdir(installPath);
  await service.addGame({ installPath, name: 'Stardew Valley' });
  const restart = await new VaultService({ portableDir, localRoots, isWindows: true }).initialize();
  const state = await restart.getState();
  assert.equal(state.games.find(game => game.id === existing.id).name, 'Corrected Adventure');
  assert.equal(state.games.find(game => game.installPath === installPath).identity, 'ludusavi:Stardew Valley');
  assert.equal(state.games.length, 2);
});

test('manual installation validation rejects missing, outside, linked, and non-directory paths', async t => {
  const { service, gamesRoot, externalRoot, base } = await fixture(t);
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  const outside = path.join(base, 'Outside game');
  await fs.mkdir(outside);
  const linked = path.join(gamesRoot, 'Linked game');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const executable = path.join(gamesRoot, 'game.exe');
  await fs.writeFile(executable, 'fixture');
  for (const installPath of [outside, linked, executable, path.join(gamesRoot, 'Missing')]) {
    await assert.rejects(service.addGame({ installPath, name: 'Manual game' }));
  }
  for (const name of ['', '  ', 'a'.repeat(201), null]) {
    await assert.rejects(service.addGame({ installPath: gamesRoot, name }), /game name/);
  }
  assert.equal(service.library.manualGames.length, 0);
});

test('adding games requires configured and currently connected library folders', async t => {
  const { service, gamesRoot, externalRoot } = await fixture(t);
  await assert.rejects(service.addGame({ installPath: gamesRoot, name: 'Manual game' }), /configure|select|folder/i);
  assert.equal(service.library.manualGames.length, 0);
  await service.saveSettings({ gamesRoot, externalRoot, coverArt: false });
  await fs.rename(externalRoot, `${externalRoot}-disconnected`);
  await assert.rejects(service.addGame({ installPath: gamesRoot, name: 'Manual game' }));
  assert.equal(service.library.manualGames.length, 0);
  assert.equal(await fs.stat(externalRoot).catch(() => null), null);
});
