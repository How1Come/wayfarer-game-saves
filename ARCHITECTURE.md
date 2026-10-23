# Wayfarer architecture

Wayfarer 1.1.1 is a portable Windows Electron application with a React, TypeScript, and Vite renderer. CommonJS main/preload modules expose a narrow `window.vault` bridge to Node ESM filesystem modules. Filesystem changes run in the main process. All replacements require an explicit action; timestamps and matching scores never authorize a transfer.

## Components

| Component | Responsibility | Persistent data |
| --- | --- | --- |
| `src/App.tsx`, `src/SharedSaves.tsx` | Library, manual selection, comparisons, explicit replacement and test-confirmation controls | None directly |
| `electron/main.cjs`, `electron/preload.cjs` | Native dialogs, validated IPC, protected renderer, open-folder actions | Electron settings/cache beside the portable executable |
| `electron/service.mjs` | Config, discovery orchestration, mapping precedence, snapshots, history, shared-group authorization | `externalRoot/.wayfarer/library.json` |
| `electron/discovery.mjs` | Recursive installation discovery, catalog matching, reviewed suggestions, manual corrections | Reads bundled catalog and service-supplied mapping metadata |
| `electron/save-location.mjs` | Convert supported absolute or relative save paths into an AppData section and relative path | None |
| `electron/sync.mjs` | Hashing, comparison, guarded copy, full replacement, verified backup, rollback | Destination saves and `externalRoot/.wayfarer/backups` |
| `electron/edition-saves.mjs` | Separate captures, captured-copy integrity, target-bound replacement | `externalRoot/.wayfarer/shared` and backups |
| `src/demo.ts` | Explicitly labeled browser-only examples | In-memory state; no filesystem access |

## Renderer bridge

`State` contains `config`, `localRoots`, `games`, `history`, `sharedGroups`, `isWindows`, `demo`, `warnings`, and `scannedAt`. `ScanResult` contains `games`, `warnings`, and `scannedAt`. Renderer actions reload state to obtain current history and shared-group records.

| Method | Input | Result |
| --- | --- | --- |
| `getState` | None | `State`; performs the initial configured scan when needed |
| `chooseDirectory` | `{title, defaultPath?}` | Absolute directory path or `null` |
| `chooseSaveLocation` | `{kind: 'folder' \| 'file'}`; folder by default | `{root, relativePath}` or `null` |
| `saveSettings` | `{gamesRoot, externalRoot, coverArt}` | `State` after a scan |
| `refresh` | None | `ScanResult` |
| `addGame` | `{installPath, name}` | `State` after adding or correcting the installation |
| `addMapping` | `{gameId, root, relativePath, replaceAuto?}` | `ScanResult`; `replaceAuto` defaults to `true` |
| `confirmMapping` | `{gameId, mappingId}` | `ScanResult` |
| `removeMapping` | `{gameId, mappingId}` | `ScanResult`; no save files removed |
| `transfer` | `{gameId, mappingId, direction, expectedToken}` | `ScanResult` after an explicit ordinary transfer |
| `getHistory` | None | `HistoryEntry[]` |
| `openPath` | `{target: 'game' \| 'local' \| 'external' \| 'backups', gameId?, mappingId?}` | Opens the validated location |
| `onProgress` | Callback receiving a message string | Unsubscribe function |

`direction` is `to-drive` or `to-local`. `root` is `Local`, `LocalLow`, or `Roaming`. Shared-copy methods and their authorization sequence are specified in [the edition contract](docs/edition-contract.md).

## Discovery and manual authority

`discoverGames` accepts `gamesRoot`, `externalRoot`, `localRoots`, `customMappings`, `manualGames`, `ignoredMappings`, `confirmedMappings`, and `onProgress`. It returns games, mapping descriptors, and warnings before the service adds snapshots, comparison tokens, statuses, and cross-game overlap checks.

- Game IDs derive from the installation’s path relative to the selected games root. Manual correction of the same installation preserves its ID.
- Catalog identity describes a confidently identified game. Edition provenance is separate: a Steam app manifest is Steam installation evidence; a Steam ID used for artwork or `steam_appid.txt` does not establish edition compatibility.
- Manual games store `{relativeInstallPath, name}`. Their installation must exist inside the configured games folder. Adding one can also correct an existing game’s title.
- Manual mappings store `{gameId, root, relativePath, replaceAuto}`. Supported absolute paths, native dialog selections, `%LOCALAPPDATA%`, `%APPDATA%`, and relative paths are normalized before use. The resulting path must exist on at least one side.
- A manual mapping with `replaceAuto !== false` suppresses that game’s automatic mappings. Multiple distinct manual locations remain possible; reselecting an automatic location upgrades it to a manual mapping.
- Confirmed manual mappings remain subject to filesystem safety checks. They are user selections, not automatic format-compatibility findings.
- Exact shared paths are accepted for the same confident game identity or when both locations were manually assigned. The service sets `sharedWith` and side-specific `sharedOn` so the UI can explain which local or external paths are used by multiple installations. Overlap checks compare resolved physical paths on each side, including differently named AppData sections that are redirected to one folder.
- For other cross-game overlaps, a manual assignment takes precedence over one conflicting automatic match. Ambiguous parent/child or competing mappings are blocked with a reason; confirmation alone does not bypass that error.

A mapping can identify a file or a folder. The app rejects AppData section roots, traversal, prohibited broad application roots, symlinks/junctions, and unsafe locations. Discovery searches local and external roots so drive-only saves can be restored on a new computer.

## Snapshots and ordinary transfers

`Snapshot` contains `{exists, files, bytes, newest, fingerprint, error?}`. `newest` is an epoch-millisecond modification time. SHA-256 fingerprints include file paths and contents. `compareSnapshots(local, external, baseline?)` returns `synced`, `local-newer`, `drive-newer`, `local-only`, `drive-only`, `conflict`, `empty`, or `error`. `comparisonToken` binds the current two-sided comparison to an action. Baselines are scoped to the machine and mapping.

`transferSave` receives the trusted local AppData section, external AppData root, section and relative path, direction, expected comparison token, backup root, game name, and progress callback. It stages and checks the source, backs up and verifies an existing destination, rechecks the original source and destination, and replaces the entire mapped file or folder. It preserves modification times and attempts rollback on replacement failure. Missing or empty sources, stale comparisons, links, overlap, and unreadable files block transfer.

Backups contain transaction metadata and the original destination under its AppData section and relative path. History records `{id, at, gameName, root, relativePath, direction, files, bytes, backupPath?}`; shared applications also carry `kind: 'shared'`. Neither normal nor shared transfer provides a crash-proof filesystem transaction or locks files against a running game.

## Portability and shared-copy authorization

Config is stored beside the executable. Paths on the executable’s volume are represented relative to its directory so drive-letter changes retain the layout. Current local roots are computed at launch for the current Windows account; a previous computer’s profile path is not restored.

Library metadata stores reviewed/manual mappings, manual games, ignored mappings, per-machine baselines, history, and shared groups. Version 1.0 metadata is migrated by defaulting missing manual-game and shared-group arrays to empty arrays.

A shared group links existing confirmed mappings. Capturing creates a new separate payload; it does not modify originals. The payload’s recorded fingerprint is checked before test confirmation and replacement. The app does not rewrite captured payloads or prevent external programs from editing them; edited contents invalidate the capture.

Successful isolated testing is a user attestation. The service records a candidate fingerprint, target snapshot token, resolved target path, target side, machine, and time. It additionally retains the full attested proof and original source path in an in-memory map for that exact group/candidate/member/side tuple. Reloaded metadata and the source and target game descriptors must match this proof. Correcting a linked game identity revokes its confirmation, even if its stable mapping ID and save path remain the same. An equal or overlapping source/target path is rejected. Stored metadata alone cannot authorize a new session. Successful application consumes the session confirmation, and changes to the target or candidate block application.

Only the explicitly selected target is replaced after backup. Group removal deletes metadata only. The service does not convert formats, rebind accounts, merge profiles, execute test games, or infer compatibility from names or file extensions.
