# Version 1.1.1 edition and manual-location contract

This contract documents manual mapping authority and the explicit shared-copy workflow. Game identity, installation provenance, and save-format compatibility are separate facts. No automatic match or shared-group link authorizes replacement across editions.

## Manual discovery corrections

| Field or action | Contract |
| --- | --- |
| `Game.identity` | Optional canonical catalog identity when the game is confidently identified |
| `Game.edition` | `steam`, `standalone`, or `unknown`; Steam artwork alone is not edition evidence |
| `addGame({installPath, name})` | Add or correct an existing installation inside the configured games root; persist its relative installation path and title |
| `chooseSaveLocation({kind})` | Native folder or file dialog; normalize a supported local/archive selection into `{root, relativePath}`; cancellation returns `null` |
| `addMapping({gameId, root, relativePath, replaceAuto})` | Accept a supported relative or absolute path; normalize it; require it to exist locally or externally; default `replaceAuto` to `true` |
| `replaceAuto: true` | Retain the game’s manual mappings and suppress its automatic guesses |
| `replaceAuto: false` | Retain valid automatic mappings alongside the selected manual location, subject to overlap rules |
| `Mapping.sharedWith` | Optional names of installations using an exact accepted save path on either side |
| `Mapping.sharedOn` | Optional `{local: string[], external: string[]}` identifying the side with the shared physical path |

Manual selections are confirmed as selections made by the user. They still undergo path containment, existence, link, overlap, and transfer checks. Selecting an existing automatic mapping upgrades it to manual. Exact shared paths for one confident game identity, or two explicit manual assignments, refer to the same files; they do not establish compatibility between independent formats. In other overlaps, a single manual assignment takes precedence over the conflicting automatic match; unresolved parent/child and competing assignments remain blocked. These checks compare resolved local and external physical paths and cover redirected AppData roots that overlap.

Steam app manifests establish Steam provenance. A catalog Steam ID can supply cover art for an installation with unknown provenance. `steam_appid.txt` can identify a game without proving launcher origin or save compatibility. Game IDs remain tied to relative installation paths when a title is corrected.

## Shared-copy data

State includes `sharedGroups`, defaulting to an empty array for older libraries. Captures are separate payloads under `externalRoot/.wayfarer/shared/<groupId>/<candidateId>/payload`. Each capture has a fresh identifier and stored fingerprint. Wayfarer does not mutate a recorded capture; external modification is detected and invalidates it.

| Record | Fields |
| --- | --- |
| `SharedMember` | `{id, gameId, mappingId, label}` |
| `SharedCandidate` | `{id, at, sourceMemberId, sourceSide, fingerprint, files, bytes, newest}`; service metadata also records `sourceRoot` and `sourceRelativePath` |
| `SharedVerification` | `{candidateId, memberId, side, fingerprint, destinationToken, at}`; persisted service metadata additionally binds the machine and resolved target path |
| `SharedGroup` | `{id, name, members, candidates, verifications}` |

`side` and `sourceSide` are `local` or `external`. A member identifies an actual game/mapping endpoint. Labels and both original paths remain visible so similarly named installations can be distinguished. The current UI links two locations; the service accepts 2–10 unique member endpoints.

## Bridge operations

| Method | Input | Effect |
| --- | --- | --- |
| `linkEditions` | `{name, members: [{gameId, mappingId, label}]}` | Return `State` after linking unique, confirmed, error-free mappings; no save files replaced |
| `captureShared` | `{groupId, memberId, side, expectedToken}` | Return `State` after copying a checked current source into a new separate candidate; no original replaced |
| `verifyShared` | `{groupId, candidateId, memberId, side, tested}` | Require `tested === true`, validate candidate integrity and current target, and record a session-bound test confirmation; no original replaced |
| `applyShared` | `{groupId, candidateId, memberId, side}` | Require that exact candidate/target/side to be confirmed in this session; verify, stage, back up, recheck, and replace the selected target; return `State` |
| `openShared` | `{groupId, candidateId}` | Open the selected capture’s folder containing its payload; never execute it |
| `removeSharedGroup` | `{groupId}` | Remove group metadata and return `State`; retain original saves and captured files |

Standard `transfer` remains an explicit PC/drive transfer for one mapping. It is separate from applying a shared candidate to another edition’s mapping.

## Test and replacement authorization

1. Link actual save locations and choose the source member and side.
2. Capture a separate copy using the current comparison token. Hash and recheck the source before accepting the capture.
3. Select the exact capture, target member, and target side. Open the captured folder for inspection.
4. Copy the payload into a separate test profile or installation and load it in the selected target edition. Keep the recorded payload and active originals unchanged during the test.
5. Explicitly attest that the exact copy loaded successfully. The checkbox starts unchecked and resets when the selected copy or target changes. Wayfarer validates the files; the user performs the gameplay test.
6. Review the target path and confirm backup plus full replacement. Enable application only for the exact confirmed selection.

Unknown compatibility is displayed as unverified with originals protected. If isolated testing cannot be performed safely, keep the saves separate. Compatibility is not inferred from game identity, filenames, extensions, timestamps, JSON structure, or apparent similarity.

The recorded proof binds the candidate ID and fingerprint, target member, target side, resolved destination path, destination snapshot token, and machine. An in-memory map retains the full attested proof, source and target game descriptors, and captured source path for the current service session. Reloaded metadata must match that proof; editing stored fingerprints or destination tokens cannot replace the attestation. Restarting the app, changing a linked game’s identity, or moving to another computer requires new test confirmation. Successful application consumes the confirmation. A changed candidate requires a new capture and test; a changed target requires review and a new confirmation. Switching to a different candidate or target does not inherit another selection’s proof.

Application allows a missing target only after the same explicit successful isolated-test confirmation; the token then binds the target’s missing state. Existing source and target must both be files or both be directories. The destination must not equal or overlap the captured source location. Stored metadata alone cannot bypass these checks.

## Filesystem module

`electron/edition-saves.mjs` exports these operations:

| Function | Input | Output and checks |
| --- | --- | --- |
| `captureCandidate` | `{externalRoot, groupId, sourcePath, expectedSnapshot, onProgress}` | `{id, at, fingerprint, files, bytes, newest}` after a separate copy, hash validation, and source recheck |
| `candidatePath` | `{externalRoot, groupId, candidateId}` | Validated absolute payload path; restrict identifiers and reject unsafe paths |
| `verifyCandidate` | `{externalRoot, groupId, candidate, destinationPath}` | `{fingerprint, destinationToken, targetPath}` after checking integrity, target snapshot, overlap, and file/directory type |
| `applyCandidate` | `{externalRoot, groupId, candidate, destinationPath, destinationRoot, relativePath, verification, gameName, root, side, onProgress}` | `HistoryEntry` after exact-proof checks, staging, verified backup, final rechecks, replacement, and rollback handling |

`destinationRoot` is a trusted current local AppData section or the corresponding section inside the configured external root. The module validates the resolved destination against it. Shared storage and backups are not valid original edition locations. Missing/empty sources, altered captures, stale destinations, links, invalid IDs, and unsafe overlap block replacement.

An existing destination is backed up below `externalRoot/.wayfarer/backups/shared-<transactionId>`. Metadata records its original path, AppData section, relative path, direction, fingerprint, and candidate ID. A successful application records `kind: 'shared'` in transfer history. The copy and backup mechanisms preserve contents and file times; they do not guarantee crash-proof transactions or protect against all concurrent game writes.

The browser demo uses in-memory equivalents and remains clearly labeled. Automated or browser checks do not establish Windows runtime behavior or compatibility with any real game edition pair.
