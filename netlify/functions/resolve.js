/**
 * Short-link resolver: GET /.netlify/functions/resolve
 * Logs the click (truncated IP), bumps the counter, then hands the visitor
 * to the content with maximum app-open rate:
 *
 * - Desktop + crawlers/preview bots → instant 302 to the original URL.
 *   (The OS routes installed apps itself; bots unfurl the real destination.)
 * - Mobile deep links (YouTube, Instagram, Facebook, X, TikTok, LinkedIn) →
 *   a tiny frictionless interstitial that auto-fires the native app target
 *   (Android intent:// with package + browser fallback, iOS custom scheme)
 *   and falls back to the https URL when no app is installed. The visitor
 *   perceives a brief "Opening…" hop; a big Open button covers the case
 *   where the OS blocks the auto-attempt (iOS in-app browsers require a tap).
 * - All other mobile links → instant 302 (no interstitial friction).
 *
 * Unknown/expired codes → 302 to the branded /404 page (keeps ?c= and ?h=
 * for display, so the page shows the short domain actually visited —
 * s.inoculens.com or the user's custom domain — never tunnel.inoculens.com).
 *
 * Wire-up: netlify/edge-functions/short-domain.js passes code and host via
 * X-Tunnel-Code / X-Tunnel-Host request headers (no query params, so nothing
 * can be grafted onto the outgoing Location header by the platform).
 * Query-param fallback (?c=, ?h=) is permanent for SaaS Worker proxies,
 * direct function hits, and deploy-skew safety.
 */
import { store, newClickId, truncateIp, clickClientIp, isIpLiteral, systemShortHost, coverageValid, cleanDomain, linkKey, clicksPrefix, freshGet, getWithRetry, shouldStoreClickDetail, writeCountShard, buildAppTargets, shouldServeInterstitial } from "./lib/util.js";

const HOME = process.env.HOME_URL || "https://tunnel.inoculens.com/";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Self-contained (no external assets): short domains must not depend on the
// app host. URLs are embedded via JSON.stringify (never string-concatenated),
// so a crafted original URL cannot break out of the JS string context.
function interstitialPage({ appName, https, iosScheme, androidIntent }) {
  const safeApp = escapeHtml(appName);
  const payload = JSON.stringify({ https, ios: iosScheme, intent: androidIntent }).replace(/<\//g, "<\\/");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Opening ${safeApp}&hellip;</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;background:#0f0f0f;color:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:380px;text-align:center;background:rgba(33,33,36,.62);border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:36px 28px;box-shadow:0 8px 28px rgba(0,0,0,.45)}
.spinner{width:44px;height:44px;margin:0 auto 20px;border:4px solid rgba(255,255,255,.12);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:1.25rem;margin:0 0 8px;letter-spacing:-.01em}
p{color:#aaa;font-size:.9rem;line-height:1.5;margin:0 0 24px}
.open{display:block;background:#e8eaed;color:#0f0f0f;font-weight:700;font-size:1rem;text-decoration:none;border-radius:999px;padding:14px 24px;margin-bottom:12px}
.open:active{transform:scale(.98)}
.browser{display:inline-block;color:#8ab4ff;font-size:.85rem;text-decoration:none;padding:8px}
</style>
</head>
<body>
<div class="card">
<div class="spinner" aria-hidden="true"></div>
<h1>Opening ${safeApp}&hellip;</h1>
<p>Taking you to the app. If nothing happens, tap the button below.</p>
<a class="open" id="openBtn" href="${escapeHtml(https)}">Open in ${safeApp}</a>
<a class="browser" href="${escapeHtml(https)}">Continue in browser</a>
</div>
<script>
(function(){
var T=${payload};
var left=false;
function markLeft(){left=true;}
window.addEventListener("pagehide",markLeft);
document.addEventListener("visibilitychange",function(){if(document.hidden)markLeft();});
function fireApp(){
var ua=navigator.userAgent||"";
if(/Android/i.test(ua)){window.location.href=T.intent;}
else{window.location.href=T.ios;}
}
document.getElementById("openBtn").addEventListener("click",function(e){
e.preventDefault();markLeftReset();fireApp();
});
function markLeftReset(){/* user tapped: allow fallback if app missing */left=false;}
// Frictionless auto-attempt on load; fallback to browser when no app.
fireApp();
setTimeout(function(){if(!left){window.location.href=T.https;}},1400);
})();
</script>
</body>
</html>`;
}

export async function handler(event) {
  const s = store(event);
  const qs = event.queryStringParameters || {};
  const rawHeaders = event.headers || {};
  const lowered = {};
  for (const [k, v] of Object.entries(rawHeaders)) lowered[String(k).toLowerCase()] = v;

  // Slugs repeat across root domains, so the serving host is part of the
  // identity. The edge router passes it as X-Tunnel-Host header; SaaS Worker
  // proxies forward the original host via X-Forwarded-Host or ?h=.
  // Query-param fallback (?h=) is permanent: SaaS Worker, direct function
  // hits, and deploy-skew all depend on it.
  const fwd = (lowered["x-forwarded-host"] || lowered["x-original-host"] || "").toString().split(",")[0].trim();
  const rawHost = (lowered["x-tunnel-host"] || qs.h || fwd || lowered.host || "").toString().split(",")[0].trim().split(":")[0];
  const host = cleanDomain(rawHost);
  if (!host) {
    return { statusCode: 302, headers: { Location: HOME, "Cache-Control": "no-store" } };
  }

  // Root-path (apex) routing: "/" carries no code. Paid-and-ready custom
  // domains may point their root at a configured destination (set via
  // setApexTarget); everything else keeps the long-standing landing
  // behavior (app home). Root visits are never logged — a root is not a link.
  const rootFlag = (lowered["x-tunnel-root"] || qs.root || "").toString().trim().toLowerCase();
  // A code signal always wins: crafted ?root=1 on a real link URL must not
  // hijack it into root handling (root rewrites never carry a code).
  const hasCodeSignal = (lowered["x-tunnel-code"] || qs.c || "").trim();
  if ((rootFlag === "1" || rootFlag === "true") && !hasCodeSignal) {
    if (host === systemShortHost()) {
      // System short host keeps its long-standing permanent redirect.
      return { statusCode: 301, headers: { Location: HOME, "Cache-Control": "no-store" } };
    }
    try {
      const doc = await freshGet(s, `domain/${host}`, { type: "json" }).catch(() => null);
      const target = doc && doc.status === "active" && coverageValid(doc) &&
        typeof doc.apexTarget === "string" ? doc.apexTarget.trim() : "";
      if (target && /^https?:\/\//.test(target)) {
        try {
          const u = new URL(target);
          if ((u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && u.hostname) {
            return { statusCode: 302, headers: { Location: target, "Cache-Control": "no-store" } };
          }
        } catch { /* fall through to HOME */ }
      }
    } catch { /* fail-open to HOME */ }
    return { statusCode: 302, headers: { Location: HOME, "Cache-Control": "no-store" } };
  }

  // Prefer X-Tunnel-Code header (set by edge function, carries no query string)
  // over ?c= query param (SaaS Worker / direct hits / deploy-skew fallback),
  // then path segment (direct function hits).
  let code = (lowered["x-tunnel-code"] || qs.c || "").trim();
  if (!code) {
    const parts = (event.path || "").split("/").filter(Boolean);
    code = parts[parts.length - 1] || "";
  }
  if (!code || /[.]{2}|[/\\]/.test(code)) {
    return { statusCode: 302, headers: { Location: HOME, "Cache-Control": "no-store" } };
  }

  // TEMPORARY diagnostic (REMOVE AFTER the 2026-09 SaaS attribution fix is
  // verified): echoes resolve-ingress attribution instead of serving.
  // Trigger: ?dbgip=1 (direct hits) OR the reserved path __dbgip_tunnel
  // (survives every rewrite, since slugs travel by path). Records nothing,
  // counts nothing, works on unknown codes too. All values truncated to /24
  // (IPv4) so the owner can compare against their known ISP/VPN address
  // without handling full addresses.
  if ((qs.dbgip || "").toString().trim() === "1" || code === "__dbgip_tunnel") {
    const trunc24 = (v) => {
      const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
      return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : (String(v || "").includes(":") ? "ipv6-present" : "absent");
    };
    const pick1 = (v) => String(v || "").split(",")[0].trim();
    const xffAll = String(lowered["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    let winner = "?";
    try { winner = trunc24(clickClientIp(event, host)); } catch {}
    const body = JSON.stringify({
      via: (qs.dbgip || "").toString().trim() === "1" ? "query" : "path",
      host,
      isCustom: !!host && host !== systemShortHost(),
      present: {
        xTunnelHost: !!lowered["x-tunnel-host"],
        qsH: !!qs.h,
        xForwardedHost: !!lowered["x-forwarded-host"],
        cfConnectingIp: !!lowered["cf-connecting-ip"],
        xTunnelForwarded: !!lowered["x-tunnel-forwarded"],
        xTunnelClientIp: !!lowered["x-tunnel-client-ip"],
        xNf: !!lowered["x-nf-client-connection-ip"],
      },
      xffSegments: xffAll.length,
      xffOrdered: xffAll.map(trunc24),
      cfValue: trunc24(pick1(lowered["cf-connecting-ip"])),
      xTunnelForwardedValue: trunc24(pick1(lowered["x-tunnel-forwarded"])),
      xTunnelClientIpValue: trunc24(pick1(lowered["x-tunnel-client-ip"])),
      xNfValue: trunc24(pick1(lowered["x-nf-client-connection-ip"])),
      winner,
    });
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
      body,
    };
  }

  // A link clicked seconds after creation can still be missing from the
  // edge cache — retry briefly before calling it unknown (same read-your-
  // writes gap as the app's session sync). Budget stays sub-second so
  // mistyped codes still 404 quickly.
  // Where to send unknown/expired codes: the branded 404 page, carrying the
  // visited short domain (?h=) so it displays e.g. s.inoculens.com/abc — not
  // tunnel.inoculens.com/abc, which is just where the page happens to live.
  const notFoundDest =
    `${HOME.replace(/\/$/, "")}/404.html?c=${encodeURIComponent(code)}` +
    `&h=${encodeURIComponent(host)}`;
  const link = await getWithRetry(s, linkKey(host, code), { type: "json" }, { attempts: 3, delayMs: 300 }).catch(() => null);
  if (!link || !/^https?:\/\//.test(link.original || "")) {
    return { statusCode: 302, headers: { Location: notFoundDest, "Cache-Control": "no-store" } };
  }

  // Hard stop on lapsed coverage: links on custom domains whose payment
  // year / promo grant ran out behave as deleted (the branded 404 copy
  // already reads "Link Expired"). No click is logged — this was not a
  // visit. System-host links are unaffected; a missing domain doc fails
  // open (link deletion cascades, so this should not happen).
  if (link.domain && link.domain !== systemShortHost()) {
    const doc = await freshGet(s, `domain/${link.domain}`, { type: "json" }).catch(() => null);
    if (doc && !coverageValid(doc)) {
      return { statusCode: 302, headers: { Location: notFoundDest, "Cache-Control": "no-store" } };
    }
  }

  // Ledger-forever logging (best effort — never block redirect).
  // Same-IP loops still redirect but only bump the counter past
  // the per-minute detail budget (distinct IPs each get full budget, so viral
  // + dumb repeats are fully stored). Totals are exact via write-only shards;
  // link.clickCount stays as an approximate live badge.
  try {
    if (link.quarantined) {
      return { statusCode: 302, headers: { Location: notFoundDest, "Cache-Control": "no-store" } };
    }
    // Attribution source is path-aware (edge stamp vs Cloudflare value —
    // see clickClientIp): the generic trustedRawIp demonstrably yields edge
    // egress on this rewritten path, so it must not feed click rows/buckets.
    const rawIp = clickClientIp(event, host);
    const storeDetail = await shouldStoreClickDetail(s, host, link.code, rawIp);
    // Full visitor address (new field; the truncated ip below stays the
    // privacy-preserving default everywhere else). Stored only when the
    // source actually resolved to an IP literal — never "unknown".
    const fullIp = isIpLiteral(rawIp) ? String(rawIp).trim() : null;
    const truncIp = truncateIp(rawIp);
    if (storeDetail) {
      const id = newClickId();
      await s.setJSON(`${clicksPrefix(host, link.code)}${id}`, {
        id,
        timestamp: Date.now(),
        ip: truncIp,
        ...(fullIp ? { fullIp } : {}),
      });
    } else {
      await s.setJSON(`${clicksPrefix(host, link.code)}flood-${Date.now().toString(36)}`, {
        id: `flood-${Date.now().toString(36)}`,
        timestamp: Date.now(),
        ip: truncIp,
        ...(fullIp ? { fullIp } : {}),
        flood: true,
      }).catch(() => {});
    }
    if (link.baseCount === undefined) link.baseCount = link.clickCount || 0;
    link.clickCount = (link.clickCount || 0) + 1;
    await s.setJSON(linkKey(host, link.code), link);
    await writeCountShard(s, host, link.code, 1);
  } catch (e) {
    console.error("click log failed:", e);
  }

  // App-open handoff: mobile deep links get the frictionless interstitial
  // (auto-fires the native target, falls back to https when no app is
  // installed). Everything else keeps the instant 302.
  try {
    const ua = lowered["user-agent"] || "";
    const targets = buildAppTargets(link.original);
    if (shouldServeInterstitial(ua, targets)) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "strict-origin-when-cross-origin",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          "X-Frame-Options": "DENY",
        },
        body: interstitialPage(targets),
      };
    }
  } catch (e) {
    console.error("interstitial failed, falling back to 302:", e?.message || e);
  }
  return {
    statusCode: 302,
    headers: { Location: link.original, "Cache-Control": "no-store" },
  };
}
