## 1.6.1

- Fixed: Samsung upload stalling with "TV stopped acknowledging the upload (no reply in 30s)" and then "TV did not open the upload channel". The app now sends the package in 4 KB packets, one record each, which is the size it tells the TV to expect (1.6.0 sent up to 256 KB at a time and older Tizen builds lock up on that).
- Uploads keep a few packets in flight and carry on if a TV doesn't confirm each one, then check the file size on the TV before installing.
- If an upload attempt does fail, the app opens a fresh connection to the TV before retrying, since a stalled connection stays stuck.
- New test with three simulated Samsung TVs (strict 4 KB, no confirmations, normal) runs on every build.

## 1.6.0

- **Horizon Home** (from [Horizon Home Kit](https://github.com/jyotiprakash101/horizon-home-kit), MIT) is now a home screen choice for Android TV and Google TV, next to the minimal CleanYourTV one. Artwork backdrop, Nuvio's Continue Watching row, streaming-service pages powered by Nuvio, a Live TV guide, and memory/weather in the top bar. Recommended on boxes with enough memory.
  - Installed with its permissions (TV guide, memory panel), Home set to Horizon, and its Home-button service turned on. On Android TV the stock home can be turned off; on Google TV it stays so casting keeps working.
  - Your greeting name, TMDB key, Live TV link and NextDNS profile (Settings > Horizon Home) are handed to Horizon during setup.
- **Network-wide ad blocking via NextDNS** (Horizon Kit's ad-block script, ported): sets the TV's private DNS to your NextDNS profile. Undo restores the previous DNS.
- Undo also removes Horizon and its Home-button service.

## 1.5.1

- Fixed: LG "Set up the clean home screen" failed with `EACCES ... /tmp/tvhome-*.ipk`. Android apps can't write to /tmp; TV Home is now built in the app's own temp folder.

## 1.5.0

- **LG: clean home screen.** Setup now installs **TV Home**, a home screen built on the phone from the apps actually installed on that LG TV: Nuvio as the big first tile, then your streaming apps, then Live TV, HDMI inputs and Settings. Remote D-pad and Magic Remote pointer both work. It opens at the end of setup.
- On a rooted LG (Homebrew Channel), TV Home can open by itself when the TV turns on. Without root, LG keeps the Home button for its own screen, so the plan screen shows how to put TV Home first in the app list and on a Quick Access number key.
- LG setup detects root and an existing TV Home install.

## 1.4.0: TV Setup

The app is now **TV Setup**: one phone app to set up Samsung, LG, NVIDIA Shield, onn, Sony, other Android/Google TV and Fire TV.

- **New interface.** Your TVs, Wi-Fi scan that finds TVs and says whether developer mode is on, per-device enable steps with a live "ready" check, a plan screen, and a step-by-step progress screen.
- **Android TV, Google TV, Fire TV** (new ADB engine with RSA auth and flow control):
  - Nuvio: official app or Nuvio Legacy lite (recommended on low-RAM boxes), or your own APK. 32/64-bit picked automatically.
  - Clean home screen (CleanYourTV launcher) with Nuvio first in the dock. Full replacement on Android TV; Home-button redirect on Google TV so casting keeps working.
  - Ads, tracking and bloat removal from CleanYourTV's 531 tested device lists, matched to your exact model, reviewable, with safety guards (home screen, HDMI/tuner inputs, Settings, Wi-Fi owner). Turned off, never uninstalled.
  - Speed tweaks: faster animations, apps pre-compiled.
  - Optional SmartTube.
  - Undo restores everything.
- **LG webOS** (new): Nuvio Legacy IPK straight from the phone via Developer Mode (key server + SSH), and the Developer Mode session is extended every time the app opens.
- **Samsung**: same proven installer, now in the step UI with model-based Tizen version detection.
- Prepare ahead covers every saved TV; optional "keep every build" for setting up TVs with no internet.

Signed with the same key as 1.3.x and the same package id, so it installs over 1.3.3 and keeps the Samsung certificate.

## 1.3.3

- Fixed: large uploads to the TV (the 35 MB Nuvio Legacy TPK) were sent without ADB flow control, so the TV could end up with a partial file and `vd_appinstall` hung. Uploads now send one packet at a time, wait for the TV's acknowledgement, and wait for the TV to confirm the file was written.
- Upload progress every 10% with speed, and up to 3 attempts if the TV drops the upload.
- The uploaded file size is now checked on the TV (sync STAT) before installing, instead of `ls`, which never answered on the direct connection.
- TPK installs get 7 minutes instead of 3.

## 1.3.2

- Samsung sign-in now opens in Chrome by default ("Sign in with Chrome"). The in-app WebView sign-in failed with ERR_CONNECTION_CLOSED on account.samsung.com. Chrome returns the login to the app through the same localhost:4794 callback. In-app sign-in and Copy link stay as fallbacks.

## 1.3.1

- New: **Prepare ahead** card. Downloads the selected builds and pre-signs them with every saved TV certificate, so Install at the TV only connects, uploads and installs. Runs automatically when the app opens (toggle in the card).
- Signed packages are cached by package content and certificate; repeat installs skip signing.
- Nuvio Legacy remembers the build detected for each TV IP, skipping the slow version check next time.
- If GitHub is unreachable, Install uses the newest downloaded Nuvio Legacy build.
- Downloads show progress every 10% and are written to a temp file first, so a cut-off download is never used.

## 1.3.0

- New: **Nuvio Legacy (native, fast)** install option. Pulls the latest release from iqui27/nuvio-native-legacy, picks the TPK for the TV's Tizen version (auto-detect or pick the TV year), signs it with the TV's saved Samsung certificate, and installs it next to the web Nuvio.
- New: Launch Legacy button.
- Nuvio (web) and Plex are now unchecked by default.
- TPK installs fall back to `pkgcmd` if `vd_appinstall` refuses the package.
- Local package picker accepts `.tpk` files.

Signed with a new key: uninstall 1.2.3 before installing this one. Back up the Samsung certificate first if you want to keep it.
