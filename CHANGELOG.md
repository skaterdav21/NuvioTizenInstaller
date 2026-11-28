## 1.10.0

- **Rooted LG TVs: full Home takeover.** New **LG TV (rooted)** option for TVs with Homebrew Channel (root status ok, SSH on). TV Setup signs in as root (Homebrew Channel's default password once, then a key it leaves on the TV), installs TV Home, Nuvio Legacy and LG Input Hook, makes the **Home button open TV Home** instead of LG's home bar, opens TV Home at power-on, and can point the Netflix, Prime Video and Disney+ buttons at Nuvio. On the TV's page: **Learn a button** for other remotes, and **Give Home back to LG** to undo. Your own Input Hook bindings are left alone.
- **LG root check.** Setting up an LG through Developer Mode now reads its webOS and firmware version and says whether it's likely rootable (DejaVuln, faultmanager, the 2026 webOS 10 kernel exploit), with a reminder to hold off LG updates. TV Setup doesn't root TVs itself.
- Backups no longer include LG Developer Mode keys or passphrases.

## 1.9.0

- **Good-looking home screens (Android TV, Google TV, Fire TV).** The clean home screen now comes with a look. Pick one from a gallery with previews while setting up, or change it later from the TV's page: **Nuvio Cinema** (new, made for OLED: true black, the focused app's artwork across the top, a glass dock, Earth-from-orbit photos), Aerial, Cinematic, Midnight Glass, Orba, Ridgelines, Christmas, Nature Calm, Glass, Red Rain, Onyx or Plain. Wallpapers, effects and the dock style go to the TV in about a minute; low-memory boxes get a lighter version automatically.
- **Remote buttons.** On the TV's page, **Remote buttons → Add a button**, then press any spare button on the remote (YouTube, Netflix, the mic, a colour key). Choose what a press or a hold does: open Nuvio or any app, the Inputs menu, mute, standby and more. Arrows, OK, Back, Home, power and volume can't be changed.
- **Open Nuvio when the TV turns on.** A switch in setup, and a **When the TV turns on** page to pick any app (it waits for the internet first; optionally also when the screen wakes).
- **Samsung:** a "Make Nuvio one press away" guide (Autorun Last App, first in the app bar). **Samsung, LG and Nuvio Legacy on Android:** a recommended-settings card that fixes the wrong-episode autoplay and foreign-language picks, with a Copy button for the English-first filter.
- **Settings:** pure-black (OLED) look for this app, and a backup of your saved TVs and settings to restore on a new phone.
- Built-in launcher patch: a theme can name the power-on app, so TV Setup can set it from the phone.

## 1.8.2

- **Nuvio Lite: shows why there are no streams.** Instead of a bare "No playable streams found", the TV now lists what each addon answered (an HTTP error, results without debrid links, or an empty list) and whether it went through the phone or Cloudflare. The Older Samsung screen shows the last stream lookup (addon, HTTP status, playable count).
- When an addon refuses the phone's request (403, 429 or 503), the phone retries once as a plain app client, which gets past bot rules that block fake browsers.
- Stream lists are never cached, so a bad answer doesn't stick for 15 minutes.
- Nuvio Lite 1.0.2: run **Start sync** and the TV's User App Sync once.

## 1.8.1

- **Nuvio Lite: streams with the Cloudflare relay.** Torrentio (and most public scrapers) refuse requests from Cloudflare, so with the Orsay Relay every title showed "No playable streams found". Nuvio Lite now looks up streams and resolves the chosen link through this phone first (your home internet), and uses the Worker for everything else. Menus and posters work with the phone away; to find streams, have TV Setup open on the Older Samsung screen with the sync running. If the phone can't be reached, Nuvio Lite says so instead of showing an empty list. Run **Start sync** once so the TV gets the new Nuvio Lite (1.0.1).
- Orsay Relay Worker refuses requests until its key is set, and logs only the upstream host and status (never addon paths, which can carry a debrid key).

## 1.8.0

- **2011 to 2014 Samsung (Orsay): apps on the TV itself.** The Older Samsung screen now has "Nuvio Lite + Plex" for these sets. **Start sync** builds **Nuvio Lite**, a light Nuvio-style app made for Orsay (Netflix-style rows from Cinemeta, seasons and episodes, search with an on-screen keyboard, streams from your debrid addons, played by the TV's own player with 1080p x264 sources sorted first), adds the community **Plex for Samsung** widget if you give it the zip, and serves both to the TV's User App Sync. Progress shows as the TV connects and installs each app, and the TV steps fill in the phone's IP.
- The TV only syncs from port 80. The phone listens there when Android allows it (Android 13 and newer after Google's 2026 Play System Update) and says so if not; **Orsay Bridge** (`orsay/orsay_bridge.py`, Windows GUI) does the one-time sync from a PC instead.
- **TV relay.** 2014 TVs can't open modern HTTPS, so Nuvio Lite's addon, poster and video requests go through a relay: this phone (keep the screen open; it stays on), or **Orsay Relay**, a Cloudflare Worker (`orsay/relay-worker.js`) that keeps working with the phone away. Video can go through the relay, or straight to debrid with the relay only resolving the link. Relay requests need a per-phone key.
- New test: widget build, sync list, Plex zip check, relay key, proxy, ranged video through redirects, and link resolving.

## 1.7.0

- **Fire TV: full setup.** Fire TV Sticks, Cubes and Fire TV sets (Fire OS 7 and 8) now get the clean home screen too: Fire OS won't hand Home to another app, so the clean screen answers the Home button and covers Amazon's home whenever it shows (Amazon's stays installed underneath; it can flash for a moment). Nuvio Legacy (lite) is picked for 2 GB sticks, in the 32-bit build Fire OS uses. The debloat uses CleanYourTV's tested Fire TV lists and never touches Amazon's home, Alexa's voice UI, remote pairing, the keyboard or Settings. Undo removes it all. Fire OS 6 gets Nuvio and the clean-up but not the home screen.
- **Older Samsung (2011 to 2017).** New "Older Samsung" choice, and the Wi-Fi scan now spots these sets. Enter the model number (or pick the year) and the app tells you what the TV is (Orsay, or Tizen 2.3 to 3.0) and why Nuvio can't run on it, then walks you through the fix: a streaming stick on its HDMI port, which picks to buy and which to avoid (Vega OS sticks), and the Samsung settings that make its remote drive the stick. Developer access for those TVs (the "develop" login and User App Sync on 2011 to 2014 sets) is included for other apps.
- **Developer mode guide.** "How to turn on developer mode" (on the Set up screen and in Settings) covers every TV and box with step-by-step menus, other models' paths, and fixes for when it won't turn on. The connect screen shows the same help for the TV you picked, plus where to find its IP.
- Samsung model years are now read for every year from 2010 (43 model formats tested).

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
