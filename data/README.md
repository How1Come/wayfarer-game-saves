# Offline game catalog

Generated 2026-09-20T02:34:40.602Z from the [official Ludusavi manifest](https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml).

53186 game identities, 11378 with supported AppData paths, 16674 AppData rules. Source SHA-256: `ecfa2b7e369e8f33b928eafa6996ddfd9f85613c37d55433166eab60bf648615`.

Ludusavi Manifest is Copyright (c) 2020 Matthew T. Kennerly (mtkennerly), distributed under the MIT license in [LUDUSAVI-LICENSE.txt](./LUDUSAVI-LICENSE.txt). Its primary manifest is compiled from PCGamingWiki and Steam installation-directory metadata.

This is a restricted derivative: Windows Local, LocalLow and Roaming paths only. Registry, Documents, Saved Games, installation-directory saves and unresolved placeholders are excluded. Broad shared publisher or engine directories are excluded. Wildcards select individual existing files/folders on either computer or drive; account folders retain their names. No secondary manifests or executable code from games are loaded.

Run `npm run catalog:update` to rebuild from the current upstream catalog, or `node scripts/update-catalog.mjs manifest.yaml` to compile a reviewed local copy. Updating the catalog is a developer action; the packaged app works offline.
