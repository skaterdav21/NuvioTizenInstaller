#!/usr/bin/env python3
"""Condense CleanYourTV's tested debloat lists into one JSON file the phone app ships.

Usage: gen_lists.py <cleanyourtv checkout> <out.json>

For every examples/<folder>/debloat*.txt it keeps:
  - the TV description, OS, brand and notes from tv.json
  - every ACTIVE package line, with the nearest "# Section" heading above it and its trailing comment
  - codename-like tokens from tv.json (used to match a connected TV to its list)
CleanYourTV is MIT licensed; its copyright notice is kept in the output.
"""
import json
import re
import sys
from pathlib import Path

PKG_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$")
CORE_RE = re.compile(
    r"^(android|android\.ext\.(services|shared)|com\.(google\.)?android\.sdksandbox|com\.android\.location\.fused|"
    r"com\.android\.systemui|com\.android\.shell|com\.android\.phone|com\.android\.settings|com\.android\.tv\.settings|"
    r"com\.(google\.)?android\.(permissioncontroller|packageinstaller|ext\.services|ext\.shared|modulemetadata)|"
    r"com\.google\.android\.overlay\.modules.*|com\.android\.providers\..*|com\.cltv\.mal|com\.mediatek\.(tis|tv\.service|tv\.agent))$"
)
CORE_OK = re.compile(r"^com\.android\.providers\.(calendar|contacts|userdictionary|blockednumber)$")


def parse_list(path):
    groups = []
    current = {"title": "Other", "packages": []}
    header_done = False
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.rstrip("\r")
        stripped = line.strip()
        if not stripped:
            header_done = True
            continue
        if stripped.startswith("#"):
            text = stripped.lstrip("#").strip()
            first = text.split()[0] if text.split() else ""
            # A commented-out package is a choice to keep it, not a heading.
            if PKG_RE.match(first):
                continue
            if header_done and text and len(text) < 90 and not text.endswith((".", ":")) and not text.startswith(("-", "(")):
                if current["packages"]:
                    groups.append(current)
                current = {"title": text[:80], "packages": []}
            continue
        header_done = True
        name, _, comment = stripped.partition("#")
        name = name.split()[0] if name.split() else ""
        if not PKG_RE.match(name):
            continue
        if CORE_RE.match(name) and not CORE_OK.match(name):
            continue
        current["packages"].append({"p": name, "c": comment.strip()[:120]})
    if current["packages"]:
        groups.append(current)
    return groups


def tokens_from(text):
    found = set()
    for chunk in re.findall(r"\(([^)]*)\)", text or ""):
        for token in re.split(r"[,;/ ]+", chunk):
            token = token.strip().strip(".")
            if 3 <= len(token) <= 32 and re.match(r"^[A-Za-z0-9_\-]+$", token) and not token.isdigit():
                found.add(token.lower())
    return sorted(found)


def main():
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    lists = []
    for folder in sorted((root / "examples").iterdir()):
        if not folder.is_dir():
            continue
        meta = {}
        tv_json = folder / "tv.json"
        if tv_json.exists():
            try:
                meta = json.loads(tv_json.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                meta = {}
        for list_file in sorted(folder.glob("debloat*.txt")):
            groups = parse_list(list_file)
            if not groups:
                continue
            lists.append({
                "id": folder.name + ("" if list_file.name == "debloat.txt" else ":" + list_file.stem.replace("debloat-", "")),
                "folder": folder.name,
                "variant": "" if list_file.name == "debloat.txt" else list_file.stem.replace("debloat-", ""),
                "tv": meta.get("tv", folder.name),
                "os": meta.get("os", ""),
                "brand": meta.get("brand", ""),
                "notes": (meta.get("notes", "") or "")[:600],
                "tokens": tokens_from(meta.get("tv", "")) + [folder.name.lower()],
                "groups": groups,
            })
    commit = ""
    head = root / ".git" / "HEAD"
    try:
        import subprocess
        commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        pass
    data = {
        "source": "https://github.com/Gathin23/cleanyourtv",
        "commit": commit,
        "license": "MIT License, Copyright (c) 2026 Gathin",
        "lists": lists,
    }
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    total = sum(len(g["packages"]) for item in lists for g in item["groups"])
    print(f"{len(lists)} lists, {total} package lines, {out.stat().st_size // 1024} KB -> {out}")


if __name__ == "__main__":
    main()
