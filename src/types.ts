export type AppDataRoot = 'Local' | 'LocalLow' | 'Roaming';
export type Direction = 'to-drive' | 'to-local';
export type SaveStatus = 'synced' | 'local-newer' | 'drive-newer' | 'local-only' | 'drive-only' | 'conflict' | 'empty' | 'error';
export interface Snapshot { exists: boolean; files: number; bytes: number; newest: number | null; fingerprint: string; error?: string }
export interface Mapping { id: string; root: AppDataRoot; relativePath: string; confidence: 'known' | 'suggested' | 'manual'; reason: string; confirmed: boolean; localPath: string; externalPath: string; local: Snapshot; external: Snapshot; status: SaveStatus; token: string; error?: string; sharedWith?: string[]; sharedOn?: {local:string[];external:string[]} }
export interface Game { id: string; name: string; installPath: string; relativeInstallPath: string; steamId?: number; coverUrl?: string; source: string; mappings: Mapping[]; identity?: string; edition?: 'steam'|'standalone'|'unknown'; editionEvidence?: string[] }
export interface Config { gamesRoot: string; externalRoot: string; coverArt: boolean }
export interface HistoryEntry { id: string; at: number; gameName: string; root: AppDataRoot; relativePath: string; direction: Direction; files: number; bytes: number; backupPath?: string; kind?: 'shared' }
export interface ScanResult { games: Game[]; warnings: string[]; scannedAt: number | null }
export type SaveSide = 'local' | 'external';
export interface SharedMember { id: string; gameId: string; mappingId: string; label: string }
export interface SharedCandidate { id: string; at: number; sourceMemberId: string; sourceSide: SaveSide; sourceRoot?:AppDataRoot; sourceRelativePath?:string; fingerprint: string; files: number; bytes: number; newest: number|null }
export interface SharedVerification { candidateId: string; memberId: string; side: SaveSide; fingerprint: string; destinationToken: string; at: number }
export interface SharedGroup { id: string; name: string; members: SharedMember[]; candidates: SharedCandidate[]; verifications: SharedVerification[] }
export interface State extends ScanResult { config: Config; localRoots: Record<AppDataRoot, string>; history: HistoryEntry[]; isWindows: boolean; demo: boolean; sharedGroups: SharedGroup[] }
export interface VaultBridge {
 getState(): Promise<State>;
 chooseDirectory(options: { title: string; defaultPath?: string }): Promise<string | null>;
 chooseSaveLocation(options?: {kind: 'folder'|'file'}): Promise<{root:AppDataRoot;relativePath:string}|null>;
 addGame(options: {installPath:string;name:string}): Promise<State>;
 saveSettings(config: Config): Promise<State>;
 refresh(): Promise<ScanResult>;
 transfer(options: { gameId: string; mappingId: string; direction: Direction; expectedToken: string }): Promise<ScanResult>;
 addMapping(options: { gameId: string; root: AppDataRoot; relativePath: string; replaceAuto?:boolean }): Promise<ScanResult>;
 confirmMapping(options: { gameId: string; mappingId: string }): Promise<ScanResult>;
 removeMapping(options: { gameId: string; mappingId: string }): Promise<ScanResult>;
 getHistory(): Promise<HistoryEntry[]>;
 openPath(options: { target: 'game' | 'local' | 'external' | 'backups'; gameId?: string; mappingId?: string }): Promise<void>;
 onProgress(callback: (message: string) => void): () => void;
 linkEditions(options:{name:string;members:Array<{gameId:string;mappingId:string;label:string}>}):Promise<State>;
 captureShared(options:{groupId:string;memberId:string;side:SaveSide;expectedToken:string}):Promise<State>;
 verifyShared(options:{groupId:string;candidateId:string;memberId:string;side:SaveSide;tested:boolean}):Promise<State>;
 applyShared(options:{groupId:string;candidateId:string;memberId:string;side:SaveSide}):Promise<State>;
 openShared(options:{groupId:string;candidateId?:string}):Promise<void>;
 removeSharedGroup(options:{groupId:string}):Promise<State>;
}
declare global { interface Window { vault: VaultBridge } }
