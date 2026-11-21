#!/usr/bin/env python3
"""Repack the base installer APK with the current nodejs-project folder.

Usage: repack.py <base.apk> <nodejs-project dir> <out-unsigned.apk>

Replaces assets/nodejs-project.zip inside the base APK, keeps every other
entry (and its compression) as-is, and drops the old v1 signature files so
the APK can be signed with this repo's key.
"""
import os
import sys
import zipfile


def zip_project(project_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as out:
        for root, dirs, files in os.walk(project_dir):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, project_dir)
                out.write(full, rel)


def main():
    base_apk, project_dir, out_apk = sys.argv[1:4]
    project_zip = out_apk + ".nodejs-project.zip"
    zip_project(project_dir, project_zip)
    with open(project_zip, "rb") as handle:
        project_bytes = handle.read()

    old_sig = (".SF", ".RSA", ".EC", ".DSA")
    with zipfile.ZipFile(base_apk) as src, zipfile.ZipFile(out_apk, "w") as out:
        replaced = False
        for info in src.infolist():
            name = info.filename
            if name.startswith("META-INF/") and (name.endswith(old_sig) or name == "META-INF/MANIFEST.MF"):
                continue
            if name == "assets/nodejs-project.zip":
                out.writestr(info, project_bytes)
                replaced = True
            else:
                out.writestr(info, src.read(info))
    os.remove(project_zip)
    if not replaced:
        sys.exit("assets/nodejs-project.zip was not found in the base APK")
    print(f"Wrote {out_apk} ({len(project_bytes)} byte nodejs-project.zip)")


if __name__ == "__main__":
    main()
