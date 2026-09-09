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
  if (siteID && token) {
    try {
      return getStore({ name: "tunnel", siteID, token });
    } catch (e) {
      console.error("getStore(siteID+token) failed, falling back:", e?.message || e);
    }
  }
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
  // SaaS CNAME target customers must point at (proxied, Cloudflare for SaaS).
  // INOCULENS account (inoculens.com): customers.inoculens.com -> proxy-fallback
  // -> Worker tunnel-custom-host -> Netlify resolver. Override per deploy.
  return (process.env.ROUTING_TARGET || "customers.inoculens.com").toLowerCase();
}

export function systemShortHost() {
  // System short-link host (DNS-only to Netlify, direct, no SaaS).
  return (process.env.SITE_URL || "s.inoculens.com").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function saasZoneApex() {
  // Apex of the Cloudflare SaaS zone (INOCULENS account: inoculens.com).
  // Kept as configuration; routing treats every custom domain identically
  // regardless of zone membership.
  return (process.env.SAAS_ZONE_APEX || "inoculens.com").toLowerCase();
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
  const legacyTargets = new Set([
    target,
    "s.inoculens.com",
    systemShortHost(),
    (process.env.ROUTING_TARGET_LEGACY || "").toLowerCase(),
  ].filter(Boolean));
  const checks = { cname: false, txt: false, ssl: false, cfHostnameStatus: null, cfSslStatus: null };

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
        checks.cname = legacyTargets.has(String(cnameRec.content || "").toLowerCase().replace(/\.$/, ""));
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
      checks.cname = cname.some((v) => legacyTargets.has(v.toLowerCase().replace(/\.$/, "")));
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
