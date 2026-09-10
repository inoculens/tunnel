/**
 * Short-link resolver: GET /.netlify/functions/resolve?c=<code>
 * Logs the click (truncated IP), bumps the counter, then:
 *  - known social platforms → branded interstitial that tries the native app
 *    first ("Tunnel" deep-link behavior) with fallback to the original URL;
 *  - everything else → immediate 302 to the original URL.
 * Unknown/expired codes → 302 to the branded /404 page (keeps ?c= for display).
 *
 * Wire-up: netlify/edge-functions/short-domain.js rewrites short-host paths
 * to this function (GET /.netlify/functions/resolve?c=<code>).
 */
import { store, newClickId, clientIp, systemShortHost, coverageValid } from "./lib/util.js";

const HOME = process.env.HOME_URL || "https://tunnel.inoculens.com/";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Native-app attempts per platform (best effort; universal links + fallback).
const APP_LINKS = {
  youtube: (u) => `vnd.youtube:${u.replace(/^https?:\/\//, "")}`,
  instagram: () => "instagram://media",
  facebook: (u) => `fb://facewebmodal/f?href=${encodeURIComponent(u)}`,
  twitter: (u) => `twitter://post?message=${encodeURIComponent(u)}`,
  tiktok: (u) => `tiktok://open?url=${encodeURIComponent(u)}`,
  linkedin: (u) => `linkedin://shareArticle?url=${encodeURIComponent(u)}`,
};

const APP_NAMES = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "X (Twitter)",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

function interstitial(link) {
  const name = APP_NAMES[link.platform] || "the app";
  const attempt = (APP_LINKS[link.platform] || ((u) => u))(link.original);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>Opening ${esc(name)}… — INOCULENS Tunnel</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0f0f;color:#f1f1f1;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box}.card{background:rgba(33,33,36,.62);border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:32px;max-width:420px;text-align:center}.btn{display:inline-block;margin-top:16px;background:#f1f1f1;color:#0f0f0f;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700}.alt{margin-top:12px;font-size:.85rem;color:#aaa;word-break:break-all}.alt a{color:#3ea6ff}</style>
</head><body><div class="card">
<h2>Opening ${esc(name)}…</h2>
<p>Tunnel is taking you to the native app. If nothing happens:</p>
<a class="btn" id="open" href="${esc(link.original)}" rel="noopener">Continue</a>
<p class="alt">${esc(link.original)}</p>
</div><script>
try{window.location.replace(${JSON.stringify(attempt)});}catch(e){}
setTimeout(function(){window.location.replace(${JSON.stringify(link.original)});},1500);
document.getElementById('open').addEventListener('click',function(){});
</script></body></html>`;
}

export async function handler(event) {
  const s = store(event);
  const qs = event.queryStringParameters || {};
  let code = (qs.c || "").trim();
  if (!code) {
    const parts = (event.path || "").split("/").filter(Boolean);
    code = parts[parts.length - 1] || "";
  }
  if (!code || /[.]{2}|[/\\]/.test(code)) {
    return { statusCode: 302, headers: { Location: HOME, "Cache-Control": "no-store" } };
  }

  const link = await s.get(`link/${code}`, { type: "json" }).catch(() => null);
  if (!link || !/^https?:\/\//.test(link.original || "")) {
    const dest = `${HOME.replace(/\/$/, "")}/404.html?c=${encodeURIComponent(code)}`;
    return { statusCode: 302, headers: { Location: dest, "Cache-Control": "no-store" } };
  }

  // Hard stop on lapsed coverage: links on custom domains whose payment
  // year / promo grant ran out behave as deleted (the branded 404 copy
  // already reads "Link Expired"). No click is logged — this was not a
  // visit. System-host links are unaffected; a missing domain doc fails
  // open (link deletion cascades, so this should not happen).
  if (link.domain && link.domain !== systemShortHost()) {
    const doc = await s.get(`domain/${link.domain}`, { type: "json" }).catch(() => null);
    if (doc && !coverageValid(doc)) {
      const dest = `${HOME.replace(/\/$/, "")}/404.html?c=${encodeURIComponent(code)}`;
      return { statusCode: 302, headers: { Location: dest, "Cache-Control": "no-store" } };
    }
  }

  // Log click (best effort — never block the redirect on storage errors).
  try {
    const id = newClickId();
    await s.setJSON(`clicks/${link.code}/${id}`, {
      id,
      timestamp: Date.now(),
      ip: clientIp(event),
    });
    link.clickCount = (link.clickCount || 0) + 1;
    await s.setJSON(`link/${link.code}`, link);
  } catch (e) {
    console.error("click log failed:", e);
  }

  if (link.platform && APP_LINKS[link.platform] && qs.direct !== "1") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      body: interstitial(link),
    };
  }
  return {
    statusCode: 302,
    headers: { Location: link.original, "Cache-Control": "no-store" },
  };
}
