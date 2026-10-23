# Windows test checklist

This is a procedure for testing Wayfarer 1.1.1, not a record of completed Windows tests. The x64 portable executable is unsigned. Windows may show an unknown-publisher warning. Use disposable saves and a separate test archive before transferring valuable progress.

## Setup and ordinary transfers

1. Copy `Wayfarer-1.1.1-win-x64.exe` to a writable folder on your external drive. Keep its adjacent `.wayfarer` folder with it when moving or upgrading the executable.
2. Open it on Windows 10 or 11 x64 without administrator rights. No installation or Node.js is needed.
3. Select your external Appdata parent folder, such as `E:\Windows\Appdata`, then your games parent folder, such as `E:\Games`. Choose **Find my games**.
4. Inspect detected games and save paths. Confirm suggested locations only after checking that they belong to the selected game.
5. Close the game and allow cloud sync to finish. Choose **Refresh**, select one disposable save, then choose **PC → drive**. Check the exact source and destination before confirming.
6. Verify the copied files. Modify a disposable copy, repeat replacement, and inspect `Appdata\.wayfarer\backups` for the displaced destination and metadata.
7. Repeat **Drive → PC** with a disposable destination. Verify full replacement, retained modification times, displayed status, and transfer history.
8. Restart with the drive assigned another letter. Check that the same relative folder layout resolves correctly. Check a second Windows account or computer to confirm that local paths refer to its current profile.

## Manual games and save locations

1. Use **Add game** for an undiscovered installation inside the configured games folder. Use **Correct game identity** to fix an existing installation's title.
2. Use **Add save location** and browse separately for a folder and a file. Test local Local, LocalLow, and Roaming selections, then the corresponding external archive sections.
3. Check that each selection resolves to the correct AppData section and relative path. Repeat with a pasted supported absolute path and `%APPDATA%` or `%LOCALAPPDATA%` path.
4. Leave **Replace automatic guesses for this game** selected. Confirm that incorrect automatic paths disappear and chosen manual paths remain. Add a second manual location and check that both are retained.
5. Select an automatic location manually and confirm that it becomes a manual match. Select an AppData section root or an unsupported outside path and check that it is rejected without modifying saves.
6. Restart and confirm that game corrections and manual locations persist on the drive.
7. Inspect two accepted mappings at the same exact path. Check the explanation identifying whether this PC, the drive, or both sides share the files. Replacement affects every installation using that path.
8. Test unrelated parent/child mappings with disposable data. Confirm that unsafe overlaps block transfer. If AppData sections are redirected to overlapping folders, confirm that those conflicts are detected too.

## Shared copies between editions

1. Prepare separate disposable source and target saves. Verify each edition's installation label and save mapping before linking it in **Shared saves**.
2. Choose **Link editions** and create a group from two confirmed locations. Check that linking changes neither original. Select the source edition and PC or external side explicitly.
3. Choose **Capture copy** and open its folder. Inspect the separate `payload` under `Appdata\.wayfarer\shared`. Check that the original source and target remain intact.
4. Select the capture, target edition, and target side. Confirm that replacement is disabled while compatibility is unverified and the test box is unchecked.
5. Copy the payload into a separate test profile or test installation. Keep the stored capture unchanged. Use the target edition's expected filename for a file save, or its expected save folder for a folder save. Load the copy in the target edition and check the expected progress. Do not test by replacing the active original save.
6. Record the test confirmation only after that isolated load succeeds. Review the exact target path, close the game, and choose **Back up & replace target**. Inspect the replacement and backup. Confirm that the original source and captured copy remain intact.
7. Confirm that successful replacement consumes the test confirmation. Check that a new capture, another target, or a different target side does not inherit it.
8. Restart Wayfarer and confirm that saved metadata alone does not enable replacement. Correct a linked game identity and confirm that its previous compatibility confirmation expires.
9. Change a disposable target after confirmation, then refresh. Confirm that the visible confirmation expires and replacement stays blocked. Change a disposable capture and check that its integrity failure also blocks replacement.
10. Remove a group and verify that its original saves and captures remain on disk.

A successful file copy does not prove that a game can load it. Wayfarer does not convert formats, merge account folders, remove encryption, or guarantee Steam/standalone compatibility. If safe isolated testing is unavailable, keep the edition saves separate.

## Failure and platform checks

Use disposable data for these checks. Do not simulate unexpected USB removal with valuable saves.

| Case | Expected result |
| --- | --- |
| Source changes after refresh | Replacement is rejected; refresh is required. |
| Missing or empty source | Replacement is rejected. |
| Symbolic link or junction in a save path | Replacement is rejected. |
| Locked or unreadable file | An actionable error is shown; inspect any reported recovery path. |
| Insufficient free space | Transfer fails without accepting an incomplete backup as verified. |
| Disconnected drive | The configured root is not silently recreated elsewhere. |
| Redirected or Unicode profile path | Paths resolve to the current account's actual supported AppData sections. |
| NTFS or exFAT external drive | File contents, supported modification times, backups, and replacement behavior are checked on that filesystem. |

Real Windows file locks, permissions, LocalLow registry queries, drive removal, and USB filesystem behavior require tests on the target machine and drive. Mocked failures do not establish power-loss or disconnection safety.

## Recover a backup

Each transfer replaces a whole selected file or folder rather than merging it. Existing destinations are backed up under `Appdata\.wayfarer\backups`; the **Backups** control opens that folder. Automatic backup deletion is not implemented.

1. Close the game and let its cloud client finish syncing. Preserve the current destination elsewhere if you need to keep it too.
2. Open the transaction's `metadata.json`. Check `gameName`, `root`, `relativePath`, `direction`, and the transaction time. Its `originalPath` is historical and may name a different account or drive letter.
3. Locate the previous data inside that transaction's Local, LocalLow, or Roaming subtree.
4. For `to-local`, restore the data under the current computer's corresponding AppData section plus `relativePath`. For `to-drive`, restore under the configured external Appdata parent plus `root` and `relativePath`.
5. Refresh Wayfarer and inspect the restored files before loading the game.

An interrupted replacement may leave a `.wayfarer-rollback-*` folder beside the destination. Preserve that folder and any verified external backup until recovery is complete. Read paths reported in the error before removing staging or rollback files. The app attempts rollback on replacement errors but does not guarantee crash-proof transactions or lock files against a running game.

## Scope and records

Supported locations are AppData Local, LocalLow, and Roaming. Documents, Saved Games, registry keys, Steam userdata, cloud saves, and saves inside installations are outside this version's scope. The x64 build is the packaging target; ARM64 is configured but unvalidated.

- [Main guide](../README.md)
- [Dated verification record](verification.md)
- [Edition and manual-location contract](edition-contract.md)
