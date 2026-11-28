#!/usr/bin/env python3
"""Copy the home screen looks listed in launcher/looks.json into the app.

usage: bundle_looks.py <cleanyourtv checkout> <repo root>
  -> nodejs-project/bundled/themes/<id>/{config.json,wallpaper.jpg,wallpapers/*}
  -> nodejs-project/bundled/themes/index.json   (id, name, desc, oled, pictures)
  -> nodejs-project/ui/looks/<id>.jpg           (preview shown on the phone)
"""
import json, os, shutil, sys

cyt, root = sys.argv[1], sys.argv[2]
spec = json.load(open(os.path.join(root, "launcher", "looks.json")))
out = os.path.join(root, "nodejs-project", "bundled", "themes")
shots = os.path.join(root, "nodejs-project", "ui", "looks")
shutil.rmtree(out, ignore_errors=True); shutil.rmtree(shots, ignore_errors=True)
os.makedirs(out); os.makedirs(shots)
IMG = (".jpg", ".jpeg", ".png", ".webp")
index = []
for look in spec["looks"]:
    lid = look["id"]
    dest = os.path.join(out, lid)
    os.makedirs(dest)
    src = os.path.join(cyt, "themes", look["from"]) if look.get("from") else None
    cfg_dir = os.path.join(root, look["config"]) if look.get("config") else src
    config = json.load(open(os.path.join(cfg_dir, "config.json"))) if cfg_dir else {}
    for k in ("dock_apps", "hidden_apps", "fill_dock_apps", "app_keys", "race_calendar"):
        config.pop(k, None)
    json.dump(config, open(os.path.join(dest, "config.json"), "w"), indent=1)
    pics_src = os.path.join(cyt, "themes", look.get("wallpapersFrom") or look.get("from") or "", "")
    pictures = 0
    if src and os.path.isfile(os.path.join(src, "wallpaper.jpg")):
        shutil.copy(os.path.join(src, "wallpaper.jpg"), dest); pictures += 1
    wall = os.path.join(pics_src, "wallpapers")
    if (look.get("from") or look.get("wallpapersFrom")) and os.path.isdir(wall):
        os.makedirs(os.path.join(dest, "wallpapers"))
        for name in sorted(os.listdir(wall)):
            if name.lower().endswith(IMG) or name == "captions.txt":
                shutil.copy(os.path.join(wall, name), os.path.join(dest, "wallpapers", name))
                pictures += name != "captions.txt"
    shot_from = look.get("shot") or look.get("from")
    shot = os.path.join(cyt, "themes", shot_from, "screenshot.jpg") if shot_from else os.path.join(cyt, "docs", "new-home.jpg")
    has_shot = os.path.isfile(shot)
    if has_shot:
        shutil.copy(shot, os.path.join(shots, f"{lid}.jpg"))
    index.append({"id": lid, "name": look["name"], "desc": look["desc"], "oled": bool(look.get("oled")), "pictures": pictures, "shot": has_shot})
json.dump(index, open(os.path.join(out, "index.json"), "w"), indent=1)
size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs)
print(f"{len(index)} looks, {size / 1048576:.1f} MB")
