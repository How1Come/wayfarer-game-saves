import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalRoots } from '../electron/windows-paths.cjs';

test('Windows redirected LocalLow preserves Unicode paths across PowerShell encoding', async () => {
  const redirect = 'D:\\游戏数据\\玩家 小明\\LocalLow';
  const roots = await resolveLocalRoots('C:\\Users\\小明', { platform: 'win32', env: { APPDATA: 'R:\\Roaming\\小明', LOCALAPPDATA: 'C:\\Users\\小明\\AppData\\Local' },
    execute: async (_exe, args) => {
      assert.match(args.join(' '), /ToBase64String/);
      return { stdout: Buffer.from(redirect, 'utf8').toString('base64') };
    } });
  assert.equal(roots.LocalLow, redirect);
  assert.equal(roots.Roaming, 'R:\\Roaming\\小明');
  assert.equal(roots.Local, 'C:\\Users\\小明\\AppData\\Local');
});

test('default Windows profile paths work when PowerShell is unavailable', async () => {
  const roots = await resolveLocalRoots('C:\\Users\\Player', { platform: 'win32', env: {}, execute: async () => { throw new Error('disabled'); } });
  assert.deepEqual(roots, { Local: 'C:\\Users\\Player\\AppData\\Local', LocalLow: 'C:\\Users\\Player\\AppData\\LocalLow', Roaming: 'C:\\Users\\Player\\AppData\\Roaming' });
});

test('invalid registry result never replaces the normal LocalLow path', async () => {
  const roots = await resolveLocalRoots('C:\\Users\\Player', { platform: 'win32', env: {}, execute: async () => ({ stdout: Buffer.from('../outside').toString('base64') }) });
  assert.equal(roots.LocalLow, 'C:\\Users\\Player\\AppData\\LocalLow');
});
