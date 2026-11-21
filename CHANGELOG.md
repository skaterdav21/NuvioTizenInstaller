## 1.3.0

- New: **Nuvio Legacy (native, fast)** install option. Pulls the latest release from iqui27/nuvio-native-legacy, picks the TPK for the TV's Tizen version (auto-detect or pick the TV year), signs it with the TV's saved Samsung certificate, and installs it next to the web Nuvio.
- New: Launch Legacy button.
- Nuvio (web) and Plex are now unchecked by default.
- TPK installs fall back to `pkgcmd` if `vd_appinstall` refuses the package.
- Local package picker accepts `.tpk` files.

Signed with a new key: uninstall 1.2.3 before installing this one. Back up the Samsung certificate first if you want to keep it.
