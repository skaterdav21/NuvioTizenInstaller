# TV Setup

Phone app that sets up TVs and streaming boxes from Android: installs the best Nuvio build for the device, swaps in a clean home screen, and removes ads and tracking without breaking anything.

| Device | Nuvio | Home screen | Ads & tracking |
|---|---|---|---|
| Samsung (Tizen 4+) | Nuvio Legacy native TPK, signed for the TV | n/a | Settings checklist |
| LG (webOS, Developer Mode) | Nuvio Legacy IPK | TV Home (generated per TV) | Settings checklist, Dev Mode kept alive |
| NVIDIA Shield, Sony, onn, other Android/Google TV | Official or Legacy lite | Horizon Home or CleanYourTV launcher | Tested per-model lists + guards, optional NextDNS |
| Fire TV | Official or Legacy lite | Locked by Amazon | Tested per-model lists + guards |

## Layout

- `nodejs-project/` the app's Node side (runs in nodejs-mobile on the phone) and its UI.
  - `src/core/` ADB client (auth, flow control), Wi-Fi scan, downloads, jobs, storage.
  - `src/platforms/` Android TV, LG, Samsung engines; `debloat.js` list matching and guards.
  - `src/main.js` the original Samsung Tizen installer logic.
  - `src/data/lists.json` generated from CleanYourTV by `scripts/gen_lists.py`.
  - `ui/index.html` the interface.
- `base/` the Android shell APK (WebView + nodejs-mobile). CI renames it, swaps in `nodejs-project/` and signs it.
- `tests/` mock Android TV (real ADB framing and RSA auth), mock LG TV (SSH/SFTP), end-to-end tests.

## Releasing

Bump `VERSION`, add a `CHANGELOG.md` entry, push. CI tests, builds the launcher from CleanYourTV, builds and signs the app, and publishes:

https://github.com/skaterdav21/NuvioTizenInstaller/releases/latest/download/NuvioTizenInstaller.apk

## Credits

Horizon home screen: [Horizon Home Kit](https://github.com/jyotiprakash101/horizon-home-kit) (MIT). Debloat lists and minimal home screen: [CleanYourTV](https://github.com/Gathin23/cleanyourtv) (MIT). Nuvio Legacy: [iqui27/nuvio-native-legacy](https://github.com/iqui27/nuvio-native-legacy). Nuvio: [NuvioMedia](https://github.com/NuvioMedia). Font: Archivo (OFL).
