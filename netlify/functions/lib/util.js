/**
 * Shared helpers for the FRONTFACER Tunnel Netlify backend.
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
 */
import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";

export function store() {
  return getStore("tunnel");
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

export const SESSION_RE = /^[a-zA-Z0-9\-_!]{10}$/;
export const CODE_RE = /^[A-Za-z0-9_-]{3,64}$/;
export const HOST_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.[A-Za-z]{2,}$/;

export function validSessionId(v) {
  return typeof v === "string" && SESSION_RE.test(v);
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
    const u = new URL(String(v));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------- IDs / tokens ----------

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SID_ALPHABET = CODE_ALPHABET + "-_!";
const TOKEN_ALPHABET = CODE_ALPHABET + "-_";

function randFrom(alphabet, n) {
  const buf = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export const newCode = (n = 8) => randFrom(CODE_ALPHABET, n);
export const newSessionId = () => randFrom(SID_ALPHABET, 10);
export const newToken = (n = 24) => randFrom(TOKEN_ALPHABET, n);
export const newClickId = () => `${Date.now().toString(36)}-${randFrom(CODE_ALPHABET, 8)}`;

// ---------- Platform detection (mirrors frontend deep-link badges) ----------

const PLATFORM_PATTERNS = [
  ["youtube", /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\//i],
  ["instagram", /^(https?:\/\/)?(www\.)?instagram\.com\//i],
  ["facebook", /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.?com)\//i],
  ["twitter", /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\//i],
  ["tiktok", /^(https?:\/\/)?(www\.)?tiktok\.com\//i],
  ["linkedin", /^(https?:\/\/)?(www\.)?linkedin\.com\//i],
];

export function detectPlatform(url) {
  for (const [key, re] of PLATFORM_PATTERNS) {
    if (re.test(String(url))) return key;
  }
  return null;
}

// ---------- Client IP (truncated for privacy) ----------

export function clientIp(event) {
  const h = event.headers || {};
  const raw =
    (h["x-forwarded-for"] || "").split(",")[0].trim() ||
    h["client-ip"] ||
    "unknown";
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
  // Where customer domains must point their CNAME. Override per deploy.
  return process.env.ROUTING_TARGET || "s.frontfacer.com";
}

export function sslDelegationTarget() {
  // If set, _acme-challenge.<domain> must CNAME here for SSL to verify.
  // If unset and AUTO_SSL != "0", routing validity implies host-managed SSL
  // (true for Netlify/Cloudflare SaaS once DNS points at them).
  return process.env.SSL_DELEGATION_TARGET || null;
}

export async function verifyDns(domain, token) {
  const target = routingTarget().toLowerCase().replace(/\.$/, "");
  const checks = { cname: false, txt: false, ssl: false };

  try {
    const cname = await doh(domain, "CNAME");
    checks.cname = cname.some(
      (v) => v.toLowerCase().replace(/\.$/, "") === target
    );
  } catch {
    checks.cname = false;
  }

  try {
    const txt = await doh(`verification.${domain}`, "TXT");
    checks.txt = txt.some((v) => v.replace(/^"|"$/g, "") === token);
  } catch {
    checks.txt = false;
  }

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

// ---------- Bitcoin pricing ----------

export async function btcUsdPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    const price = Number(data?.bitcoin?.usd);
    if (Number.isFinite(price) && price > 0) return price;
    throw new Error("bad price");
  } catch (e) {
    const fb = Number(process.env.BTC_USD_FALLBACK);
    if (Number.isFinite(fb) && fb > 0) return fb;
    throw new Error("Bitcoin price unavailable, try again later.");
  }
}

export function quoteFor(discountPct, price) {
  const usd = Number(process.env.DOMAIN_PRICE_USD || 10);
  const pct = Math.min(Math.max(Number(discountPct) || 0, 0), 100);
  const due = usd * (1 - pct / 100);
  const amount = (due / price).toFixed(8);
  const ttlDays = Number(process.env.QUOTE_TTL_DAYS || 7);
  return {
    amount,
    originalAmount: pct > 0 ? (usd / price).toFixed(8) : undefined,
    discountPercent: pct > 0 ? pct : undefined,
    expiresAt: new Date(Date.now() + ttlDays * 86400000).toISOString(),
  };
}

export function discountCodes() {
  try {
    const raw = process.env.DISCOUNT_CODES || "{}";
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (typeof k === "string" && Number.isFinite(n) && n > 0 && n <= 100) {
        out[k.trim().toUpperCase()] = n;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ---------- Wallet adapter ----------
// Real payment addresses need an HD wallet XPUB plus derivation libraries:
//   npm i bitcoinjs-lib bip32 tiny-secp256k1
// and env BTC_XPUB=xpub…  (first receiving chain, index per quote).
// Without it, generatePaymentAddress fails with a clear "not configured"
// error instead of inventing an address. MANUAL_BTC_ADDRESS exists only
// for local testing (single reused address — NEVER production).

export async function deriveAddress(index) {
  if (process.env.BTC_XPUB) {
    try {
      const { payments } = await import("bitcoinjs-lib");
      const { BIP32Factory } = await import("bip32");
      const ecc = (await import("tiny-secp256k1")).default;
      const node = BIP32Factory(ecc).fromBase58(process.env.BTC_XPUB).derive(0).derive(index);
      const { address } = payments.p2wpkh({ pubkey: node.publicKey });
      if (address) return address;
    } catch (e) {
      console.error("xpub derivation failed:", e?.message || e);
    }
  }
  if (process.env.MANUAL_BTC_ADDRESS) return process.env.MANUAL_BTC_ADDRESS;
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
