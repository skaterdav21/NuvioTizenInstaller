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
