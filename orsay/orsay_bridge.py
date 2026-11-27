#!/usr/bin/env python3
"""
Orsay Bridge  v1.0
Sync server + HTTPS proxy for 2011-2014 Samsung "Orsay" Smart TVs.

What it does
  1. Builds the Nuvio Lite widget (with your addon URLs baked in) and serves it,
     plus any extra widget zips (e.g. Orca's community Plex 2.013), through the
     Smart Hub "develop" user-app sync (TV fetches http://<this PC>/widgetlist.xml).
  2. Stays running as a LAN proxy so the TV can reach modern HTTPS addons,
     posters, and debrid streams it cannot validate on its own (old TLS stack).

Run it on an always-on Windows PC (the Plex machine is ideal).
  GUI:       python orsay_bridge.py
  Headless:  pythonw orsay_bridge.py --headless     (uses saved settings)
Stdlib only. Python 3.8+.
"""
import io
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address

APP_NAME = "Orsay Bridge"
VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(sys.argv[0] if getattr(sys, "frozen", False) else __file__))
SETTINGS_PATH = os.path.join(HERE, "bridge_settings.json")
WIDGET_SRC = next((p for p in (os.path.join(HERE, "nuvio_lite"), os.path.join(HERE, "..", "nodejs-project", "orsay", "nuvio_lite")) if os.path.isdir(p)), os.path.join(HERE, "nuvio_lite"))
BUILD_DIR = os.path.join(HERE, "build")
LOG_PATH = os.path.join(HERE, "bridge.log")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

CINEMETA = "https://v3-cinemeta.strem.io"
DEFAULTS = {
    "port": 80,
    "bridge_ip": "",
    "meta_addon": CINEMETA,
    "catalogs": [
        {"name": "Popular Movies", "addon": CINEMETA, "type": "movie", "id": "top"},
        {"name": "Popular Series", "addon": CINEMETA, "type": "series", "id": "top"},
        {"name": "Featured Movies", "addon": CINEMETA, "type": "movie", "id": "imdbRating"},
        {"name": "Featured Series", "addon": CINEMETA, "type": "series", "id": "imdbRating"},
    ],
    "stream_addons": [],
    "proxy_streams": True,
    "http_downgrade": False,
    "extra_widgets": [],
}


# ----------------------------------------------------------------- utilities
def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def load_settings():
    data = dict(DEFAULTS)
    if os.path.exists(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                data.update(json.load(f))
        except (OSError, ValueError):
            pass
    if not data.get("bridge_ip"):
        data["bridge_ip"] = lan_ip()
    return data


def save_settings(data):
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def safe_id(name):
    return re.sub(r"[^A-Za-z0-9_]", "", name) or "Widget"


class Log:
    listeners = []
    lock = threading.Lock()

    @classmethod
    def write(cls, msg):
        line = time.strftime("%H:%M:%S ") + msg
        with cls.lock:
            try:
                with open(LOG_PATH, "a", encoding="utf-8") as f:
                    f.write(time.strftime("%Y-%m-%d ") + line + "\n")
            except OSError:
                pass
        for cb in list(cls.listeners):
            try:
                cb(line)
            except Exception:
                pass


# ----------------------------------------------------------------- builder
def build_nuvio_lite(cfg):
    """Zip the widget with a generated config.js. Returns (widget_id, path, size)."""
    if not os.path.isdir(WIDGET_SRC):
        raise FileNotFoundError("nuvio_lite folder not found next to orsay_bridge.py")
    port = int(cfg["port"])
    bridge = "http://" + cfg["bridge_ip"] + ("" if port == 80 else ":%d" % port)
    js_cfg = {
        "relay": bridge,
        "key": "",
        "metaAddon": cfg["meta_addon"],
        "catalogs": cfg["catalogs"],
        "streamAddons": [u.strip() for u in cfg["stream_addons"] if u.strip()],
        "streamMode": "proxy" if cfg["proxy_streams"] else ("http" if cfg["http_downgrade"] else "direct"),
        "builtAt": time.strftime("%Y-%m-%d %H:%M"),
    }
    os.makedirs(BUILD_DIR, exist_ok=True)
    out = os.path.join(BUILD_DIR, "NuvioLite.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(WIDGET_SRC):
            for fn in files:
                if fn == "config.js":
                    continue
                full = os.path.join(root, fn)
                z.write(full, os.path.relpath(full, WIDGET_SRC).replace("\\", "/"))
        z.writestr("config.js", "var CFG = " + json.dumps(js_cfg, indent=1) + ";\n")
    return "NuvioLite", out, os.path.getsize(out)


def widget_table(cfg):
    """All widgets offered to the TV: {id: {title, path, size, desc}}"""
    table = {}
    wid, path, size = build_nuvio_lite(cfg)
    table[wid] = {"title": "Nuvio Lite", "path": path, "size": size, "desc": "Nuvio-style player via Orsay Bridge"}
    for p in cfg.get("extra_widgets", []):
        if p and os.path.isfile(p) and p.lower().endswith(".zip"):
            stem = os.path.splitext(os.path.basename(p))[0]
            wid = safe_id(stem)
            title = "Plex" if "plex" in stem.lower() else stem
            table[wid] = {"title": title, "path": p, "size": os.path.getsize(p), "desc": stem}
    return table


def widgetlist_xml(table, base):
    parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<rsp stat="ok">', "<list>"]
    for wid, w in table.items():
        parts += [
            '<widget id="%s">' % wid,
            "<title>%s</title>" % w["title"],
            '<compression size="%d" type="zip"/>' % w["size"],
            "<description>%s</description>" % w["desc"],
            "<download>%s/Widget/%s.zip</download>" % (base, wid),
            "</widget>",
        ]
    parts += ["</list>", "</rsp>"]
    return "\n".join(parts).encode("utf-8")


# ----------------------------------------------------------------- server
class Cache:
    def __init__(self, ttl=600, cap=400):
        self.ttl, self.cap, self.d, self.lock = ttl, cap, {}, threading.Lock()

    def get(self, k):
        with self.lock:
            v = self.d.get(k)
            if v and time.time() - v[0] < self.ttl:
                return v[1]
            self.d.pop(k, None)

    def put(self, k, val):
        with self.lock:
            if len(self.d) >= self.cap:
                oldest = sorted(self.d.items(), key=lambda kv: kv[1][0])[: self.cap // 4]
                for key, _ in oldest:
                    self.d.pop(key, None)
            self.d[k] = (time.time(), val)


class State:
    cfg = None
    table = {}
    base = ""
    cache = Cache()
    ssl_ctx = ssl.create_default_context()
    stats = {"widgetlist": 0, "downloads": {}, "proxy": 0, "streams": 0, "last_tv": ""}
    on_event = None  # callback(kind, detail)


def emit(kind, detail=""):
    if State.on_event:
        try:
            State.on_event(kind, detail)
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    server_version = "OrsayBridge/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _lan_only(self):
        try:
            ip = ip_address(self.client_address[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return True
        except ValueError:
            pass
        self.send_error(403)
        return False

    def _send(self, code, body, ctype="text/plain", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._lan_only():
            return
        u = urllib.parse.urlsplit(self.path)
        path, q = u.path, urllib.parse.parse_qs(u.query)
        try:
            if path.lower() == "/widgetlist.xml":
                return self.widgetlist()
            if path.startswith("/Widget/") and path.endswith(".zip"):
                return self.widget_zip(path[8:-4])
            if path in ("/proxy", "/img"):
                return self.proxy(q.get("u", [""])[0], is_img=(path == "/img"))
            if path == "/stream":
                return self.stream(q.get("u", [""])[0])
            if path in ("/", "/status"):
                body = json.dumps({"app": APP_NAME, "version": VERSION, "widgets": list(State.table), "stats": State.stats}, indent=1)
                return self._send(200, body.encode(), "application/json")
            self._send(404, b"not found")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            Log.write("ERROR %s: %s" % (path, e))
            try:
                self._send(502, str(e).encode())
            except Exception:
                pass

    # -- sync
    def widgetlist(self):
        State.stats["widgetlist"] += 1
        State.stats["last_tv"] = self.client_address[0]
        Log.write("TV %s requested widgetlist.xml (%d widgets)" % (self.client_address[0], len(State.table)))
        emit("widgetlist", self.client_address[0])
        self._send(200, widgetlist_xml(State.table, State.base), "text/xml; charset=utf-8", {"Cache-Control": "no-cache"})

    def widget_zip(self, wid):
        w = State.table.get(wid)
        if not w:
            return self._send(404, b"unknown widget")
        with open(w["path"], "rb") as f:
            data = f.read()
        Log.write("TV %s downloading %s.zip (%d KB)" % (self.client_address[0], wid, len(data) // 1024))
        self._send(200, data, "application/zip")
        State.stats["downloads"][wid] = State.stats["downloads"].get(wid, 0) + 1
        emit("download", wid)

    # -- proxy
    @staticmethod
    def _check_url(target):
        p = urllib.parse.urlsplit(target)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise ValueError("bad url")
        return target

    def proxy(self, target, is_img=False):
        target = self._check_url(target)
        State.stats["proxy"] += 1
        hit = State.cache.get(target)
        if hit:
            return self._send(200, hit[1], hit[0], {"Cache-Control": "max-age=3600"})
        req = urllib.request.Request(target, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=25, context=State.ssl_ctx) as r:
                body = r.read(15 * 1024 * 1024)
                ctype = r.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            Log.write("proxy %s -> HTTP %d" % (urllib.parse.urlsplit(target).hostname, e.code))
            return self._send(e.code, b"upstream error")
        if is_img or len(body) < 2 * 1024 * 1024:
            State.cache.put(target, (ctype, body))
        self._send(200, body, ctype, {"Cache-Control": "max-age=3600"})

    def stream(self, target):
        target = self._check_url(target)
        State.stats["streams"] += 1
        headers = {"User-Agent": UA}
        rng = self.headers.get("Range")
        if rng:
            headers["Range"] = rng
        else:
            Log.write("TV %s started stream from %s" % (self.client_address[0], urllib.parse.urlsplit(target).hostname))
            emit("stream", urllib.parse.urlsplit(target).hostname)
        req = urllib.request.Request(target, headers=headers)
        try:
            r = urllib.request.urlopen(req, timeout=30, context=State.ssl_ctx)
        except urllib.error.HTTPError as e:
            Log.write("stream upstream HTTP %d" % e.code)
            return self._send(e.code, b"upstream error")
        with r:
            self.send_response(r.status)
            for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"):
                v = r.headers.get(h)
                if v:
                    self.send_header(h, v)
            if not r.headers.get("Accept-Ranges"):
                self.send_header("Accept-Ranges", "bytes")
            if not r.headers.get("Content-Length"):
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            if self.command == "HEAD":
                return
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)


class Bridge:
    def __init__(self):
        self.httpd = None
        self.thread = None

    @property
    def running(self):
        return self.httpd is not None

    def start(self, cfg):
        State.cfg = cfg
        port = int(cfg["port"])
        State.base = "http://" + cfg["bridge_ip"] + ("" if port == 80 else ":%d" % port)
        State.table = widget_table(cfg)
        for wid, w in State.table.items():
            Log.write("Ready: %s (%s, %d KB)" % (w["title"], wid, w["size"] // 1024))
        self.httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        Log.write("Serving on %s  (widget list: %s/widgetlist.xml)" % (State.base, State.base))

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
            Log.write("Server stopped")


# ----------------------------------------------------------------- Windows helpers
def add_firewall_rule(port):
    if os.name != "nt":
        return False
    import ctypes
    args = 'advfirewall firewall add rule name="Orsay Bridge" dir=in action=allow protocol=TCP localport=%d profile=private' % port
    return ctypes.windll.shell32.ShellExecuteW(None, "runas", "netsh", args, None, 0) > 32


def startup_bat_path():
    appdata = os.environ.get("APPDATA", "")
    return os.path.join(appdata, r"Microsoft\Windows\Start Menu\Programs\Startup", "OrsayBridge.bat")


def set_run_at_login(enabled):
    p = startup_bat_path()
    if enabled:
        exe = sys.executable
        pyw = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.exists(pyw):
            exe = pyw
        with open(p, "w") as f:
            f.write('@echo off\r\nstart "" "%s" "%s" --headless\r\n' % (exe, os.path.abspath(__file__)))
    elif os.path.exists(p):
        os.remove(p)


# ----------------------------------------------------------------- GUI
def run_gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    cfg = load_settings()
    bridge = Bridge()
    root = tk.Tk()
    root.title("%s %s  |  Samsung 2011-2014 TV setup" % (APP_NAME, VERSION))
    root.geometry("900x760")
    root.minsize(820, 680)

    style = ttk.Style()
    try:
        style.theme_use("vista" if os.name == "nt" else "clam")
    except tk.TclError:
        pass

    nb = ttk.Notebook(root)
    nb.pack(fill="both", expand=True, padx=8, pady=8)

    # --- Tab 1: Setup
    t1 = ttk.Frame(nb, padding=10)
    nb.add(t1, text="  Setup  ")

    row = ttk.Frame(t1)
    row.pack(fill="x")
    ttk.Label(row, text="This PC's LAN IP (enter on TV):").pack(side="left")
    ip_var = tk.StringVar(value=cfg["bridge_ip"])
    ttk.Entry(row, textvariable=ip_var, width=18).pack(side="left", padx=6)
    ttk.Button(row, text="Detect", command=lambda: ip_var.set(lan_ip())).pack(side="left")
    ttk.Label(row, text="   Port:").pack(side="left")
    port_var = tk.StringVar(value=str(cfg["port"]))
    ttk.Entry(row, textvariable=port_var, width=6).pack(side="left", padx=4)
    ttk.Label(row, text="(TV sync requires 80)", foreground="#888").pack(side="left")

    ttk.Label(t1, text="Stream addon URLs (one per line; your debrid-configured Torrentio / Comet / TorBox / MediaFusion manifest URLs):").pack(anchor="w", pady=(12, 2))
    streams_txt = tk.Text(t1, height=5, wrap="none")
    streams_txt.pack(fill="x")
    streams_txt.insert("1.0", "\n".join(cfg["stream_addons"]))

    ttk.Label(t1, text="Metadata addon (details, episodes, search):").pack(anchor="w", pady=(10, 2))
    meta_var = tk.StringVar(value=cfg["meta_addon"])
    ttk.Entry(t1, textvariable=meta_var).pack(fill="x")

    ttk.Label(t1, text="Home rows  (name | addon base URL | type | catalog id):").pack(anchor="w", pady=(10, 2))
    cats_txt = tk.Text(t1, height=5, wrap="none")
    cats_txt.pack(fill="x")
    cats_txt.insert("1.0", "\n".join("%s | %s | %s | %s" % (c["name"], c["addon"], c["type"], c["id"]) for c in cfg["catalogs"]))

    opts = ttk.Frame(t1)
    opts.pack(fill="x", pady=(10, 0))
    proxy_var = tk.BooleanVar(value=cfg["proxy_streams"])
    down_var = tk.BooleanVar(value=cfg["http_downgrade"])
    ttk.Checkbutton(opts, text="Proxy video streams through this PC (most reliable on 2014 TLS)", variable=proxy_var).pack(anchor="w")
    ttk.Checkbutton(opts, text="Try plain http:// for direct streams (only used when proxy is off)", variable=down_var).pack(anchor="w")

    ttk.Label(t1, text="Extra widget zips to sync (e.g. Orca's Plex 2.013 zip):").pack(anchor="w", pady=(12, 2))
    extra_list = tk.Listbox(t1, height=3)
    extra_list.pack(fill="x")
    for p in cfg["extra_widgets"]:
        extra_list.insert("end", p)
    eb = ttk.Frame(t1)
    eb.pack(fill="x", pady=4)

    def add_zip():
        p = filedialog.askopenfilename(title="Pick an Orsay widget zip", filetypes=[("Widget zip", "*.zip")])
        if p:
            extra_list.insert("end", p)

    ttk.Button(eb, text="Add zip...", command=add_zip).pack(side="left")
    ttk.Button(eb, text="Remove selected", command=lambda: [extra_list.delete(i) for i in reversed(extra_list.curselection())]).pack(side="left", padx=6)

    def collect():
        cats = []
        for line in cats_txt.get("1.0", "end").splitlines():
            parts = [x.strip() for x in line.split("|")]
            if len(parts) == 4 and all(parts):
                cats.append({"name": parts[0], "addon": parts[1], "type": parts[2], "id": parts[3]})
        try:
            port = int(port_var.get())
        except ValueError:
            port = 80
        return {
            "port": port,
            "bridge_ip": ip_var.get().strip(),
            "meta_addon": meta_var.get().strip() or CINEMETA,
            "catalogs": cats or DEFAULTS["catalogs"],
            "stream_addons": [l.strip() for l in streams_txt.get("1.0", "end").splitlines() if l.strip()],
            "proxy_streams": proxy_var.get(),
            "http_downgrade": down_var.get(),
            "extra_widgets": list(extra_list.get(0, "end")),
        }

    # --- Tab 2: Sync & Run
    t2 = ttk.Frame(nb, padding=10)
    nb.add(t2, text="  Sync & Run  ")

    steps = [
        "1. Start the bridge on this PC (button below).",
        "2. TV: Smart Hub > Samsung Account > Log In. User: develop  Password: 000000 (or blank).",
        "3. TV: Smart Hub > press the remote's center/OK on an app tile, choose IP Settings, enter %IP%.",
        "4. TV: same menu > Start User App Sync. Watch progress here.",
        "5. Leave this PC on: Nuvio Lite uses it as its HTTPS proxy. Plex talks to your server directly.",
    ]
    steps_lbl = ttk.Label(t2, justify="left", font=("Segoe UI", 10))
    steps_lbl.pack(anchor="w")

    def refresh_steps(*_):
        steps_lbl.config(text="\n".join(s.replace("%IP%", ip_var.get() or "this PC's IP") for s in steps))

    ip_var.trace_add("write", refresh_steps)
    refresh_steps()

    prog = ttk.Progressbar(t2, mode="determinate", maximum=100)
    prog.pack(fill="x", pady=(14, 2))
    status_var = tk.StringVar(value="Stopped")
    ttk.Label(t2, textvariable=status_var, font=("Segoe UI", 11, "bold")).pack(anchor="w")
    stats_var = tk.StringVar(value="")
    ttk.Label(t2, textvariable=stats_var, foreground="#555").pack(anchor="w")

    btns = ttk.Frame(t2)
    btns.pack(fill="x", pady=8)
    start_btn = ttk.Button(btns, text="Start bridge")
    start_btn.pack(side="left")
    ttk.Button(btns, text="Add Windows firewall rule", command=lambda: add_firewall_rule(int(port_var.get() or 80))).pack(side="left", padx=6)
    login_var = tk.BooleanVar(value=os.path.exists(startup_bat_path()) if os.name == "nt" else False)

    def toggle_login():
        try:
            save_settings(collect())
            set_run_at_login(login_var.get())
            Log.write("Run at login: %s" % ("on (headless)" if login_var.get() else "off"))
        except OSError as e:
            messagebox.showerror(APP_NAME, str(e))

    if os.name == "nt":
        ttk.Checkbutton(btns, text="Run headless at Windows login", variable=login_var, command=toggle_login).pack(side="left", padx=6)
    ttk.Button(btns, text="Open build folder", command=lambda: os.startfile(BUILD_DIR) if os.name == "nt" and os.path.isdir(BUILD_DIR) else None).pack(side="left", padx=6)

    log_box = tk.Text(t2, height=18, state="disabled", bg="#111", fg="#ddd", font=("Consolas", 9))
    log_box.pack(fill="both", expand=True)

    def append_log(line):
        def _do():
            log_box.config(state="normal")
            log_box.insert("end", line + "\n")
            log_box.see("end")
            log_box.config(state="disabled")
        root.after(0, _do)

    Log.listeners.append(append_log)

    def on_event(kind, detail):
        def _do():
            n = max(1, len(State.table))
            done = len(State.stats["downloads"])
            if kind == "widgetlist":
                prog["value"] = 20
                status_var.set("TV %s connected, reading widget list..." % detail)
            elif kind == "download":
                prog["value"] = 20 + 80 * done / n
                status_var.set("Synced %d of %d widgets" % (done, n) + ("  |  Done. Exit Smart Hub and reopen it." if done >= n else ""))
            elif kind == "stream":
                status_var.set("Streaming from %s" % detail)
        root.after(0, _do)

    State.on_event = on_event

    def tick():
        if bridge.running:
            s = State.stats
            stats_var.set("Widget list requests: %d   Proxy calls: %d   Stream sessions: %d   Last TV: %s" % (s["widgetlist"], s["proxy"], s["streams"], s["last_tv"] or "none yet"))
        root.after(1000, tick)

    def toggle():
        if bridge.running:
            bridge.stop()
            start_btn.config(text="Start bridge")
            status_var.set("Stopped")
            prog["value"] = 0
            return
        c = collect()
        if not c["stream_addons"]:
            if not messagebox.askyesno(APP_NAME, "No stream addons entered. Nuvio Lite will browse but find no streams. Start anyway?"):
                nb.select(0)
                return
        save_settings(c)
        try:
            bridge.start(c)
        except OSError as e:
            msg = str(e)
            if getattr(e, "winerror", None) in (10013, 10048) or getattr(e, "errno", None) in (13, 48, 98):
                msg = ("Port %d is busy or blocked.\n\nOn Windows, something else (IIS, 'World Wide Web Publishing Service', "
                       "Skype, a Docker/WSL forward) is holding it. Stop that service and retry.\n\n%s" % (c["port"], e))
            messagebox.showerror(APP_NAME, msg)
            bridge.httpd = None
            return
        except Exception as e:
            messagebox.showerror(APP_NAME, "Build failed: %s" % e)
            return
        start_btn.config(text="Stop bridge")
        prog["value"] = 5
        status_var.set("Running at %s  |  Waiting for the TV to sync..." % State.base)
        nb.select(1)

    start_btn.config(command=toggle)

    def on_close():
        try:
            save_settings(collect())
        except OSError:
            pass
        bridge.stop()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    Log.write("%s %s ready. Settings: %s" % (APP_NAME, VERSION, SETTINGS_PATH))
    tick()
    root.mainloop()


def run_headless():
    cfg = load_settings()
    Log.listeners.append(lambda line: print(line, flush=True) if sys.stdout else None)
    bridge = Bridge()
    for attempt in range(30):  # wait for network at boot
        try:
            cfg["bridge_ip"] = cfg.get("bridge_ip") or lan_ip()
            bridge.start(cfg)
            break
        except OSError as e:
            Log.write("Start failed (%s), retry %d/30" % (e, attempt + 1))
            time.sleep(10)
    else:
        sys.exit(1)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        bridge.stop()


if __name__ == "__main__":
    if "--headless" in sys.argv:
        run_headless()
    else:
        run_gui()
