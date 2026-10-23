import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeSaveLocation } from '../electron/save-location.mjs';

const roots = {
  Local: 'C:\\Users\\Player\\AppData\\Local',
  LocalLow: 'C:\\Users\\Player\\AppData\\LocalLow',
  Roaming: 'C:\\Users\\Player\\AppData\\Roaming',
};
const normalize = (input, root = 'Local') => normalizeSaveLocation({ input, root, localRoots: roots, externalRoot: 'E:\\Windows\\AppData' }, path.win32);

test('absolute Windows local and archive locations resolve to portable AppData paths', () => {
  for (const section of ['Local', 'LocalLow', 'Roaming']) {
    assert.deepEqual(normalize(`${roots[section]}\\Studio\\Game\\slot.sav`), { root: section, relativePath: 'Studio/Game/slot.sav' });
    assert.deepEqual(normalize(`E:\\Windows\\AppData\\${section}\\Studio\\Game`), { root: section, relativePath: 'Studio/Game' });
  }
  assert.deepEqual(normalize(' "c:\\users\\player\\appdata\\locallow\\Studio\\Game" '), { root: 'LocalLow', relativePath: 'Studio/Game' });
});

test('environment tokens and AppData prefixes resolve to their actual sections', () => {
  for (const input of ['%LOCALAPPDATA%\\Game\\Saves', '%localappdata%/Game/Saves', 'AppData/Local/Game/Saves', 'Local\\Game\\Saves\\']) {
    assert.deepEqual(normalize(input, 'Roaming'), { root: 'Local', relativePath: 'Game/Saves' });
  }
  assert.deepEqual(normalize('%APPDATA%\\Game\\Saves'), { root: 'Roaming', relativePath: 'Game/Saves' });
  assert.deepEqual(normalize('%LOCALAPPDATA%\\..\\LocalLow\\Studio\\Game'), { root: 'LocalLow', relativePath: 'Studio/Game' });
  assert.deepEqual(normalize('Studio\\Game', 'LocalLow'), { root: 'LocalLow', relativePath: 'Studio/Game' });
});

test('absolute AppData section roots and paths outside the selected archives are rejected', () => {
  for (const input of [...Object.values(roots), 'E:\\Windows\\AppData\\Local', 'C:\\Users\\Player\\AppData', 'C:\\Users\\AnotherPlayer\\AppData\\Local\\Game', 'E:\\OtherArchive\\Local\\Game', 'C:\\Users\\Player\\AppData\\LocalFake\\Game', 'E:\\Windows\\AppData\\Local\\..\\..\\Outside', '\\\\server\\share\\Game']) {
    assert.throws(() => normalize(input), /AppData|section/);
  }
});

test('empty paths, relative traversal, empty segments, and unknown AppData sections are rejected', () => {
  for (const input of ['', ' ', undefined, null, '..', '../Game', 'Game/../Other', 'Game/./save.dat', 'Game//save.dat', 'AppData/Local/../Roaming/Game']) {
    assert.throws(() => normalize(input), /Choose|specific save path/);
  }
  assert.throws(() => normalize('Game', 'Documents'), /Choose Local/);
});
