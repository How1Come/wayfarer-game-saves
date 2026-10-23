# Verification record

## GitHub source preparation · 2026-10-24

- `npm test`: 86 passing tests on macOS after removing first-party code comments.
- `npm run build`: TypeScript and production renderer compilation pass.
- All 21 JavaScript and TypeScript source, test, and configuration files parse without comments. The seven edited files have identical normalized syntax trees before and after comment removal.
- Python, CSS, HTML, and workflow checks found no comments. Third-party licenses and attribution remain included.
- Windows runtime testing remains outstanding; these checks do not establish game compatibility.

## Version 1.1.1 · 2026-10-03

- `npm test`: 86 passing tests on macOS, including game-identity corrections, redirected AppData parent/child conflicts, proof revocation after changed destination refresh, and preservation of originals.
- `npm run build`: TypeScript and production renderer compilation pass.
- Browser production-preview checks show duplicate titles distinguished by edition and installation, captured and destination timestamps/file counts displayed, and replacement disabled before test confirmation. No page JavaScript errors or desktop horizontal overflow were reported.
- Screenshots: [library](images/library-1.1.1.png) and [shared saves](images/shared-saves-1.1.1.png). They contain demo data and do not verify real-game compatibility.

Windows execution still requires testing on a Windows machine.

## Earlier checks

Version 1.1 was checked on macOS on 2026-09-27. These results describe actual checks, not Windows certification or compatibility with a particular game pair.

## Completed source checks

- `npm test`: 75 passing tests, using isolated temporary directories and actual filesystem operations.
- `npm run build`: TypeScript and Vite production compilation pass.
- Node syntax checks pass for the main process, preload, discovery, service, and shared-copy modules.
- The browser production preview completed manual absolute-path confirmation, adding a game, linking locations, capturing a separate copy, recording a simulated test confirmation, explicit replacement, and history updates. Review status cleared after manually selecting a previously suggested path.
- Replacement controls remained disabled without test confirmation. A successful simulated application consumed confirmation. A new capture selected the new copy and did not inherit confirmation.
- Browser layouts at desktop and 980 × 850 had no horizontal page overflow. No application JavaScript page errors were reported. The browser used explicitly labeled in-memory sample data, not real game saves.

Screenshots are in `artifacts/shared-saves-1.1.png` and `artifacts/shared-saves-compact-1.1.png`. The illustrated Moon Orchard editions are fictional demo fixtures.

## Filesystem coverage

- Detection: recursive libraries, Steam manifests/app IDs, GOG and Unity metadata, nested Unreal binaries, uncertain title suffixes, fallback suggestions when catalog paths are absent, manual game corrections, and drive-only saves.
- Manual authority: absolute Windows local/archive paths, AppData prefixes and environment variables, automatic-to-manual upgrades, manual file/child paths, restart persistence, identical shared paths, and conflicting automatic mappings.
- Portability: drive-letter changes, a second computer profile, redirected and Unicode AppData paths, and settings without configured or connected roots.
- Comparison: SHA-256 detection of equal-size edits with unchanged modification times, independent timestamps, baseline conflicts, and stale comparison tokens.
- Ordinary transfer: stage and verified backup, both transfer directions, missing destinations, single-file saves, retained modification times, source changes, path traversal/link rejection, and rollback including recovery failures.
- Shared copies: originals preserved during capture, empty/stale source rejection, altered candidate detection, exact candidate/target/side proof, changed target rejection, source aliases blocked, verified backup, replacement rollback, and incomplete backup cleanup.
- Authorization: explicit successful-test attestation required, restart and library-switch expiry, confirmation consumed after applying, and persisted metadata edits unable to replace session-bound proofs.

## Windows testing still required

No Windows host is available in this workspace. The executable has not been launched on Windows. Actual file locks, permissions, LocalLow registry queries, NTFS/exFAT behavior, drive removal, SmartScreen behavior, and game compatibility remain Windows test cases. Mocked faults are not equivalent to abrupt USB disconnection or power loss.

Wayfarer does not run the game compatibility test, convert save formats, or make arbitrary saves universal. A shared copy remains separate until the user confirms a successful isolated test of that exact copy in the target edition and explicitly chooses replacement. Existing destinations are backed up. If testing cannot be performed safely, keep the editions separate.

Use the [Windows checklist](windows-testing.md) with disposable saves first. The unsigned x64 build is the packaging target; ARM64 is configured but untested. Saves outside AppData remain outside this version's scope.
