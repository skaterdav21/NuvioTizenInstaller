# Nuvio Tizen Installer

Android app that installs Nuvio, Nuvio Legacy and Plex onto a Samsung Tizen TV from the phone, over the TV's developer connection. Runs a Node.js installer (nodejs-mobile) behind a WebView UI.

## Layout

- `nodejs-project/` the app's Node side and UI (`server.js`, `src/main.js`, `ui/index.html`). This is what you edit.
- `base/` the original 1.2.3 APK, used as the Android shell. CI swaps in `nodejs-project/` and re-signs it.
- `scripts/repack.py` the repack step.
- `.github/workflows/build.yml` builds, signs and publishes a release on every push to `main`.

## Releasing

Bump `VERSION`, add a `CHANGELOG.md` entry, push. The latest APK is always at:

https://github.com/skaterdav21/NuvioTizenInstaller/releases/latest/download/NuvioTizenInstaller.apk

Needs repo secrets `SIGNING_KEYSTORE_B64` (base64 of the keystore, alias `nuviotizen`) and `SIGNING_PASSWORD`. Keep the same keystore so updates install over the top.
