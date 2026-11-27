// Orsay Relay: Cloudflare Worker that lets a 2011-2014 Samsung (Orsay) reach modern HTTPS.
// Same routes as TV Setup's phone relay, so Nuvio Lite works with either:
//   /proxy?u=<url>&k=<key>                addon JSON (cached 15 min)
//   /img?u=<url>&k=<key>                  posters and backdrops (cached 1 day)
//   /stream?u=<url>&k=<key>&mode=<m>      video. mode=http (default here): follow the addon's redirects
//                                         and send the TV to the plain-http debrid link, so no video
//                                         passes through Cloudflare. resolve: same, keeps https.
//                                         proxy: carry the bytes (heavy; use the phone relay for that).
// The TV must reach this over plain http://, so serve it from workers.dev or a route on a zone
// with "Always Use HTTPS" off. Set the key with: wrangler secret put RELAY_KEY
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function target(raw) {
  try {
    const u = new URL(raw || "");
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch { return null; }
}

async function finalUrl(u) {
  let current = u;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(current, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, Range: "bytes=0-0" } });
    const loc = r.headers.get("location");
    r.body?.cancel();
    if (r.status >= 300 && r.status < 400 && loc) { current = new URL(loc, current).href; continue; }
    return current;
  }
  return current;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/status") return Response.json({ app: "Orsay Relay", ok: true });
    if (!["/proxy", "/img", "/stream"].includes(url.pathname)) return new Response("not found", { status: 404 });
    // No key set yet: refuse rather than run as an open proxy.
    if (!env.RELAY_KEY) return new Response("RELAY_KEY not set", { status: 503 });
    if (url.searchParams.get("k") !== env.RELAY_KEY) return new Response("bad key", { status: 403 });
    const u = target(url.searchParams.get("u"));
    if (!u) return new Response("bad url", { status: 400 });

    if (url.pathname === "/stream") {
      const mode = url.searchParams.get("mode") || "http";
      if (mode === "proxy") {
        const headers = { "User-Agent": UA };
        const range = request.headers.get("range");
        if (range) headers.Range = range;
        const up = await fetch(u.href, { headers, redirect: "follow" });
        const out = new Headers();
        for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
          const v = up.headers.get(h);
          if (v) out.set(h, v);
        }
        if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
        return new Response(up.body, { status: up.status, headers: out });
      }
      const dest = await finalUrl(u.href);
      return Response.redirect(mode === "resolve" ? dest : dest.replace(/^https:/i, "http:"), 302);
    }

    const ttl = url.pathname === "/img" ? 86400 : 900;
    const cache = caches.default;
    const cacheKey = new Request(`https://orsay-relay.cache/${url.pathname}?u=${encodeURIComponent(u.href)}`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    const up = await fetch(u.href, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", cf: { cacheTtl: ttl } });
    const res = new Response(up.body, up);
    res.headers.set("Cache-Control", `public, max-age=${ttl}`);
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.delete("set-cookie");
    if (up.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
};
