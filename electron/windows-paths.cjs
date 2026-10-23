const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const LOCAL_LOW_QUERY = "$ErrorActionPreference='Stop'; $p=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders').'{A520A1A4-1780-4FF6-BD18-167343C5AF16}'; if($p){[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::ExpandEnvironmentVariables($p))))}";

async function resolveLocalRoots(home, { platform = process.platform, env = process.env, execute = promisify(execFile) } = {}) {
  const api = platform === 'win32' ? path.win32 : path;
  const roots = {
    Local: env.LOCALAPPDATA || api.join(home, 'AppData', 'Local'),
    LocalLow: api.join(home, 'AppData', 'LocalLow'),
    Roaming: env.APPDATA || api.join(home, 'AppData', 'Roaming'),
  };
  if (platform === 'win32') {
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LOCAL_LOW_QUERY], { timeout: 5000, windowsHide: true });
      const encoded = stdout.trim();
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        if (api.isAbsolute(decoded) && !decoded.includes('\0')) roots.LocalLow = decoded;
      }
    } catch { }
  }
  return roots;
}
module.exports = { resolveLocalRoots };
