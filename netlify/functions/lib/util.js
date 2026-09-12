/**
 * Shared helpers for the INOCULENS Tunnel Netlify backend.
 * Storage: Netlify Blobs (store name "tunnel"). No external DB account needed.
 *
 * Key layout:
 *   sessions/<sessionId>            { createdAt }
 *   link/<code>                     { code, original, short, domain, sessionId,
 *                                     deleteToken, label, clickCount, platform, createdAt }
 *   clicks/<code>/<clickId>         { id, timestamp, ip }
 *   domain/<hostname>               { domain, sessionId, status, paymentStatus,
 *                                     isVerified, verificationToken, sslTarget,
 *                                     dnsVerification:{cnameValid,txtVerified,sslVerified},
 *                                     discount, quote, createdAt }
 *   wallet/meta                     { nextIndex }
 *   rl/<name>/<ip>/<windowMinute>   { count }
 *   feedback/<date>-<ts36>-<rand8>   { id, sessionId, message, contact,
 *                                     createdAt, ip, ua }
 */
import { getStore, connectLambda } from "@netlify/blobs";
import { randomBytes } from "node:crypto";

export function store(event) {
  // Netlify Functions run in Lambda-compatibility mode: the Blobs environment
  // is NOT auto-configured unless we bind the incoming Lambda event first.
  // Without this every backend call fails with MissingBlobsEnvironmentError
  // (the "unexpected error" seen in production). See:
  // https://www.npmjs.com/package/@netlify/blobs (connectLambda).
  if (event) {
    try {
      connectLambda(event);
    } catch (e) {
      console.error("connectLambda failed:", e?.message || e);
    }
  }
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || null;
  const token =
    process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN || process.env.BLOBS_TOKEN || null;
  // Scheduled functions have no HTTP event, so they rely on explicit env.
  // Regular functions prefer the event-bound environment and only fall back
  // to explicit siteID+token when both are configured (e.g. local dev).
  // NOTE on consistency: the siteID+token path talks to the Netlify API
  // origin (strongly consistent). The event-bound path reads from the
  // edge cache (eventually consistent, up to ~60s drift for updates and
  // a few seconds even for new keys in practice). The store is therefore
  // intentionally opened WITHOUT a store-level consistency flag — a global
  // "strong" would throw BlobsConsistencyError on runtimes whose Lambda
  // context carries no uncachedEdgeURL. Instead, reads that must see
  // their own writes use freshGet()/getWithRetry() below (strong-first
  // with graceful fallback + bounded retries).
  if (siteID && token) {
    try {
      return getStore({ name: "tunnel", siteID, token });
    } catch (e) {
      console.error("getStore(siteID+token) failed, falling back:", e?.message || e);
    }
  }
  return getStore("tunnel");
}

// ---------- Read-your-writes helpers (Netlify Blobs eventual consistency) ----------
// Background: Blobs edge reads lag writes (a few seconds in practice, up to
// 60s for updates/deletes). The same browser that just created a session or
// link can therefore re-read stale state ("Unknown or missing session",
// empty history) until the edge catches up. These helpers close that gap
// WITHOUT slowing the happy path:
//  - freshGet: fast eventual read first (edge-cached, same speed as a plain
//    s.get). Only when the key reads MISSING does it try one strong-
//    consistent read (origin, slower but fresh). Found keys cost exactly one
//    fast read — identical latency to before.
//  - getWithRetry: bounded re-reads for keys that were JUST written. First
//    attempt is immediate; later attempts wait briefly. Total worst-case
//    budget is kept under ~1s so genuinely unknown keys still 404 quickly,
//    while the frontend's own retry covers longer lag windows.

export function isStrongConsistencyError(e) {
  if (!e) return false;
  if (e.name === "BlobsConsistencyError") return true;
  return /strong consistency|uncachedEdgeURL/i.test(e.message || "");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freshGet(s, key, opts = {}) {
  const v = await s.get(key, opts);
  if (v !== null && v !== undefined) return v;
  // Missing on the fast path — may be edge lag on a just-written key.
  // One strong read (origin) before concluding it is really absent.
  try {
    return await s.get(key, { ...opts, consistency: "strong" });
  } catch (e) {
    if (isStrongConsistencyError(e)) return v;
    throw e;
  }
}

export async function getWithRetry(s, key, opts = {}, { attempts = 3, delayMs = 350 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const v = await freshGet(s, key, opts);
      if (v !== null && v !== undefined) return v;
      last = v;
    } catch (e) {
      console.error(`getWithRetry(${key}) attempt ${i + 1}/${attempts} failed:`, e?.message || e);
      if (i === attempts - 1) throw e;
    }
  }
  return last;
}

// Run async work over items with bounded parallelism: sequential await in a
// for-loop pays a full round-trip per item (N x RTT), while unbounded
// Promise.all can burst hundreds of requests at once. Batches of ~12 keep
// list scans (links/domains/clicks) fast without hammering the store.
export async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  const n = Math.max(1, Math.floor(limit) || 1);
  for (let i = 0; i < items.length; i += n) {
    const chunk = items.slice(i, i + n);
    const res = await Promise.all(chunk.map((it, j) => fn(it, i + j)));
    for (let j = 0; j < res.length; j++) out[i + j] = res[j];
  }
  return out;
}

/**
 * List all blob entries under a prefix. The client auto-paginates by
 * default; `paginate: true` yields an AsyncIterator on newer versions.
 * This helper works with either behavior.
 */
export async function listAll(s, prefix) {
  try {
    const res = await s.list({ prefix });
    if (res && Array.isArray(res.blobs)) return res.blobs;
  } catch (e) {
    console.error(`listAll(${prefix}) failed:`, e?.message || e);
    return [];
  }
  // Fallback: manual pagination iterator.
  const all = [];
  try {
    for await (const entry of s.list({ prefix, paginate: true })) {
      if (entry && Array.isArray(entry.blobs)) all.push(...entry.blobs);
    }
  } catch (e) {
    console.error(`listAll(${prefix}) paginated failed:`, e?.message || e);
  }
  return all;
}

// ---------- HTTP ----------

export function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

export const ok = (obj = {}) => json(200, obj);

/** Error shape the frontend understands: { error: { code, message } }. */
export function fail(statusCode, code, message) {
  return json(statusCode, { error: { code, message } });
}

// ---------- Validation ----------
// Strict split (no legacy): sessions are exactly 10 alphanumerics without "1"
// and without specials. Admin keys are exactly 10 chars, always contain "1",
// specials "@#$" allowed (never valid as session, so auto-routes to admin).
export const SESSION_RE = /^[A-Za-z023456789]{10}$/;
export const ADMIN_RE = /^[A-Za-z0-9\-_!@#$]{10}$/;
export const CODE_RE = /^[A-Za-z0-9_-]{1,30}$/;
export const MAX_SLUG_LEN = 30;
export const MAX_ORIGINAL_URL_LEN = 2048;
export const HOST_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.[A-Za-z]{2,}$/;

export function validSessionId(v) {
  return typeof v === "string" && SESSION_RE.test(v) && !v.includes("1");
}

export function validAdminKey(v) {
  return typeof v === "string" && ADMIN_RE.test(v) && v.includes("1");
}

export function validSlug(v) {
  return typeof v === "string" && CODE_RE.test(v);
}

export function cleanDomain(raw) {
  if (typeof raw !== "string") return null;
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!HOST_RE.test(d)) return null;
  return d;
}

export function validHttpUrl(v) {
  try {
    if (typeof v !== "string") return false;
    const t = v.trim();
    if (!t || t.length > MAX_ORIGINAL_URL_LEN) return false;
    // Reject whitespace/control chars and obvious HTML/JS injection carriers.
    // new URL() already rejects most, but explicit keeps errors clear and
    // blocks encoded bypass attempts before parsing.
    if (/[\x00-\x1F\x7F<>\"\\^`{|}]/.test(t) || /\s/.test(t)) return false;
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // Block userinfo (https://user:pass@host) — classic phishing carrier.
    if (u.username || u.password) return false;
    if (!u.hostname || u.hostname.length > 253) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------- IDs / tokens ----------

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const TOKEN_ALPHABET = CODE_ALPHABET + "-_";

function randFrom(alphabet, n) {
  // Rejection sampling: avoids modulo bias from `byte % len`.
  const len = alphabet.length;
  const max = 256 - (256 % len);
  let out = "";
  while (out.length < n) {
    const buf = randomBytes(n * 2);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      if (buf[i] < max) out += alphabet[buf[i] % len];
    }
  }
  return out;
}

export const newCode = (n = 8) => randFrom(CODE_ALPHABET, n);
export const newToken = (n = 24) => randFrom(TOKEN_ALPHABET, n);
export const newClickId = () => `${Date.now().toString(36)}-${randFrom(CODE_ALPHABET, 8)}`;

// ---------- Platform deep links (app-opening targets) ----------
// detectPlatform() mirrors the frontend badge. buildAppTargets() goes further:
// for a supported social URL it returns everything the resolver's
// frictionless interstitial needs to break out of in-app browsers:
//   - https:         original URL (universal link + install-missing fallback)
//   - iosScheme:     custom-scheme URL for iOS (instagram://, vnd.youtube:// …)
//   - androidIntent:  intent:// URL with package + browser fallback for Android
// Desktop + crawlers keep a direct 302; mobile gets the interstitial which
// auto-fires these targets and falls back to https when no app is installed.

const PLATFORM_PATTERNS = [
  ["youtube", /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.?be)\//i],
  ["instagram", /^(https?:\/\/)?(www\.|m\.)?instagram\.com\//i],
  ["facebook", /^(https?:\/\/)?(www\.|m\.|web\.)?(facebook\.com|fb\.?com)\//i],
  ["twitter", /^(https?:\/\/)?(www\.|mobile\.)?(twitter\.com|x\.com)\//i],
  ["tiktok", /^(https?:\/\/)?((www|m|vm|vt)\.)?tiktok\.com\//i],
  ["linkedin", /^(https?:\/\/)?(www\.)?linkedin\.com\//i],
];

const PLATFORM_META = {
  youtube: { appName: "YouTube", androidPackage: "com.google.android.youtube" },
  instagram: { appName: "Instagram", androidPackage: "com.instagram.android" },
  facebook: { appName: "Facebook", androidPackage: "com.facebook.katana" },
  twitter: { appName: "X", androidPackage: "com.twitter.android" },
  tiktok: { appName: "TikTok", androidPackage: "com.zhiliaoapp.musically" },
  linkedin: { appName: "LinkedIn", androidPackage: "com.linkedin.android" },
};

export function detectPlatform(url) {
  for (const [key, re] of PLATFORM_PATTERNS) {
    if (re.test(String(url))) return key;
  }
  return null;
}

function parseHttpUrl(v) {
  try {
    const t = String(v || "").trim();
    if (!t || t.length > MAX_ORIGINAL_URL_LEN) return null;
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || !u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

function toIntentUrl(httpsUrl, androidPackage, intentHost) {
  if (!/^[A-Za-z0-9_.]+$/.test(String(androidPackage || ""))) return null;
  const u = parseHttpUrl(httpsUrl);
  if (!u) return null;
  const host = String(intentHost || u.hostname).toLowerCase();
  if (!HOST_RE.test(host)) return null;
  // Intent host part carries path+query only (no fragment); the full https
  // URL (fragment included) travels as the browser fallback extra.
  const path = `${u.pathname}${u.search}` || "/";
  return (
    `intent://${host}${path}` +
    `#Intent;package=${androidPackage};scheme=https;` +
    `S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`
  );
}

function schemeSwap(httpsUrl, scheme) {
  const u = parseHttpUrl(httpsUrl);
  if (!u) return null;
  return `${scheme}://${u.hostname}${u.pathname}${u.search}${u.hash}`;
}

function youtubeVideoId(u) {
  try {
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0] || "";
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
    }
    if (host === "youtube.com") {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/);
      if (m) return m[2];
    }
  } catch { /* fall through */ }
  return null;
}

export function buildAppTargets(originalUrl) {
  const platform = detectPlatform(originalUrl);
  if (!platform || !PLATFORM_META[platform]) return null;
  const u = parseHttpUrl(originalUrl);
  if (!u) return null;
  // Canonical https: upgrade http -> https so intents/schemes are consistent.
  u.protocol = "https:";
  const https = u.toString();
  const { appName, androidPackage } = PLATFORM_META[platform];
  const bareHost = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.|web\.)/, "");

  let iosScheme = null;
  let intentHost = u.hostname.toLowerCase();
  if (platform === "youtube") {
    const vid = youtubeVideoId(u);
    if (vid) {
      // Keep timestamp/playlist context where present (t, list, index).
      const keep = new URLSearchParams();
      keep.set("v", vid);
      for (const k of ["t", "start", "list", "index"]) {
        const val = u.searchParams.get(k);
        if (val) keep.set(k, val);
      }
      iosScheme = `vnd.youtube://watch?${keep.toString()}`;
      const intentPath = `/watch?${keep.toString()}`;
      const androidIntent = `intent://www.youtube.com${intentPath}` +
        `#Intent;package=${androidPackage};scheme=https;` +
        `S.browser_fallback_url=${encodeURIComponent(https)};end`;
      return { platform, appName, https, iosScheme, androidIntent };
    }
    iosScheme = schemeSwap(https, "youtube");
  } else if (platform === "instagram") {
    iosScheme = schemeSwap(https, "instagram");
  } else if (platform === "facebook") {
    iosScheme = schemeSwap(https, "fb");
    intentHost = bareHost === "fb.com" ? "www.facebook.com" : intentHost;
  } else if (platform === "twitter") {
    iosScheme = schemeSwap(https, "twitter");
  } else if (platform === "tiktok") {
    iosScheme = schemeSwap(https, "tiktok");
  } else if (platform === "linkedin") {
    iosScheme = schemeSwap(https, "linkedin");
  }
  if (!iosScheme) return null;
  const androidIntent = toIntentUrl(https, androidPackage, intentHost);
  if (!androidIntent) return null;
  return { platform, appName, https, iosScheme, androidIntent };
}

// ---------- Redirect policy: who gets the app-open interstitial? ----------
// - Crawlers/preview bots (incl. curl-like tools) get a direct 302 so link
//   previews unfurl against the real destination, not our interstitial.
// - Desktops get a direct 302 (OS already routes installed apps; the page
//   would be pure friction).
// - Mobile — or an unknown UA with no desktop token (e.g. a proxy that
//   stripped it) — gets the frictionless interstitial: it auto-fires the
//   native target and falls back to https when no app is installed.

const BOT_UA_RE =
  /facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|telegrambot|discordbot|whatsapp|googlebot|bingbot|duckduckbot|baiduspider|yandexbot|embedly|quora|pinterestbot|bytespider|applebot|crawler|spider|preview|curl|wget|python-requests|python-urllib|go-http-client|postman|insomnia|httpie/i;

const MOBILE_UA_RE = /android|iphone|ipad|ipod|mobile|phone|musical_ly|tiktok|instagram|fbav|fbios|fb_iab|fban/i;

const DESKTOP_UA_RE = /windows nt|macintosh|cros x11|x11|linux x86_64/i;

export function isBotUA(ua) {
  return BOT_UA_RE.test(String(ua || ""));
}

export function isMobileUA(ua) {
  return MOBILE_UA_RE.test(String(ua || ""));
}

export function isDesktopUA(ua) {
  const s = String(ua || "");
  // Android UAs contain "Linux" — mobile wins over desktop.
  if (MOBILE_UA_RE.test(s)) return false;
  return DESKTOP_UA_RE.test(s);
}

export function shouldServeInterstitial(ua, targets) {
  if (!targets || !targets.https || !targets.iosScheme || !targets.androidIntent) return false;
  const s = String(ua || "");
  if (isBotUA(s)) return false;
  if (isMobileUA(s)) return true;
  // Unknown UA (empty / stripped by a proxy): favor app-open over desktop
  // speed — the interstitial still falls back to the browser automatically.
  if (!isDesktopUA(s)) return true;
  return false;
}

// ---------- Client IP (trusted first, truncated for privacy) ----------
// Trust order: Netlify infra headers first (not client-spoofable),
// X-Forwarded-For LAST (client-controlled). For XFF fallback take the LAST
// entry (closest to LB), not the first (attacker-controlled).

export function trustedRawIp(event) {
  const h = event.headers || {};
  const lowered = {};
  for (const [k, v] of Object.entries(h)) lowered[String(k).toLowerCase()] = v;
  const pick = (v) => String(v || "").split(",")[0].trim();
  const pickLast = (v) => {
    const parts = String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };
  return (
    pick(lowered["x-nf-client-connection-ip"]) ||
    pick(lowered["client-ip"]) ||
    pick(lowered["cf-connecting-ip"]) ||
    pick(lowered["x-bb-ip"]) ||
    pickLast(lowered["x-forwarded-for"]) ||
    "unknown"
  );
}

export function clientIp(event) {
  const raw = trustedRawIp(event);
  if (raw.includes(":") && raw.includes(".")) return raw; // unexpected mix, keep
  if (raw.includes(":")) {
    // IPv6 → /64
    const parts = raw.split(":");
    return parts.slice(0, 4).join(":") + "::/64";
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) {
    // IPv4 → zero last octet
    return raw.split(".").slice(0, 3).join(".") + ".0";
  }
  return raw;
}

// ---------- Simple rate limiting (per IP, per minute window) ----------

export async function checkRate(s, name, ip, limit) {
  const win = Math.floor(Date.now() / 60000);
  const key = `rl/${name}/${ip}/${win}`;
  const cur = (await s.get(key, { type: "json" })) || { count: 0 };
  cur.count += 1;
  await s.setJSON(key, cur);
  return cur.count <= limit;
}

// ---------- DNS verification via DNS-over-HTTPS (no Cloudflare key needed) ----------

async function doh(name, type) {
  const res = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`
  );
  if (!res.ok) throw new Error(`DoH lookup failed (${res.status})`);
  const data = await res.json();
  return (data.Answer || []).map((a) => String(a.data));
}

export function routingTarget() {
  // SaaS CNAME target customers must point at (proxied, Cloudflare for SaaS).
  // INOCULENS account (inoculens.com): customers.inoculens.com -> proxy-fallback
  // -> Worker tunnel-custom-host -> Netlify resolver. Override per deploy.
  return (process.env.ROUTING_TARGET || "customers.inoculens.com").toLowerCase();
}

export function systemShortHost() {
  // System short-link host (DNS-only to Netlify, direct, no SaaS).
  return (process.env.SITE_URL || "s.inoculens.com").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// Apex (naked) domains like example.com cannot serve short links: DNS forbids
// CNAME at the apex, so routing can never validate and no certificate can
// provision (apex proxying is an Enterprise-only add-on we don't have).
// Users must add www.example.com or a subdomain (go.example.com) instead.
export async function isApexDomain(domain) {
  const d = cleanDomain(domain);
  if (!d) return false;
  try {
    const { default: psl } = await import("psl");
    const parsed = psl.parse(d);
    if (parsed && !parsed.error && parsed.domain) {
      return !parsed.subdomain;
    }
  } catch { /* fall through to label heuristic */ }
  return d.split(".").length <= 2;
}

export function apexBlockedMessage(host) {
  return (
    `Apex (naked) domains can't be used for short links — DNS does not allow a CNAME at the apex, ` +
    `so neither routing nor TLS can ever validate for "${host}". ` +
    `Use any subdomain you like instead — www.${host}, go.${host}, s.${host}, links.${host}, anything. ` +
    `Tip: most registrars offer free domain forwarding — forward ${host} to your Tunnel subdomain so visitors still find you.`
  );
}

export function dcvDelegationSuffix() {
  // DCV Delegation suffix for the INOCULENS Cloudflare account.
  // Zone inoculens.com UUID (via GET /zones/:id/dcv_delegation/uuid).
  // Full target per domain: <domain>.<uuid>.dcv.cloudflare.com
  // Only needed for TXT/delegated validation; HTTP validation (default) needs no extra record.
  return process.env.DCV_DELEGATION_UUID || "adad0549ffb44d06";
}

export function dcvDelegationTargetFor(domain) {
  const d = cleanDomain(domain);
  if (!d) return null;
  return `${d}.${dcvDelegationSuffix()}.dcv.cloudflare.com`;
}

export function sslDelegationTarget() {
  // If set, _acme-challenge.<domain> must CNAME here for SSL to verify.
  // If unset and AUTO_SSL != "0", Cloudflare SaaS HTTP validation is used:
  // routing validity implies SSL will auto-provision (no extra record).
  return process.env.SSL_DELEGATION_TARGET || null;
}

// ---------- Cloudflare for SaaS (Custom Hostnames) ----------
// Backend needs CLOUDFLARE_API_TOKEN (SaaS Edit + Zone Read) + CLOUDFLARE_ZONE_ID.
// Used to create/delete custom hostnames on activation and to report real
// certificate/hostname status instead of inferring SSL from DNS alone.

export function cfConfig() {
  const token = process.env.CLOUDFLARE_API_TOKEN || null;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID || "f5257b10f944cb85e5418ab82f4be6ef";
  return token ? { token, zoneId } : null;
}

async function cfFetch(path, { method = "GET", body } = {}) {
  const cfg = cfConfig();
  if (!cfg) {
    const e = new Error("Cloudflare not configured (missing CLOUDFLARE_API_TOKEN).");
    e.statusCode = 412;
    e.code = "failed-precondition";
    throw e;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !data?.success) {
    const msg = data?.errors?.map((x) => x.message).join("; ") || `Cloudflare API ${res.status}`;
    const e = new Error(msg);
    e.statusCode = 502;
    e.code = "unavailable";
    throw e;
  }
  return data.result;
}

export async function cfGetCustomHostname(domain) {
  const d = cleanDomain(domain);
  if (!d) return null;
  try {
    const list = await cfFetch(`/custom_hostnames?hostname.exact=${encodeURIComponent(d)}&per_page=5`);
    const arr = Array.isArray(list) ? list : list?.result || [];
    return arr[0] || null;
  } catch (e) {
    console.error(`cfGetCustomHostname(${d}) failed:`, e?.message || e);
    return null;
  }
}

export async function cfEnsureCustomHostname(domain) {
  const d = cleanDomain(domain);
  if (!d) throw Object.assign(new Error("Invalid domain name."), { statusCode: 400, code: "invalid-argument" });
  const existing = await cfGetCustomHostname(d);
  if (existing) return existing;
  // HTTP validation: no extra customer record beyond the CNAME to ROUTING_TARGET.
  // Certificates auto-issue once the hostname points at us; downtime is a few minutes max.
  return cfFetch(`/custom_hostnames`, {
    method: "POST",
    body: {
      hostname: d,
      ssl: { method: "http", type: "dv", bundle_method: "ubiquitous", wildcard: false, settings: { min_tls_version: "1.2" } },
    },
  });
}

export async function cfDeleteCustomHostname(domain) {
  const d = cleanDomain(domain);
  if (!d) return false;
  const existing = await cfGetCustomHostname(d).catch(() => null);
  if (!existing?.id) return false;
  try {
    await cfFetch(`/custom_hostnames/${existing.id}`, { method: "DELETE" });
    return true;
  } catch (e) {
    console.error(`cfDeleteCustomHostname(${d}) failed:`, e?.message || e);
    return false;
  }
}

export async function verifyDns(domain, token) {
  const target = routingTarget().toLowerCase().replace(/\.$/, "");
  // Only the live SaaS target is accepted (pre-launch: no legacy records exist).
  const acceptedTargets = new Set([target]);
  const checks = { cname: false, txt: false, ssl: false, routable: null, cfHostnameStatus: null, cfSslStatus: null };

  // Authoritative CNAME check via the Cloudflare API when the hostname has
  // a record there (grey or proxied): public DoH HIDES the CNAME of proxied
  // (orange) records (returns edge A/AAAA instead), so DoH alone fails
  // exactly the correctly-configured proxied domains. The API record content
  // is authoritative in both states. Names without a record there are never
  // found and fall through to DoH below.
  let apiCheckedCname = false;
  if (cfConfig()) {
    try {
      const list = await cfFetch(`/dns_records?name.exact=${encodeURIComponent(cleanDomain(domain))}&per_page=10`);
      const arr = Array.isArray(list) ? list : list?.result || [];
      const cnameRec = arr.find((r) => String(r.type || "").toUpperCase() === "CNAME");
      if (cnameRec) {
        apiCheckedCname = true;
        checks.cname = acceptedTargets.has(String(cnameRec.content || "").toLowerCase().replace(/\.$/, ""));
      } else if (arr.length) {
        // A/AAAA directly on the name (not the documented CNAME setup).
        apiCheckedCname = true;
        checks.cname = false;
      }
    } catch (e) {
      console.error(`verifyDns(${domain}) API check failed, falling back to DoH:`, e?.message || e);
    }
  }

  if (!apiCheckedCname) {
    try {
      const cname = await doh(domain, "CNAME");
      checks.cname = cname.some((v) => acceptedTargets.has(v.toLowerCase().replace(/\.$/, "")));
      // Apex / flattened setups: some providers return A instead of CNAME.
      // If no CNAME match, accept when the domain resolves to the same edge as the SaaS target.
      if (!checks.cname) {
        try {
          const [aDomain, aTarget] = await Promise.all([
            doh(domain, "A").catch(() => []),
            doh(target, "A").catch(() => []),
          ]);
          const targetIps = new Set(aTarget.map(String));
          if (targetIps.size && aDomain.some((ip) => targetIps.has(String(ip)))) checks.cname = true;
        } catch { /* keep false */ }
      }
    } catch {
      checks.cname = false;
    }
  }

  try {
    const txt = await doh(`verification.${domain}`, "TXT");
    checks.txt = txt.some((v) => v.replace(/"/g, "").trim() === token);
  } catch {
    checks.txt = false;
  }

  // Routability: does the name resolve to a usable edge address? Ownership
  // checks can pass while the domain is still unservable (wrong target, or
  // a same-zone grey CNAME bottoming out at the originless fallback 100::).
  // Fail-open by design: lookup errors yield null (unknown, never blocks);
  // only a definitive empty/discard answer yields false.
  try {
    const [a, aaaa] = await Promise.all([
      doh(domain, "A").catch(() => null),
      doh(domain, "AAAA").catch(() => null),
    ]);
    if (a === null && aaaa === null) {
      checks.routable = null;
    } else {
      const v4 = Array.isArray(a) ? a.map(String) : [];
      const v6 = Array.isArray(aaaa) ? aaaa.map(String) : [];
      const usableV6 = v6.filter((ip) => {
        const n = ip.toLowerCase().replace(/\.$/, "");
        return n !== "100::" && n !== "::" && n !== "::1";
      });
      checks.routable = v4.length > 0 || usableV6.length > 0;
    }
  } catch {
    checks.routable = null;
  }

  // SaaS certificate/hostname status when Cloudflare is configured — the
  // same lookup for every custom domain (HTTP validation needs no extra
  // customer record beyond the CNAME).
  if (cfConfig()) {
    const cf = await cfGetCustomHostname(domain);
    if (cf) {
      checks.cfHostnameStatus = cf.status || null;
      checks.cfSslStatus = cf.ssl?.status || null;
      // HTTP validation provisions automatically once CNAME is correct.
      checks.ssl = cf.ssl?.status === "active";
    } else {
      // No custom hostname yet: SSL cannot be active. It will be created
      // automatically after payment (see api.js ensureSaaSHostname).
      checks.ssl = false;
    }
    // Explicit delegation (TXT/delegated method) still honored if configured.
    const delegation = sslDelegationTarget();
    if (delegation && !checks.ssl) {
      try {
        const cname = await doh(`_acme-challenge.${domain}`, "CNAME");
        const want = delegation.toLowerCase().replace(/\.$/, "");
        if (cname.some((v) => v.toLowerCase().replace(/\.$/, "") === want)) checks.ssl = true;
      } catch { /* keep API result */ }
    }
    return checks;
  }

  // No Cloudflare token (local dev): TLS follows routing when AUTO_SSL is on.
  const delegation = sslDelegationTarget();
  if (delegation) {
    try {
      const cname = await doh(`_acme-challenge.${domain}`, "CNAME");
      const want = delegation.toLowerCase().replace(/\.$/, "");
      checks.ssl = cname.some((v) => v.toLowerCase().replace(/\.$/, "") === want);
    } catch {
      checks.ssl = false;
    }
  } else if (process.env.AUTO_SSL !== "0") {
    checks.ssl = checks.cname;
  }

  return checks;
}

// ---------- Bitcoin pricing (live only, never hardcoded fallback) ----------
// Tries free providers in order. Any success = live price. All fail = throw
// 503 and UI asks user to refresh/retry. BTC_USD_FALLBACK is intentionally
// ignored (a stale $65k default can misprice by thousands).

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function btcUsdPrice() {
  const errors = [];
  // 1. CoinGecko (no key)
  try {
    const res = await fetchWithTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      2500
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    const price = Number(data?.bitcoin?.usd);
    if (Number.isFinite(price) && price > 0) return price;
    throw new Error("bad price");
  } catch (e) {
    errors.push(`coingecko:${e?.message || e}`);
  }
  // 2. Coinbase spot (no key)
  try {
    const res = await fetchWithTimeout("https://api.coinbase.com/v2/prices/BTC-USD/spot", 2500);
    if (!res.ok) throw new Error(`Coinbase ${res.status}`);
    const data = await res.json();
    const price = Number(data?.data?.amount);
    if (Number.isFinite(price) && price > 0) return price;
    throw new Error("bad price");
  } catch (e) {
    errors.push(`coinbase:${e?.message || e}`);
  }
  // 3. Bitstamp ticker (no key)
  try {
    const res = await fetchWithTimeout("https://www.bitstamp.net/api/v2/ticker/btcusd/", 2500);
    if (!res.ok) throw new Error(`Bitstamp ${res.status}`);
    const data = await res.json();
    const price = Number(data?.last);
    if (Number.isFinite(price) && price > 0) return price;
    throw new Error("bad price");
  } catch (e) {
    errors.push(`bitstamp:${e?.message || e}`);
  }
  console.error(`btcUsdPrice all providers failed: ${errors.join(" | ")}`);
  throw new Error("Bitcoin price unavailable, refresh and try again later.");
}

export function quoteFor(discountPct, price) {
  const rawUsd = Number(process.env.DOMAIN_PRICE_USD || 10);
  const usd = Number.isFinite(rawUsd) && rawUsd > 0 ? rawUsd : 10;
  const pct = Math.min(Math.max(Number(discountPct) || 0, 0), 100);
  const due = usd * (1 - pct / 100);
  const amount = (due / price).toFixed(8);
  const rawTtl = Number(process.env.QUOTE_TTL_DAYS || 7);
  const ttlDays = Number.isFinite(rawTtl) && rawTtl >= 1 && rawTtl <= 30 ? rawTtl : 7;
  const now = Date.now();
  return {
    amount,
    originalAmount: pct > 0 ? (usd / price).toFixed(8) : undefined,
    discountPercent: pct > 0 ? pct : undefined,
    expiresAt: new Date(now + ttlDays * 86400000).toISOString(),
    createdAt: new Date(now).toISOString(),
  };
}

// ---------- Money math (shared, exact — never float) ----------
// BTC amounts are decimal strings with up to 8 places. Converting through
// Number()*1e8 can be off by a sat (e.g. 0.00000001 -> 0). String-split is
// exact. Single implementation used by the watcher and checkPaymentNow so
// the two paths can never disagree on what "paid in full" means.

export function satsFromBtc(btcAmount) {
  const parts = String(btcAmount).split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(8, "0").slice(0, 8);
  const w = whole === "" || whole === "-" ? "0" : whole;
  const f = frac === "" ? "0" : frac;
  if (!/^\d+$/.test(w) || !/^\d+$/.test(f)) throw new Error("Invalid BTC amount.");
  return BigInt(w) * 100000000n + BigInt(f);
}

export const satsToBtc = (sats) => (Number(sats) / 1e8).toFixed(8);

// Genuine renewal quote? Mirrors the hourly watcher: unconsumed, issued after
// the last payment. Legacy quotes without createdAt count (otherwise old
// domains stall forever).
export function isRenewalQuote(quote, lastPaymentAtMs) {
  if (!quote?.address || !quote?.amount || quote?.paidAt) return false;
  const lastPaid = Number.isFinite(Number(lastPaymentAtMs)) ? Number(lastPaymentAtMs) : 0;
  const quoteAt = quote.createdAt ? new Date(quote.createdAt).getTime() : Infinity;
  if (quote.createdAt && !Number.isFinite(quoteAt)) return false;
  return quoteAt > lastPaid;
}

// ---------- URL safety (Safe Browsing proactive at mint) ----------
// Cache: safety/<sha256(host+path)> -> { safe, reason, at }. TTL 24h default.
// Fail-open with log when key missing/timeout (don't break youtubers), but
// flagged-unsafe always blocks mint.

export function safetyCacheKey(url) {
  try {
    const u = new URL(String(url));
    const norm = `${u.hostname.toLowerCase()}${u.pathname}${u.search}`.slice(0, 500);
    // Node crypto dynamic to keep edge bundlers happy; fallback to raw.
    return `safety/${encodeURIComponent(norm).slice(0, 120)}`;
  } catch {
    return null;
  }
}

export async function originalHash(url) {
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(String(url).trim()).digest("hex");
  } catch {
    return null;
  }
}

export async function isBlockedOriginal(s, url) {
  try {
    const h = await originalHash(url);
    if (!h) return false;
    const doc = await s.get(`blocked/${h}`, { type: "json" });
    return !!doc;
  } catch {
    return false;
  }
}

export async function checkUrlSafety(s, url) {
  // Local blocklist first (fail-closed, no external call).
  try {
    if (await isBlockedOriginal(s, url)) return { safe: false, reason: "BLOCKLISTED" };
  } catch { /* fall through to live check */ }
  const key = process.env.SAFE_BROWSING_API_KEY || null;
  if (!key) return { safe: true, degraded: true, reason: "no-key" };
  const cacheKey = safetyCacheKey(url);
  const ttlH = Number(process.env.SAFETY_CACHE_TTL_HOURS || 24);
  const ttlMs = (Number.isFinite(ttlH) && ttlH > 0 ? ttlH : 24) * 3600000;
  if (cacheKey) {
    try {
      const cached = await s.get(cacheKey, { type: "json" });
      if (cached && cached.at && Date.now() - new Date(cached.at).getTime() < ttlMs) {
        return cached;
      }
    } catch { /* miss -> live check */ }
  }
  const verdict = await liveSafetyCheck(String(url), key).catch((e) => ({
    safe: true,
    degraded: true,
    reason: `check-failed:${e?.message || e}`,
  }));
  if (cacheKey) {
    try {
      await s.setJSON(cacheKey, { ...verdict, at: new Date().toISOString() });
    } catch (e) {
      console.error("safety cache save failed:", e?.message || e);
    }
  }
  if (verdict.degraded) console.warn(`safety degraded for ${url}: ${verdict.reason}`);
  return verdict;
}

async function liveSafetyCheck(url, apiKey) {
  const body = {
    client: { clientId: "inoculens-tunnel", clientVersion: "1.0" },
    threatInfo: {
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: [{ url }],
    },
  };
  const res = await fetchWithTimeout(
    `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`,
    Number(process.env.SAFETY_TIMEOUT_MS || 2000),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`safebrowsing ${res.status}`);
  const data = await res.json();
  const matches = Array.isArray(data?.matches) ? data.matches : [];
  if (matches.length) {
    return { safe: false, reason: String(matches[0]?.threatType || "UNSAFE") };
  }
  return { safe: true, reason: "clean" };
}

// ---------- Ledger helpers (forever, sharded counts, throttled logging) ----------

export function countDayKey(host, code, when = Date.now()) {
  const d = new Date(when);
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `counts/${cleanDomain(host) || "unknown"}/${code}/${day}`;
}

// Exact counters without read-modify-write races: each click writes one tiny
// shard doc (pure write, never lost under concurrency). Totals are derived by
// KEY COUNTING (no body fetches): minute shards +1, adj shards -1.
// Legacy day-aggs (pre-shard `counts/<h>/<c>/<day>` {count}) are history only.
export function minuteShardKey(host, code, delta = 1) {
  const now = new Date();
  const day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  const min = `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const r = Math.random().toString(36).slice(2, 10);
  const h = cleanDomain(host) || "unknown";
  return delta < 0
    ? `counts/${h}/${code}/${day}/${min}-adj-${r}`
    : `counts/${h}/${code}/${day}/${min}-${r}`;
}

export async function writeCountShard(s, host, code, delta = 1) {
  try {
    await s.setJSON(minuteShardKey(host, code, delta), { count: delta < 0 ? -1 : 1, at: new Date().toISOString() });
  } catch (e) {
    console.error(`writeCountShard failed:`, e?.message || e);
  }
}

// Sum from listed keys only (no body reads). Returns { delta, byDay }.
export function sumShardsFromKeys(countKeys) {
  let delta = 0;
  const byDay = new Map();
  for (const b of countKeys) {
    const key = String(b.key || b || "");
    const parts = key.split("/");
    // Minute shards: counts/<h>/<c>/<day>/<leaf> (4 segments after counts).
    // Legacy day-aggs: counts/<h>/<c>/<day> (3) — excluded here (history only).
    if (parts.length !== 5) continue;
    const day = parts[3];
    const leaf = parts[4] || "";
    const d = leaf.includes("-adj-") ? -1 : 1;
    delta += d;
    byDay.set(day, (byDay.get(day) || 0) + d);
  }
  return { delta, byDay };
}

export async function bumpDayCount(s, host, code, n = 1) {
  // Legacy day-agg path (kept for old graph history). New clicks use
  // writeCountShard instead — exact under concurrency.
  const key = countDayKey(host, code);
  try {
    const cur = (await s.get(key, { type: "json" })) || { count: 0 };
    cur.count = (Number(cur.count) || 0) + n;
    await s.setJSON(key, cur);
  } catch (e) {
    console.error(`bumpDayCount failed:`, e?.message || e);
  }
}

// Per-IP-per-link-per-minute logging bucket (redirect never blocked).
// Returns true if detail doc should be stored. Same IP looping 50k/min gets
// counted but not 50k docs. Distinct IPs each get full budget.
// IPv6 is bucketed by /64 prefix (rotation within a /64 shares budget),
// IPv4 by full address. Dorm NAT shares fairly via the higher /64 budget.
export function throttleBucketForIp(rawIp) {
  const raw = String(rawIp || "unknown").trim();
  if (raw.includes(":")) {
    // IPv6 (or already-truncated /64 like "2001:db8:abcd:12::/64"): take the
    // first 4 hextets as the /64 identity so rotation inside it shares budget.
    const noSuffix = raw.split("/")[0];
    // Expand "::" minimally: split and take leading groups; already-truncated
    // forms like "a:b:c:d::/64" yield ["a","b","c","d","",""] -> first 4.
    const parts = noSuffix.split(":").filter((x) => x !== "");
    const prefix = parts.slice(0, 4).join(":").toLowerCase() || "v6unknown";
    return `v6:${prefix}`;
  }
  return `v4:${raw.toLowerCase()}`;
}

export async function shouldStoreClickDetail(s, host, code, rawIp) {
  const bucket = throttleBucketForIp(rawIp);
  const isV6 = bucket.startsWith("v6:");
  const def = isV6 ? 300 : 30;
  const envKey = isV6 ? "RESOLVE_LOG_PER_NET64_MIN" : "RESOLVE_LOG_PER_IP_MIN";
  const limit = Number(process.env[envKey] || def);
  const lim = Number.isFinite(limit) && limit > 0 ? Math.min(limit, isV6 ? 2000 : 200) : def;
  try {
    const { createHash } = await import("node:crypto");
    const ipHash = createHash("sha256").update(bucket).digest("hex").slice(0, 16);
    const win = Math.floor(Date.now() / 60000);
    const key = `rl-resolve/${cleanDomain(host) || "unknown"}/${code}/${ipHash}/${win}`;
    const cur = (await s.get(key, { type: "json" })) || { count: 0 };
    cur.count = (Number(cur.count) || 0) + 1;
    await s.setJSON(key, cur);
    return cur.count <= lim;
  } catch {
    return true;
  }
}

// ---------- Turnstile (Cloudflare, risk-based on mint only — never redirect) ----------
// Lenient: only fast loops / near-quota sessions are asked, once in a while.
// Missing TURNSTILE_SECRET = never require (degraded, logged).

export function turnstileSiteKey() {
  return process.env.TURNSTILE_SITEKEY || null;
}

export async function verifyTurnstileToken(token, ip) {
  const secret = process.env.TURNSTILE_SECRET || null;
  if (!secret) return { ok: false, reason: "no-secret" };
  if (!token || typeof token !== "string") return { ok: false, reason: "missing" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    let res;
    try {
      res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret, response: token, remoteip: String(ip || "") }).toString(),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) return { ok: false, reason: `verify-${res.status}` };
    const data = await res.json().catch(() => null);
    return data && data.success ? { ok: true } : { ok: false, reason: "rejected" };
  } catch (e) {
    return { ok: false, reason: `error:${e?.message || e}` };
  }
}

// Returns true when this mint-family request should present a widget.
// Reads current-minute counters WITHOUT incrementing (checkRate increments).
export async function turnstileRequired(s, kind, ip, sessionId = null) {
  try {
    if (!process.env.TURNSTILE_SECRET) return false;
    const win = Math.floor(Date.now() / 60000);
    const getCount = async (key) => {
      try {
        const cur = await s.get(key, { type: "json" });
        return Number(cur?.count) || 0;
      } catch { return 0; }
    };
    if (kind === "shorten") {
      const c = await getCount(`rl/shorten/${ip}/${win}`);
      if (c >= 6) return true;
      if (sessionId) {
        const meta = await s.get(`sessions/${sessionId}/meta`, { type: "json" }).catch(() => null);
        const n = Number(meta?.linkCount) || 0;
        const quota = Number(process.env.LINK_QUOTA_SYSTEM || 500);
        const q = Number.isFinite(quota) && quota > 0 ? quota : 500;
        if (n >= q * 0.8) return true;
      }
      return false;
    }
    if (kind === "domain") {
      const c = await getCount(`rl/domain-add/${ip}/${win}`);
      return c >= 3;
    }
    if (kind === "claim") {
      const c = await getCount(`rl/claim/${ip}/${win}`);
      return c >= 2;
    }
    if (kind === "feedback") {
      const c = await getCount(`rl/feedback-ip/${ip}/${win}`);
      return c >= 3;
    }
  } catch { /* fail open */ }
  return false;
}

export async function bumpKindCounter(s, kind, ip) {
  try {
    const win = Math.floor(Date.now() / 60000);
    const key = `rl/${kind}/${ip}/${win}`;
    const cur = (await s.get(key, { type: "json" })) || { count: 0 };
    cur.count = (Number(cur.count) || 0) + 1;
    await s.setJSON(key, cur);
  } catch { /* ignore */ }
}

// Per-session link quota (system + custom combined).
export async function sessionLinkCount(s, sid) {
  try {
    const meta = await s.get(`sessions/${sid}/meta`, { type: "json" });
    if (meta && Number.isFinite(Number(meta.linkCount))) return Number(meta.linkCount);
  } catch { /* fall through to scan */ }
  return null;
}

export async function bumpSessionLinkCount(s, sid, delta) {
  try {
    const meta = (await s.get(`sessions/${sid}/meta`, { type: "json" })) || { linkCount: 0 };
    meta.linkCount = Math.max(0, (Number(meta.linkCount) || 0) + delta);
    await s.setJSON(`sessions/${sid}/meta`, meta);
  } catch (e) {
    console.error("bumpSessionLinkCount failed:", e?.message || e);
  }
}

// ---------- Coverage (subscription) model ----------
// A custom domain stays usable while "covered". Coverage comes from:
//  - a confirmed $10 payment  -> paidAt + 1 year (renewals stack on top),
//  - a redeemed 100% promo    -> until the code's expiry (lifetime if none),
//  - a redeemed partial promo -> paying the remainder grants paidAt + 1yr,
//    capped by the code's expiry while the code is still valid.
// coverageExpiresAt=null + coverageLifetime=true  = indefinite coverage.
// Anything else without a future coverageExpiresAt = no coverage (pending).
export const COVERAGE_YEAR_MS = 365 * 86400000;

export function coverageValid(doc) {
  if (!doc) return false;
  if (doc.coverageLifetime === true) return true;
  const t = doc.coverageExpiresAt ? new Date(doc.coverageExpiresAt).getTime() : NaN;
  return Number.isFinite(t) && t > Date.now();
}

// ---------- Scoped link keys ----------
// Slugs are unique PER root domain, not globally: s.inoculens.com/slug1 and
// custom.com/slug1 coexist. Storage keys (and click-log prefixes) therefore
// always pair the normalized host with the code.
export function linkKey(host, code) {
  return `link/${cleanDomain(host) || "unknown"}/${code}`;
}

export function clicksPrefix(host, code) {
  return `clicks/${cleanDomain(host) || "unknown"}/${code}/`;
}

// ---------- Wallet adapter ----------
// Real payment addresses need an HD wallet XPUB plus derivation libraries
// (see package.json: bitcoinjs-lib, bip32, @noble/secp256k1 via ecc-noble.js)
// and env BTC_XPUB=xpub…  (first receiving chain, index per quote).
// Without it, generatePaymentAddress fails with a clear "not configured"
// error instead of inventing an address. MANUAL_BTC_ADDRESS exists only
// for local testing (single reused address — NEVER production).

// Mainnet extended-public-key versions by wallet export format. Electrum
// shows segwit wallets as zpub (BIP84) — same keys as xpub, different prefix.
const XPUB_VERSIONS = { xpub: 0x0488b21e, ypub: 0x049d7cb2, zpub: 0x04b24746 };

function nodeFromExtendedKey(factory, networks, keyString) {
  const s = String(keyString || "").trim();
  try {
    return { node: factory.fromBase58(s), format: "xpub" };
  } catch (e) {
    if (!/version/i.test(e?.message || "")) throw e;
  }
  for (const [name, version] of Object.entries(XPUB_VERSIONS)) {
    if (name === "xpub") continue;
    try {
      const node = factory.fromBase58(s, {
        ...networks.bitcoin,
        bip32: { public: version, private: 0x00000000 },
      });
      return { node, format: name };
    } catch { /* try next version */ }
  }
  throw new Error("unrecognized extended public key version (want xpub/ypub/zpub)");
}

async function loadBtcLibs() {
  // Dynamic so the rest of the backend keeps working even if the wallet
  // deps are missing from a deploy. Staged errors: callers must distinguish
  // "libraries didn't load" (redeploy/dependency problem) from "key bad".
  try {
    const { payments, networks } = await import("bitcoinjs-lib");
    const { BIP32Factory } = await import("bip32");
    // Pure-JS ECC (./ecc-noble.js, @noble/secp256k1): intentionally NOT
    // tiny-secp256k1 — that package loads secp256k1.wasm via
    // `new URL(wasm, import.meta.url)`, which breaks under function bundlers
    // ("Invalid URL" in production). The noble adapter passes bip32's own
    // testEcc vectors and derives byte-identical addresses.
    const { ecc } = await import("./ecc-noble.js");
    if (!ecc || typeof ecc.isPoint !== "function") {
      throw new Error("ECC backend loaded without point functions");
    }
    return { payments, networks, BIP32Factory, ecc };
  } catch (e) {
    const err = new Error(`bitcoin libraries failed to load (${e?.message || e})`);
    err.statusCode = 412;
    err.code = "failed-precondition";
    throw err;
  }
}

export async function deriveAddress(index) {
  if (process.env.BTC_XPUB) {
    let libs;
    try {
      libs = await loadBtcLibs();
    } catch (e) {
      console.error("btc lib load failed:", e?.message || e);
      const err = new Error(
        `Bitcoin libraries unavailable on this deployment (${e?.message || e}). Redeploy so npm dependencies install.`
      );
      err.statusCode = 412;
      err.code = "failed-precondition";
      throw err;
    }
    try {
      const { node } = nodeFromExtendedKey(libs.BIP32Factory(libs.ecc), libs.networks, process.env.BTC_XPUB);
      const child = node.derive(0).derive(index);
      const { address } = libs.payments.p2wpkh({ pubkey: child.publicKey });
      if (address) return address;
      throw new Error("could not encode address");
    } catch (e) {
      console.error("xpub derivation failed:", e?.message || e);
      const err = new Error(`Configured BTC_XPUB is invalid (${e?.message || e}). Fix the env value.`);
      err.statusCode = 412;
      err.code = "failed-precondition";
      throw err;
    }
  }
  // MANUAL_BTC_ADDRESS is local-testing only (single reused address).
  // Refuse it on prod hosts to prevent accidental reuse draining privacy.
  if (process.env.MANUAL_BTC_ADDRESS) {
    const prodHosts = new Set(["s.inoculens.com", "tunnel.inoculens.com"]);
    if (prodHosts.has(systemShortHost())) {
      const err = new Error("MANUAL_BTC_ADDRESS is testing-only and refused in production. Set BTC_XPUB.");
      err.statusCode = 412;
      err.code = "failed-precondition";
      throw err;
    }
    return process.env.MANUAL_BTC_ADDRESS;
  }
  const err = new Error(
    "Bitcoin payments are not configured on this deployment (no BTC_XPUB). Contact support."
  );
  err.statusCode = 412;
  err.code = "failed-precondition";
  throw err;
}

export async function nextWalletIndex(s) {
  const meta = (await s.get("wallet/meta", { type: "json" })) || { nextIndex: 0 };
  const idx = Number(meta.nextIndex) || 0;
  await s.setJSON("wallet/meta", { nextIndex: idx + 1 });
  return idx;
}
