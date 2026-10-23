import path from 'node:path';

const ROOTS = ['Local', 'LocalLow', 'Roaming'];

export function normalizeSaveLocation({ root = 'Local', input, localRoots, externalRoot }, api = path) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Choose a game save file or folder.');
  let value = input.trim().replace(/^"(.*)"$/, '$1');
  value = value.replace(/^%LOCALAPPDATA%/i, localRoots.Local).replace(/^%APPDATA%/i, localRoots.Roaming);
  const absolute = api.isAbsolute(value);
  if (absolute) {
    const full = api.resolve(value);
    for (const section of ROOTS) {
      for (const base of [localRoots[section], externalRoot && api.join(externalRoot, section)].filter(Boolean)) {
        const relative = api.relative(base, full);
        if (!relative) throw new Error('Select the game’s own save folder, not an AppData section.');
        if (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative)) {
          return { root: section, relativePath: relative.split(api.sep).join('/') };
        }
      }
    }
    throw new Error('The selected path must be inside this computer’s AppData or your external AppData archive.');
  }
  value = value.replaceAll('\\', '/').replace(/\/+$/, '').replace(/^AppData\//i, '');
  const prefixed = value.match(/^(LocalLow|Local|Roaming)\/(.+)$/i);
  if (prefixed) {
    root = ROOTS.find(section => section.toLowerCase() === prefixed[1].toLowerCase());
    value = prefixed[2];
  }
  if (!ROOTS.includes(root)) throw new Error('Choose Local, LocalLow, or Roaming.');
  if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Use a specific save path without parent-directory traversal.');
  return { root, relativePath: value };
}
