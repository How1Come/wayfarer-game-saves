import type { SharedGroup } from './types';
export function installDemoBridge() {
  const now = Date.now();
  const listeners = new Set<(message: string) => void>();
  const snap = (age: number, fingerprint: string, files = 4, bytes = 2467840) => ({ exists: true, files, bytes, newest: now - age * 3600000, fingerprint });
  const none = { exists: false, files: 0, bytes: 0, newest: null, fingerprint: 'missing' };
  const definitions = [
    ['ELDEN RING', 1245620, 'Roaming', 'EldenRing', 'local-newer', 2, 30],
    ['Hades', 1145360, 'Local', 'Hades', 'drive-newer', 48, 4],
    ['Stardew Valley', 413150, 'Roaming', 'StardewValley/Saves', 'synced', 18, 18],
    ['Hollow Knight', 367520, 'LocalLow', 'Team Cherry/Hollow Knight', 'local-only', 6, 0],
    ['Celeste', 504230, 'Local', 'Celeste', 'conflict', 8, 9],
    ['Dead Cells', 588650, 'Local', 'Dead Cells', 'drive-only', 0, 72],
  ];
  let games: any[] = definitions.map(([name, steamId, root, relativePath, status, localAge, driveAge], i) => {
    const id = `demo-${i}`;
    return { id, name, steamId, edition: 'steam', source: 'Steam library', installPath: `E:\\Games\\${name}`, relativeInstallPath: String(name),
      coverUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${steamId}/library_600x900.jpg`,
      mappings: [{ id: `${id}-save`, root, relativePath, confidence: i === 5 ? 'suggested' : 'known', confirmed: i !== 5,
        reason: i === 5 ? 'Folder name resembles this game. Verify it before transferring.' : 'Game-save catalog match',
        localPath: `C:\\Users\\Player\\AppData\\${root}\\${String(relativePath).replaceAll('/', '\\')}`,
        externalPath: `E:\\Windows\\Appdata\\${root}\\${String(relativePath).replaceAll('/', '\\')}`,
        local: status === 'drive-only' ? { ...none } : snap(Number(localAge), `${id}-local`, i === 0 ? 3 : 8),
        external: status === 'local-only' ? { ...none } : snap(Number(driveAge), status === 'synced' ? `${id}-local` : `${id}-drive`, i === 0 ? 3 : 8),
        status, token: `${id}-token` }],
    };
  });
  let config = { gamesRoot: 'E:\\Games', externalRoot: 'E:\\Windows\\Appdata', coverArt: true };
  if (new URLSearchParams(location.search).has('setup')) config = { ...config, gamesRoot: '', externalRoot: '' };
  let history: any[] = [];
  let sharedGroups: SharedGroup[] = [];
  const result = () => structuredClone({ games: config.gamesRoot ? games.map(game => ({ ...game, coverUrl: config.coverArt && game.steamId ? `https://cdn.akamai.steamstatic.com/steam/apps/${game.steamId}/library_600x900.jpg` : undefined })) : [], warnings: [], scannedAt: Date.now() });
  const state = () => ({ ...result(), config: { ...config }, localRoots: { Local: 'C:\\Users\\Player\\AppData\\Local', LocalLow: 'C:\\Users\\Player\\AppData\\LocalLow', Roaming: 'C:\\Users\\Player\\AppData\\Roaming' }, history: structuredClone(history), sharedGroups: structuredClone(sharedGroups), isWindows: true, demo: true });
  const progress = async (message: string) => { listeners.forEach(listener => listener(message)); await new Promise(resolve => setTimeout(resolve, 450)); };
  const mappingFor = (gameId: string, mappingId: string) => {
    const game = games.find(item => item.id === gameId);
    const mapping = game?.mappings.find((item: any) => item.id === mappingId);
    if (!mapping) throw new Error('Demo save could not be found.');
    return { game, mapping };
  };
  window.vault = {
    getState: async () => state(),
    chooseDirectory: async ({ title }: { title: string }) => /game|library/i.test(title) ? 'E:\\Games' : 'E:\\Windows\\Appdata',
    chooseSaveLocation: async () => ({root: 'Roaming', relativePath: 'MyGame/Saves'}),
    addGame: async ({installPath,name}) => {
      const existing = games.find(game => game.installPath.toLowerCase() === installPath.toLowerCase());
      if (existing) existing.name = name;
      else games.push({id: crypto.randomUUID(), name, installPath, relativeInstallPath: installPath.split(/[\\/]/).pop(), source: 'Added by you', edition: 'unknown', mappings: []});
      return state();
    },
    saveSettings: async (next: typeof config) => { config = { ...next }; await progress('Discovering your game library…'); return state(); },
    refresh: async () => { await progress('Comparing example saves…'); return result(); },
    transfer: async ({ gameId, mappingId, direction, expectedToken }: any) => {
      const { game, mapping } = mappingFor(gameId, mappingId);
      if (mapping.token !== expectedToken) throw new Error('Refresh before trying again.');
      if (!mapping.confirmed) throw new Error('Confirm the suggested match first.');
      const source = direction === 'to-drive' ? mapping.local : mapping.external;
      if (!source.exists) throw new Error('No source save exists.');
      await progress('Previewing a protected transfer…');
      mapping.local = { ...source }; mapping.external = { ...source }; mapping.status = 'synced'; mapping.token += '-done';
      history.unshift({ id: String(Date.now()), at: Date.now(), gameName: game.name, root: mapping.root, relativePath: mapping.relativePath,
        direction, files: source.files, bytes: source.bytes, backupPath: 'E:\\Windows\\Appdata\\.wayfarer\\backups\\example' });
      return result();
    },
    addMapping: async ({ gameId, root, relativePath, replaceAuto = true }: any) => {
      const game = games.find(item => item.id === gameId);
      if (!game || !relativePath.trim()) throw new Error('Enter a relative save path.');
      relativePath = relativePath.replaceAll('\\', '/');
      const absolute = relativePath.match(/(?:AppData|Appdata)\/(LocalLow|Local|Roaming)\/(.+)$/i);
      if (absolute) { root = ['Local', 'LocalLow', 'Roaming'].find(value => value.toLowerCase() === absolute[1].toLowerCase()); relativePath = absolute[2]; }
      if (relativePath.includes('..') || relativePath.includes(':')) throw new Error('Choose a path inside AppData.');
      game.mappings = game.mappings.filter((mapping: any) => (!replaceAuto || mapping.confidence === 'manual') && !(mapping.root === root && mapping.relativePath.toLowerCase() === relativePath.toLowerCase()));
      const id = `manual-${Date.now()}`;
      game.mappings.push({ id, root, relativePath, confidence: 'manual', confirmed: true, reason: 'Added by you',
        localPath: `C:\\Users\\Player\\AppData\\${root}\\${relativePath}`, externalPath: `${config.externalRoot}\\${root}\\${relativePath}`,
        local: snap(1, id), external: { ...none }, status: 'local-only', token: id });
      return result();
    },
    confirmMapping: async ({ gameId, mappingId }: any) => { mappingFor(gameId, mappingId).mapping.confirmed = true; return result(); },
    removeMapping: async ({ gameId, mappingId }: any) => { const { game } = mappingFor(gameId, mappingId); game.mappings = game.mappings.filter((m: any) => m.id !== mappingId); return result(); },
    linkEditions: async ({name,members}) => {
      sharedGroups.push({id: crypto.randomUUID(),name,members: members.map(member => ({...member,id:crypto.randomUUID()})),candidates:[],verifications:[]});
      return state();
    },
    captureShared: async ({groupId,memberId,side,expectedToken}) => {
      const group = sharedGroups.find(item => item.id === groupId)!;
      const member = group.members.find(item => item.id === memberId)!;
      const {mapping} = mappingFor(member.gameId,member.mappingId);
      if (mapping.token !== expectedToken) throw new Error('Refresh before capturing.');
      const source = side === 'local' ? mapping.local : mapping.external;
      if (!source.files) throw new Error('Source is empty.');
      group.candidates.unshift({id:crypto.randomUUID(),at:Date.now(),sourceMemberId:memberId,sourceSide:side,sourceRoot:mapping.root,sourceRelativePath:mapping.relativePath,fingerprint:source.fingerprint,files:source.files,bytes:source.bytes,newest:source.newest});
      return state();
    },
    verifyShared: async ({groupId,candidateId,memberId,side,tested}) => {
      if (!tested) throw new Error('Confirm a successful isolated test first.');
      const group = sharedGroups.find(item => item.id === groupId)!;
      const candidate = group.candidates.find(item => item.id === candidateId)!;
      if (candidate.sourceMemberId === memberId && candidate.sourceSide === side) throw new Error('This is the original source; choose another target.');
      group.verifications.push({candidateId,memberId,side,fingerprint:candidate.fingerprint,destinationToken:'demo',at:Date.now()});
      return state();
    },
    applyShared: async ({groupId,candidateId,memberId,side}) => {
      const group = sharedGroups.find(item => item.id === groupId)!;
      const candidate = group.candidates.find(item => item.id === candidateId)!;
      if (!group.verifications.some(item => item.candidateId === candidateId && item.memberId === memberId && item.side === side)) throw new Error('Confirm a test first.');
      const member = group.members.find(item => item.id === memberId)!;
      const {game,mapping} = mappingFor(member.gameId,member.mappingId);
      mapping[side === 'local' ? 'local' : 'external'] = {exists:true,files:candidate.files,bytes:candidate.bytes,newest:candidate.newest,fingerprint:candidate.fingerprint};
      mapping.status = mapping.local.fingerprint === mapping.external.fingerprint ? 'synced' : 'conflict';
      mapping.token += '-shared';
      group.verifications = group.verifications.filter(item => !(item.candidateId === candidateId && item.memberId === memberId && item.side === side));
      history.unshift({id:crypto.randomUUID(),at:Date.now(),gameName:game.name,root:mapping.root,relativePath:mapping.relativePath,direction:side === 'local' ? 'to-local' : 'to-drive',files:candidate.files,bytes:candidate.bytes,backupPath:'E:\\Windows\\Appdata\\.wayfarer\\backups\\example',kind:'shared'});
      return state();
    },
    openShared: async () => { throw new Error('Use the Windows app to inspect captured files. This preview uses example data.'); },
    removeSharedGroup: async ({groupId}) => { sharedGroups = sharedGroups.filter(item => item.id !== groupId); return state(); },
    getHistory: async () => structuredClone(history),
    openPath: async () => { throw new Error('Folder access is available in the Windows app. This browser preview uses example data.'); },
    onProgress: (listener: (message: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
