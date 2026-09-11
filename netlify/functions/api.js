/**
 * INOCULENS Tunnel API — single Netlify Function routing all backend actions.
 *
 * POST /.netlify/functions/api  { action: "<name>", ...params }
 * Success: 200 + JSON payload. Failure: { error: { code, message } }.
 */
import {
  store,
  ok,
  fail,
  validSessionId,
  validAdminKey,
  validSlug,
  cleanDomain,
  validHttpUrl,
  newCode,
  newToken,
  detectPlatform,
  clientIp,
  trustedRawIp,
  checkRate,
  verifyDns,
  routingTarget,
  systemShortHost,
  dcvDelegationTargetFor,
  dcvDelegationSuffix,
  isApexDomain,
  apexBlockedMessage,
  sslDelegationTarget,
  cfConfig,
  cfGetCustomHostname,
  cfEnsureCustomHostname,
  cfDeleteCustomHostname,
  btcUsdPrice,
  quoteFor,
  satsFromBtc,
  satsToBtc,
  isRenewalQuote,
  checkUrlSafety,
  countDayKey,
  bumpDayCount,
  writeCountShard,
  sumShardsFromKeys,
  shouldStoreClickDetail,
  sessionLinkCount,
  bumpSessionLinkCount,
  deriveAddress,
  nextWalletIndex,
  turnstileSiteKey,
  verifyTurnstileToken,
  turnstileRequired,
  bumpKindCounter,
  originalHash,
  isBlockedOriginal,
  listAll,
  coverageValid,
  COVERAGE_YEAR_MS,
  linkKey,
  clicksPrefix,
  freshGet,
  getWithRetry,
  mapWithConcurrency,
} from "./lib/util.js";

// Ensure a Cloudflare SaaS custom hostname exists once the domain is
// verified + paid — identically for every custom domain. Only s./tunnel.
// are the app itself (reserved in addCustomDomain, can never be claimed).
// Best effort: DNS ownership remains the source of truth; SaaS failures are
// logged and surfaced via cf fields, never block payment.

// Turnstile gate (mint-family only, never resolve): lenient risk-based.
// Throws 412 turnstile-required when a widget must be solved.
async function requireTurnstile(s, p, event, kind) {
  if (!(await turnstileRequired(s, kind, clientIp(event), p.sessionId || null))) return;
  const v = await verifyTurnstileToken(p.turnstileToken, clientIp(event));
  if (!v.ok) {
    const e = new Error("TURNSTILE_REQUIRED");
    e.statusCode = 412;
    e.code = "failed-precondition";
    throw e;
  }
}

// Feedback email notify (SMTP, best-effort, fail-open): storage always wins.
// Env: SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
// FEEDBACK_FROM (default SMTP_USER, single mailbox),
// FEEDBACK_NOTIFY_TO (default SMTP_USER; one or several mailboxes separated
//   by commas or semicolons, e.g. "a@x.com, b@x.com"). Missing host/user/pass
// = skip silently (admin viewer remains source of truth).
// Single-mailbox check: blocks CR/LF header injection via misconfig
// and catches typos before nodemailer dials. Full RFC validation is the
// MTA's job; here we only guarantee "one address, no control chars".
function cleanMailbox(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 254) return null;
  if (/[\r\n<>]/.test(s)) return null;
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s)) return null;
  return s;
}

// Recipient list for FEEDBACK_NOTIFY_TO: split on commas/semicolons,
// validate each, dedupe, cap at 5 (typo-guard + bounds SMTP RCPT count).
// Returns null when nothing valid remains (caller skips mail, keeps store).
function cleanMailboxList(v, fallback) {
  const raw = String(v || "").trim() ? String(v) : String(fallback || "");
  const out = [];
  const seen = new Set();
  for (const part of raw.split(/[;,]/)) {
    const m = cleanMailbox(part);
    if (m && !seen.has(m.toLowerCase())) {
      seen.add(m.toLowerCase());
      out.push(m);
      if (out.length >= 5) break;
    }
  }
  return out.length ? out : null;
}

async function sendFeedbackEmail(doc, s) {
  const host = String(process.env.SMTP_HOST || "").trim() || null;
  const user = String(process.env.SMTP_USER || "").trim() || null;
  const pass = process.env.SMTP_PASS || null;
  if (!host || !user || !pass) return { ok: false, reason: "not-configured" };
  if (/[\r\n]/.test(host)) return { ok: false, reason: "bad-config" };
  // FEEDBACK_FROM stays single (envelope sender); TO accepts a short list.
  const toList = cleanMailboxList(process.env.FEEDBACK_NOTIFY_TO, user);
  const from = cleanMailbox(process.env.FEEDBACK_FROM || user);
  // Never bounce on operator misconfig: store already won, mail is notify-only.
  if (!toList || !from) {
    console.error("sendFeedbackEmail skipped: invalid FEEDBACK_NOTIFY_TO/FROM");
    return { ok: false, reason: "bad-config" };
  }
  const to = toList.join(", ");
  // Site-wide mail throttle (mailbomb guard): per-IP/session limits stop one
  // actor, but sessions are cheap to mint — without a global cap a rotating
  // attacker could still flood the inbox and burn SMTP quota / reputation.
  // Overflow reports are NOT lost: they persist to Blobs + admin viewer.
  try {
    if (s && !(await checkRate(s, "feedback-mail", "site", 5))) {
      console.error(`sendFeedbackEmail(${doc.id}) throttled: site mail budget spent`);
      return { ok: false, reason: "throttled" };
    }
  } catch { /* fail open: still attempt the send */ }
  const port = Number(process.env.SMTP_PORT || 587);
  try {
    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      secure: (Number.isFinite(port) && port > 0 ? port : 587) === 465,
      requireTLS: true,
      auth: { user, pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
    });
    const at = doc.createdAt || new Date().toISOString();
    const textLines = [
      `New Tunnel issue report ${doc.id}`,
      `Date: ${at}`,
      `Session: ${doc.sessionId}`,
      `IP hash: ${doc.ipHash || "-"}`,
      `UA: ${doc.ua || "-"}`,
      ``,
      String(doc.message || ""),
    ];
    await transporter.sendMail({
      from: `Tunnel Feedback <${from}>`,
      to,
      subject: `[Tunnel Feedback] ${doc.id}`,
      text: textLines.join("\n"),
    });
    try { transporter.close(); } catch { /* ignore */ }
    return { ok: true };
  } catch (e) {
    console.error(`sendFeedbackEmail(${doc.id}) failed:`, e?.message || e);
    return { ok: false, reason: e?.message || "send-failed" };
  }
}
async function ensureSaaSHostname(doc) {
  if (!cfConfig()) return null;
  if (!(doc.dnsVerification?.cnameValid && doc.dnsVerification?.txtVerified)) return null;
  if (doc.paymentStatus !== "paid") return null;
  try {
    const cf = await cfEnsureCustomHostname(doc.domain);
    if (cf) {
      doc.cfHostnameId = cf.id || doc.cfHostnameId || null;
      doc.cfHostnameStatus = cf.status || null;
      doc.cfSslStatus = cf.ssl?.status || null;
    }
    return cf;
  } catch (e) {
    console.error(`ensureSaaSHostname(${doc.domain}) failed:`, e?.message || e);
    return null;
  }
}

// ---------- small data-access helpers ----------
// Blobs edge reads lag writes by a few seconds in practice: a session or
// link created moments ago can still read back as missing on the next call
// from the SAME browser. All direct-key reads below go through freshGet
// (fast eventual read first, one strong re-read only on a miss — happy path
// costs exactly one fast read). need* variants additionally retry briefly
// before reporting "not found", so transient lag never surfaces as
// "Unknown or missing session" while genuinely unknown keys still 404
// quickly (sub-second budget; the frontend's own retry covers longer lags).
// Existence probes (checkSessionExists/validateSession) stay single-shot —
// retrying a genuinely-new ID would only add latency to every creation.

async function getSession(s, sid) {
  if (!validSessionId(sid)) return null;
  return freshGet(s, `sessions/${sid}`, { type: "json" });
}

async function needSession(s, sid) {
  if (!validSessionId(sid)) {
    const e = new Error("Unknown or missing session. Load a valid Session ID.");
    e.statusCode = 404;
    e.code = "not-found";
    throw e;
  }
  const sess = await getWithRetry(s, `sessions/${sid}`, { type: "json" }, { attempts: 3, delayMs: 350 });
  if (!sess) {
    const e = new Error("Unknown or missing session. Load a valid Session ID.");
    e.statusCode = 404;
    e.code = "not-found";
    throw e;
  }
  return sess;
}

async function getLink(s, host, code) {
  if (typeof code !== "string" || !code) return null;
  return freshGet(s, linkKey(host, code), { type: "json" });
}

async function needLink(s, host, code) {
  if (typeof code !== "string" || !code) {
    const e = new Error("Link not found. It may have been deleted.");
    e.statusCode = 404;
    e.code = "not-found";
    throw e;
  }
  const link = await getWithRetry(s, linkKey(host, code), { type: "json" }, { attempts: 3, delayMs: 350 });
  if (!link) {
    const e = new Error("Link not found. It may have been deleted.");
    e.statusCode = 404;
    e.code = "not-found";
    throw e;
  }
  return link;
}

// Every link mutation/read takes the root domain alongside the slug:
// slugs repeat across domains, so (host, code) is the identity.
function needLinkHost(p) {
  const d = cleanDomain(p.domain);
  if (!d) {
    const e = new Error("Missing domain for this link.");
    e.statusCode = 400;
    e.code = "invalid-argument";
    throw e;
  }
  return d;
}

function needToken(link, token) {
  if (!token || link.deleteToken !== token) {
    const e = new Error("Invalid delete token for this link.");
    e.statusCode = 403;
    e.code = "permission-denied";
    throw e;
  }
}

async function getDomain(s, domain) {
  const d = cleanDomain(domain);
  if (!d) return null;
  return freshGet(s, `domain/${d}`, { type: "json" });
}

async function needOwnedDomain(s, domain, sessionId) {
  const d = cleanDomain(domain);
  if (!d) {
    const e = new Error("Invalid domain name.");
    e.statusCode = 400;
    e.code = "invalid-argument";
    throw e;
  }
  const doc = await getWithRetry(s, `domain/${d}`, { type: "json" }, { attempts: 3, delayMs: 350 });
  if (!doc) {
    const e = new Error("Domain not found in your account.");
    e.statusCode = 404;
    e.code = "not-found";
    throw e;
  }
  if (doc.sessionId !== sessionId) {
    const e = new Error("This domain belongs to a different session.");
    e.statusCode = 403;
    e.code = "permission-denied";
    throw e;
  }
  return doc;
}

// Coverage bookkeeping, run on every read path (mutates the doc, caller
// saves when it returns true):
//  - drops discounts whose code already expired (so renewal quotes price
//    full again instead of honoring a dead deal),
//  - demotes lapsed domains back to pending (minting + serving stay gated
//    on coverage; published links hard-stop via resolve.js too).
// Lifetime coverage never lapses. Promo uses stay consumed (no infinite
// discounts via apply/remove loops).
function refreshCoverage(doc) {
  let changed = false;
  if (doc.discount?.expiresAt && new Date(doc.discount.expiresAt).getTime() <= Date.now()) {
    doc.discount = null;
    changed = true;
  }
  if (!coverageValid(doc) && doc.status === "active") {
    doc.status = "pending_verification";
    changed = true;
  }
  return changed;
}

async function domainInfo(doc, viewerSessionId = null) {
  const route = routingTarget();
  const pending = doc.pendingClaim || null;
  const pendingMine = !!(pending && viewerSessionId && pending.sessionId === viewerSessionId);
  const isOwner = !!(viewerSessionId && doc.sessionId === viewerSessionId);
  // Owner TXT tokens are redacted for non-owners (claimants get only their
  // pending token via the pendingClaim branch). TXT is public DNS anyway,
  // but no reason to hand it to anyone who knows the domain name.
  const ownerToken = isOwner ? doc.verificationToken : null;
  return {
    domain: doc.domain,
    id: doc.domain,
    status: doc.status,
    paymentStatus: doc.paymentStatus,
    isVerified: doc.isVerified,
    coverageExpiresAt: doc.coverageExpiresAt || null,
    coverageLifetime: doc.coverageLifetime === true,
    coverageValid: coverageValid(doc),
    dnsVerification: doc.dnsVerification,
    dnsVerificationToken: ownerToken,
    verificationToken: ownerToken,
    pendingClaim: pendingMine
      ? { byYou: true, at: pending.at || null }
      : pending
        ? { byYou: false, at: pending.at || null }
        : null,
    sslVerification: {
      cnameTarget: doc.sslTarget,
      status: doc.cfSslStatus || (doc.dnsVerification?.sslVerified ? "active" : "pending"),
      hostnameStatus: doc.cfHostnameStatus || null,
    },
    cloudflare: {
      configured: !!cfConfig(),
      hostnameId: doc.cfHostnameId || null,
      hostnameStatus: doc.cfHostnameStatus || null,
      sslStatus: doc.cfSslStatus || null,
    },
    instructions: {
      cnameTarget: route,
      recordName: doc.domain,
      isApex: await isApexDomain(doc.domain),
      txtHost: `verification.${doc.domain}`,
      txt: ownerToken,
      sslCnameTarget: doc.sslTarget,
      sslCnameName: `_acme-challenge.${doc.domain}`,
      dcvTarget: dcvDelegationTargetFor(doc.domain),
      routingTarget: route,
    },
  };
}

function linkShape(l) {
  return {
    original: l.original,
    short: l.short,
    code: l.code,
    domain: l.domain,
    deleteToken: l.deleteToken,
    timestamp: l.createdAt,
    sessionId: l.sessionId,
    clickCount: l.clickCount || 0,
    platform: l.platform || null,
    ...(l.label ? { label: l.label } : {}),
    ...(l.quarantined ? { quarantined: true, quarantineReason: l.quarantineReason || "UNSAFE" } : {}),
  };
}

async function listLinksOfSession(s, sid) {
  // Fetch in parallel batches: a sequential per-key await pays a full
  // round-trip per link (N x RTT), which dominates home-screen load time as
  // the store grows. Batches of ~12 keep it fast without bursting.
  const blobs = await listAll(s, "link/");
  const docs = await mapWithConcurrency(blobs, 12, (b) =>
    freshGet(s, b.key, { type: "json" }).catch(() => null)
  );
  const found = docs.filter((l) => l && l.sessionId === sid);
  found.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return found;
}

async function deleteClickKeys(s, host, code) {
  const blobs = await listAll(s, clicksPrefix(host, code));
  await mapWithConcurrency(blobs, 12, (b) => s.delete(b.key));
}

// ---------- managed promo codes (single-use, Blobs-backed) ----------
// Why Blobs and not a file or env var:
// - A file would ship with the open-source repo (public) or need a sidecar.
// - Netlify env values are masked and single-field — unmanageable.
// - Blobs lives next to the data, viewable/revocable from the in-app admin
//   panel, and never touches git. Only ADMIN_KEY (Netlify env) gates it.
//
// Storage: promo/<CODE> -> { code, percent, maxUses, uses: [{domain,
//   sessionId, at}], note, createdAt, expiresAt|null, disabled }
// Single-use = maxUses 1 (default). A consumed use is NEVER freed — not by
// removeDiscountCode, not by domain deletion — otherwise apply/remove loops
// would mint infinite discounts. Deleting a code revokes future use; domains
// that already applied keep theirs.

const PCODE_RE = /^[A-Z0-9][A-Z0-9\-_]{2,31}$/;

function cleanPromoCode(raw) {
  const c = String(raw || "").trim().toUpperCase();
  return PCODE_RE.test(c) ? c : null;
}

async function needAdmin(s, p, event) {
  const key = process.env.ADMIN_KEY;
  if (!key || typeof key !== "string" || key.length !== 10 || !key.includes("1")) {
    const e = new Error("Promo admin is misconfigured on this deployment (ADMIN_KEY must be 10 chars containing 1).");
    e.statusCode = 412;
    e.code = "failed-precondition";
    throw e;
  }
  const ip = clientIp(event);
  if (!(await checkRate(s, "admin", ip, 10))) {
    const e = new Error("Too many attempts, wait a moment.");
    e.statusCode = 429;
    e.code = "resource-exhausted";
    throw e;
  }
  if (!validAdminKey(p.adminKey) || p.adminKey !== key) {
    const e = new Error("Invalid admin key.");
    e.statusCode = 403;
    e.code = "permission-denied";
    throw e;
  }
  try {
    const s2 = store(event);
    await s2.setJSON(`admin-log/${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`, {
      at: new Date().toISOString(),
      action: "admin-auth",
      ip,
    }).catch(() => {});
  } catch { /* best effort */ }
}

function promoShape(p) {
  return {
    code: p.code,
    percent: p.percent,
    maxUses: p.maxUses,
    used: Array.isArray(p.uses) ? p.uses.length : 0,
    // Admin stats screen pages hundreds of redemptions: keep a generous
    // bounded window (newest last, frontend reverses). 1000 tiny records is
    // still a small payload and covers the "100s of uses" case.
    uses: (Array.isArray(p.uses) ? p.uses : []).slice(-1000),
    note: p.note || "",
    createdAt: p.createdAt,
    expiresAt: p.expiresAt || null,
    disabled: !!p.disabled,
  };
}

// True if any OTHER domain was ever shown this address (current or retired
// quote). Own domain excluded: re-showing our own history address is
// harmless, and we always take a fresh index anyway.
async function addressTakenByOtherDomain(s, ownDomain, address) {
  if (!address) return false;
  const blobs = await listAll(s, "domain/");
  const docs = await mapWithConcurrency(blobs, 12, (b) =>
    freshGet(s, b.key, { type: "json" }).catch(() => null)
  );
  for (const d of docs) {
    if (!d || d.domain === ownDomain) continue;
    if (d.quote && d.quote.address === address) return true;
    if (Array.isArray(d.quoteHistory) && d.quoteHistory.some((h) => h && h.address === address)) return true;
  }
  return false;
}

// ---------- actions ----------

const actions = {
  // ----- links -----

  async shortenUrl(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "shorten", ip, 12))) {
      const e = new Error("You've made too many attempts (429). Wait a moment and try again.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    await requireTurnstile(s, p, event, "shorten");
    const { originalUrl, customSlug, sessionId, domain } = p;
    const cleanUrl = typeof originalUrl === "string" ? originalUrl.trim() : "";
    const cleanSlug = customSlug == null ? null : String(customSlug).trim();
    if (!cleanUrl || cleanUrl.length > 2048 || !validHttpUrl(cleanUrl)) {
      const e = new Error(
        cleanUrl && cleanUrl.length > 2048
          ? "URL too long (max 2048 characters)."
          : "ERR_INVALID_URL"
      );
      e.statusCode = 400;
      e.code = "invalid-argument";
      throw e;
    }
    if (!validSessionId(sessionId)) {
      const e = new Error("Invalid session. Reload and try again.");
      e.statusCode = 400;
      e.code = "invalid-argument";
      throw e;
    }
    // Proactive safety at mint (silent for clean URLs).
    try {
      const verdict = await checkUrlSafety(s, cleanUrl);
      if (verdict && verdict.safe === false) {
        const e = new Error("ERR_UNSAFE_URL");
        e.statusCode = 400;
        e.code = "invalid-argument";
        throw e;
      }
    } catch (e) {
      if (e && e.message === "ERR_UNSAFE_URL") throw e;
      console.error("safety check failed open:", e?.message || e);
    }
    // Per-session quota (default 500). Count doc preferred, scan fallback.
    try {
      const quota = Number(process.env.LINK_QUOTA_SYSTEM || 500);
      const q = Number.isFinite(quota) && quota > 0 ? Math.min(quota, 5000) : 500;
      let count = await sessionLinkCount(s, sessionId);
      if (count === null) {
        const blobs = await listAll(s, "link/");
        const docs = await mapWithConcurrency(blobs, 12, (b) =>
          freshGet(s, b.key, { type: "json" }).catch(() => null)
        );
        count = docs.filter((l) => l && l.sessionId === sessionId).length;
        try { await s.setJSON(`sessions/${sessionId}/meta`, { linkCount: count }); } catch { /* ignore */ }
      }
      if (count >= q) {
        const e = new Error(`Link quota reached (${q}). Delete old links to create more.`);
        e.statusCode = 429;
        e.code = "resource-exhausted";
        throw e;
      }
    } catch (e) {
      if (e && e.code === "resource-exhausted") throw e;
      console.error("quota check failed open:", e?.message || e);
    }
    const host = cleanDomain(domain) || systemShortHost();

    let code;
    if (cleanSlug) {
      if (!validSlug(cleanSlug)) {
        const e = new Error("Custom slugs must be 1–30 chars: letters, numbers, - _");
        e.statusCode = 400;
        e.code = "invalid-argument";
        throw e;
      }
      // Scoped uniqueness: the same slug may live on other root domains.
      if (await getLink(s, host, cleanSlug)) {
        const e = new Error("ERR_SLUG_TAKEN");
        e.statusCode = 409;
        e.code = "already-exists";
        throw e;
      }
      code = cleanSlug;
    } else {
      code = null;
      for (let i = 0; i < 10 && !code; i++) {
        const c = newCode(8);
        if (!(await getLink(s, host, c))) code = c;
      }
      if (!code) {
        const e = new Error("Could not allocate a short code, try again.");
        e.statusCode = 503;
        e.code = "unavailable";
        throw e;
      }
    }

    // Custom domains must be active AND covered before they can mint links.
    // System host is always allowed; everything else must be an active
    // domain owned by this session (Cloudflare SaaS provisions TLS) whose
    // coverage (payment year / promo grant) has not lapsed.
    if (host !== systemShortHost()) {
      const doc = await freshGet(s, `domain/${host}`, { type: "json" });
      if (doc && refreshCoverage(doc)) await s.setJSON(`domain/${host}`, doc);
      const usable =
        doc && doc.sessionId === sessionId && doc.status === "active" && coverageValid(doc);
      if (!usable) {
        const lapsed = doc && doc.sessionId === sessionId && !coverageValid(doc);
        const e = new Error(lapsed
          ? "Domain coverage expired — renew the domain (new code or $10/year) to create new links."
          : "permission-denied");
        e.statusCode = 403;
        e.code = "permission-denied";
        throw e;
      }
    }

    // Implicit session creation (frontend persists it after success).
    if (!(await getSession(s, sessionId))) {
      await s.setJSON(`sessions/${sessionId}`, { createdAt: Date.now() });
    }

    const link = {
      code,
      original: cleanUrl,
      short: `https://${host}/${code}`,
      domain: host,
      sessionId,
      deleteToken: newToken(),
      label: "",
      clickCount: 0,
      platform: detectPlatform(cleanUrl),
      createdAt: Date.now(),
    };
    await s.setJSON(linkKey(host, code), link);
    await bumpSessionLinkCount(s, sessionId, 1);
    return ok({
      shortenedUrl: link.short,
      deleteToken: link.deleteToken,
      platform: link.platform,
    });
  },

  async checkSessionExists(s, p) {
    return ok({ exists: !!(await getSession(s, p.sessionId)) });
  },

  async createSession(s, p) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session ID.");
    if (!(await getSession(s, p.sessionId))) {
      await s.setJSON(`sessions/${p.sessionId}`, { createdAt: Date.now() });
    }
    return ok({});
  },

  async validateSession(s, p) {
    return ok({ exists: !!(await getSession(s, p.sessionId)) });
  },

  // ----- issue reports (no login; session linked silently) -----
  // Storage: feedback/<date>-<ts36>-<rand8> -> { id, sessionId, message,
  // createdAt, ipHash, ua }. Rate-limited per IP + per session, with a
  // risk-based Turnstile challenge on fast loops (same pattern as mint).
  async submitFeedback(s, p, event) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    const ip = clientIp(event);
    await requireTurnstile(s, p, event, "feedback");
    if (!(await checkRate(s, "feedback-ip", ip, 5))) {
      const e = new Error("You've sent too many reports. Wait a moment and try again.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    if (!(await checkRate(s, "feedback-sess", p.sessionId, 3))) {
      const e = new Error("You've sent too many reports from this session. Wait a moment and try again.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    const message = String(p.message || "").trim();
    if (message.length < 10) return fail(400, "invalid-argument", "Please describe the issue in a bit more detail (at least 10 characters).");
    if (message.length > 5000) return fail(400, "invalid-argument", "Please keep it under 5000 characters.");
    await needSession(s, p.sessionId);
    let ipHash = null;
    try {
      const { createHash } = await import("node:crypto");
      ipHash = createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);
    } catch { /* ignore */ }
    let ua = null;
    try {
      const h = event.headers || {};
      const lowered = {};
      for (const [k, v] of Object.entries(h)) lowered[String(k).toLowerCase()] = v;
      ua = String(lowered["user-agent"] || "").slice(0, 140) || null;
    } catch { /* ignore */ }
    const now = Date.now();
    const id = `${new Date(now).toISOString().slice(0, 10)}-${now.toString(36)}-${newCode(8)}`;
    const doc = {
      id,
      sessionId: p.sessionId,
      message,
      createdAt: new Date(now).toISOString(),
      ipHash,
      ua,
    };
    await s.setJSON(`feedback/${id}`, doc);
    // Best-effort notify: never fail the submit if mail is down/misconfigured.
    try { await sendFeedbackEmail(doc, s); } catch (e) {
      console.error(`submitFeedback notify failed (${id}):`, e?.message || e);
    }
    return ok({ id });
  },

  async adminListFeedback(s, p, event) {
    await needAdmin(s, p, event);
    const blobs = await listAll(s, "feedback/");
    const docs = await mapWithConcurrency(blobs, 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const out = docs
      .filter((d) => d && d.id && typeof d.message === "string")
      .map((d) => ({
        id: String(d.id),
        sessionId: String(d.sessionId || ""),
        message: String(d.message || "").slice(0, 5000),
        createdAt: d.createdAt || null,
        ipHash: d.ipHash || null,
        ua: d.ua || null,
      }));
    out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return ok({ reports: out.slice(0, 500) });
  },

  async adminDeleteFeedback(s, p, event) {
    await needAdmin(s, p, event);
    const id = String(p.id || "").trim();
    // Allowlist: generated ids are YYYY-MM-DD + base36 ts + code alphabet.
    // Blocks key traversal (/, \, ..) and any non-id payload outright.
    if (!id || id.length > 80 || !/^[A-Za-z0-9._-]+$/.test(id)) {
      return fail(400, "invalid-argument", "Invalid report id.");
    }
    await s.delete(`feedback/${id}`);
    return ok({ deleted: id });
  },

  async getLinksBySession(s, p) {
    await needSession(s, p.sessionId);
    const links = await listLinksOfSession(s, p.sessionId);
    return ok({ links: links.map(linkShape) });
  },

  async deleteUrl(s, p) {
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    needToken(link, p.deleteToken);
    await s.delete(linkKey(host, link.code));
    // Delete by alternate legacy key too (domain field mismatch).
    try {
      const alt = new URL(link.short).hostname.toLowerCase();
      if (alt && alt !== host.toLowerCase()) await s.delete(linkKey(alt, link.code));
    } catch { /* ignore */ }
    await deleteClickKeys(s, host, link.code);
    await bumpSessionLinkCount(s, link.sessionId, -1);
    return ok({});
  },

  async updateLinkLabel(s, p) {
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    needToken(link, p.deleteToken);
    link.label = String(p.label || "").slice(0, 60);
    await s.setJSON(linkKey(host, link.code), link);
    return ok({});
  },

  // ----- stats -----

  async getClickStats(s, p) {
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    needToken(link, p.deleteToken);
    const limitRaw = Number(p.limit || 200);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
    const offsetRaw = Number(p.offset || 0);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const blobs = await listAll(s, clicksPrefix(host, link.code));
    // Sort by key (click IDs start with timestamp36) to avoid fetching all
    // bodies just to order. Fetch only the requested window.
    const sorted = [...blobs].sort((a, b) => String(b.key || "").localeCompare(String(a.key || "")));
    const detailTotal = sorted.length;
    const window = sorted.slice(offset, offset + limit);
    const docs = await mapWithConcurrency(window, 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const clicks = docs.filter(Boolean);
    clicks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    // Exact total: legacy baseline + write-only shard delta (key-counted, no
    // body reads, lossless under concurrency). Badge clickCount stays approx.
    let clickCount = link.clickCount || 0;
    let daily = [];
    try {
      const countBlobs = await listAll(s, `counts/${(host || "").toLowerCase()}/${link.code}/`);
      const { delta, byDay } = sumShardsFromKeys(countBlobs);
      const base = link.baseCount !== undefined ? Number(link.baseCount) || 0 : (link.clickCount || 0);
      const hasShards = countBlobs.some((b) => String(b.key || "").split("/").length === 5);
      clickCount = hasShards ? base + delta : (link.clickCount || 0);
      // Daily graph: minute-shard grouping first; legacy day-aggs fill days
      // with no shards (history only, never double-counted).
      const days = new Map(byDay);
      const legacyDays = countBlobs.filter((b) => String(b.key || "").split("/").length === 4).slice(-90);
      if (legacyDays.length) {
        const legacyDocs = await mapWithConcurrency(legacyDays, 6, (b) =>
          freshGet(s, b.key, { type: "json" }).catch(() => null)
        );
        legacyDays.forEach((b, i) => {
          const day = String(b.key || "").split("/").pop();
          if (day && !days.has(day)) days.set(day, Number(legacyDocs[i]?.count) || 0);
        });
      }
      daily = [...days.entries()].map(([day, count]) => ({ day, count }))
        .sort((a, b) => String(a.day).localeCompare(String(b.day))).slice(-90);
      // Opportunistic rollup: if minute shards pile up, fold the oldest day
      // into its day-agg and delete those shards (bounded 200/call).
      const minuteKeys = countBlobs.filter((b) => String(b.key || "").split("/").length === 5);
      if (minuteKeys.length > 1000) {
        try {
          const oldest = [...byDay.keys()].sort()[0];
          const dayKeys = minuteKeys.filter((b) => String(b.key || "").split("/")[3] === oldest).slice(0, 200);
          let dayDelta = 0;
          for (const b of dayKeys) dayDelta += String(b.key || "").includes("-adj-") ? -1 : 1;
          const aggKey = `counts/${(host || "").toLowerCase()}/${link.code}/${oldest}`;
          const agg = (await s.get(aggKey, { type: "json" }).catch(() => null)) || { count: 0, rolled: true };
          // Only fold if this day has no unlisted remainder risk: fold exactly
          // the deleted keys' delta (remainder stays as shards).
          agg.count = (Number(agg.count) || 0) + dayDelta;
          await s.setJSON(aggKey, agg);
          await mapWithConcurrency(dayKeys, 12, (b) => s.delete(b.key).catch(() => null));
        } catch (e) {
          console.error("shard rollup failed:", e?.message || e);
        }
      }
    } catch { /* badge fallback above */ }
    return ok({ clickCount, total: detailTotal, clicks, daily, hasMore: offset + limit < detailTotal, quarantined: link.quarantined === true });
  },

  async deleteAllClicks(s, p) {
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    needToken(link, p.deleteToken);
    await deleteClickKeys(s, host, link.code);
    try {
      const counts = await listAll(s, `counts/${(host || "").toLowerCase()}/${link.code}/`);
      await mapWithConcurrency(counts.slice(0, 500), 12, (b) => s.delete(b.key).catch(() => null));
    } catch { /* best effort */ }
    link.clickCount = 0;
    link.baseCount = 0;
    await s.setJSON(linkKey(host, link.code), link);
    return ok({});
  },

  async deleteClickEntry(s, p) {
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    needToken(link, p.deleteToken);
    if (!p.clickId || typeof p.clickId !== "string") {
      return fail(400, "invalid-argument", "Missing click ID.");
    }
    const key = `${clicksPrefix(host, link.code)}${p.clickId}`;
    const existing = await freshGet(s, key, { type: "json" }).catch(() => null);
    if (!existing) return ok({ deleted: false });
    await s.delete(key);
    // Compensating shard keeps exact totals (no counter races).
    try { await writeCountShard(s, host, link.code, -1); } catch { /* ignore */ }
    link.clickCount = Math.max(0, (link.clickCount || 1) - 1);
    await s.setJSON(linkKey(host, link.code), link);
    return ok({ deleted: true });
  },

  async mergeSessions(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "merge", ip, 10))) {
      const e = new Error("Too many merge attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    const { oldSessionId, newSessionId } = p;
    if (!validSessionId(oldSessionId) || !validSessionId(newSessionId) || oldSessionId === newSessionId) {
      return fail(400, "invalid-argument", "Invalid session pair.");
    }
    await Promise.all([needSession(s, oldSessionId), needSession(s, newSessionId)]);
    const links = await listLinksOfSession(s, oldSessionId);
    await mapWithConcurrency(links, 12, (l) => {
      l.sessionId = newSessionId;
      // Keys are (host, code): derive the host from the stored doc, falling
      // back to the link URL itself so the key can never go missing.
      let lh = l.domain;
      if (!lh) {
        try { lh = new URL(l.short).hostname; } catch { lh = ""; }
        l.domain = lh;
      }
      return s.setJSON(linkKey(lh, l.code), l);
    });
    // Custom domains belong to the session too: move them along so a merge
    // transfers everything (links + domains). Hostnames are unique docs, so
    // no conflicts are possible. Past promo redemptions stay recorded.
    const domainBlobs = await listAll(s, "domain/");
    const domainDocs = await mapWithConcurrency(domainBlobs, 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const toMove = domainDocs.filter((d) => d && d.sessionId === oldSessionId);
    await mapWithConcurrency(toMove, 12, (d) => {
      d.sessionId = newSessionId;
      // A merge moves the whole account: clear any pending claim the source
      // filed elsewhere (it was theirs, now it moves with them).
      return s.setJSON(`domain/${d.domain}`, d);
    });
    try {
      await bumpSessionLinkCount(s, newSessionId, links.length);
      await bumpSessionLinkCount(s, oldSessionId, -links.length);
    } catch { /* best effort */ }
    return ok({ success: true, count: links.length, domains: toMove.length });
  },

  // ----- custom domains -----

  async getUserDomains(s, p) {
    await needSession(s, p.sessionId);
    const blobs = await listAll(s, "domain/");
    const docs = await mapWithConcurrency(blobs, 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const mine = docs.filter((d) => d && d.sessionId === p.sessionId);
    // Keep the list truthful: lapsed coverage demotes here too, so the
    // dropdown never offers a dead domain as active.
    const out = await mapWithConcurrency(mine, 6, async (d) => {
      if (refreshCoverage(d)) await s.setJSON(`domain/${d.domain}`, d);
      return domainInfo(d, p.sessionId);
    });
    return ok({ domains: out });
  },

  async getPublicConfig() {
    // No auth: safe public values the UI needs to render correct DNS instructions.
    return ok({
      routingTarget: routingTarget(),
      systemHost: systemShortHost(),
      dcvSuffix: dcvDelegationSuffix(),
      cloudflareConfigured: !!cfConfig(),
      autoSsl: process.env.AUTO_SSL !== "0",
      turnstileSiteKey: turnstileSiteKey(),
    });
  },

  async addCustomDomain(s, p, event) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    try { await bumpKindCounter(s, "domain-add", clientIp(event)); } catch { /* ignore */ }
    await requireTurnstile(s, p, event, "domain");
    const host = cleanDomain(p.domain);
    if (!host) return fail(400, "invalid-argument", "Invalid domain name.");
    // Never allow hijacking the system hosts or the SaaS infrastructure hosts.
    const reserved = new Set([systemShortHost(), routingTarget(), "tunnel.inoculens.com", "customers.inoculens.com", "proxy-fallback.inoculens.com", "inoculens.com"]);
    if (reserved.has(host)) return fail(400, "invalid-argument", "This domain is reserved for INOCULENS infrastructure.");
    // Authoritative apex block (frontend also warns live, but the backend
    // decides — never let users pay for a domain that cannot work).
    if (await isApexDomain(host)) return fail(400, "invalid-argument", apexBlockedMessage(host));
    if (!(await getSession(s, p.sessionId))) {
      await s.setJSON(`sessions/${p.sessionId}`, { createdAt: Date.now() });
    }
    const existing = await freshGet(s, `domain/${host}`, { type: "json" });
    if (existing) {
      if (existing.sessionId !== p.sessionId) {
        // Secure reclaim: ownership NEVER transfers here. A pending claim is
        // recorded (last claim wins) with its own TXT token. Old owner keeps
        // full rights (mint/delete/manage) until claimant proves DNS via
        // verifyClaimedDomainDns. Claimant gets zero destructive rights until
        // then — no delete, no mint, no payment. Links move only on verified
        // transfer (with stats, since clicks/ are host/code keyed).
        existing.pendingClaim = {
          sessionId: p.sessionId,
          token: newToken(32),
          at: new Date().toISOString(),
        };
        await s.setJSON(`domain/${host}`, existing);
        const route = routingTarget();
        return ok({
          ...(await domainInfo(existing, p.sessionId)),
          pendingClaim: true,
          pendingToken: existing.pendingClaim.token,
          instructions: {
            cnameTarget: route,
            recordName: host,
            txtHost: `verification.${host}`,
            txt: existing.pendingClaim.token,
            routingTarget: route,
          },
        });
      }
      return ok(await domainInfo(existing, p.sessionId)); // idempotent re-entry
    }
    const delegation = sslDelegationTarget();
    const doc = {
      domain: host,
      sessionId: p.sessionId,
      status: "pending_verification",
      paymentStatus: "unpaid",
      isVerified: false,
      verificationToken: newToken(32),
      sslTarget: delegation || `automatic via Cloudflare (${routingTarget()})`,
      dnsVerification: { cnameValid: false, txtVerified: false, sslVerified: false },
      cfHostnameId: null,
      cfHostnameStatus: null,
      cfSslStatus: null,
      discount: null,
      quote: null,
      createdAt: Date.now(),
    };
    await s.setJSON(`domain/${host}`, doc);
    return ok(await domainInfo(doc, p.sessionId));
  },

  async getDomainVerificationInfo(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    if (refreshCoverage(doc)) await s.setJSON(`domain/${doc.domain}`, doc);
    // Refresh Cloudflare SaaS status when configured (best effort, never throws).
    if (cfConfig()) {
      const cf = await cfGetCustomHostname(doc.domain);
      if (cf) {
        doc.cfHostnameId = cf.id || doc.cfHostnameId || null;
        doc.cfHostnameStatus = cf.status || null;
        doc.cfSslStatus = cf.ssl?.status || null;
        await s.setJSON(`domain/${doc.domain}`, doc);
      }
    }
    return ok({ ...(await domainInfo(doc, p.sessionId)), paymentStatus: doc.paymentStatus });
  },

  // Pending-claim status for the claimant (not owner): returns pending TXT
  // instructions without leaking payment/quote state.
  async getClaimVerificationInfo(s, p) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    const host = cleanDomain(p.domain);
    if (!host) return fail(400, "invalid-argument", "Invalid domain name.");
    const doc = await freshGet(s, `domain/${host}`, { type: "json" });
    if (!doc || !doc.pendingClaim || doc.pendingClaim.sessionId !== p.sessionId) {
      return fail(404, "not-found", "No pending claim for this session.");
    }
    const route = routingTarget();
    return ok({
      domain: doc.domain,
      pendingClaim: true,
      at: doc.pendingClaim.at || null,
      instructions: {
        cnameTarget: route,
        recordName: doc.domain,
        txtHost: `verification.${doc.domain}`,
        txt: doc.pendingClaim.token,
        routingTarget: route,
      },
    });
  },

  // Verified transfer: claimant proves DNS for PENDING token, then ownership
  // + all links (with stats, clicks/ are host/code keyed) move as if created
  // in the new session. s.* links never move (not a session merge).
  async verifyClaimedDomainDns(s, p, event) {
    try { await bumpKindCounter(s, "claim", clientIp(event)); } catch { /* ignore */ }
    await requireTurnstile(s, p, event, "claim");
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    const host = cleanDomain(p.domain);
    if (!host) return fail(400, "invalid-argument", "Invalid domain name.");
    const doc = await getWithRetry(s, `domain/${host}`, { type: "json" }, { attempts: 3, delayMs: 350 });
    if (!doc || !doc.pendingClaim || doc.pendingClaim.sessionId !== p.sessionId) {
      return fail(404, "not-found", "No pending claim for this session.");
    }
    if (!(await getSession(s, p.sessionId))) {
      await s.setJSON(`sessions/${p.sessionId}`, { createdAt: Date.now() });
    }
    const live = await verifyDns(doc.domain, doc.pendingClaim.token).catch(() => ({
      cname: false, txt: false, ssl: false, routable: null,
    }));
    if (!(live.cname && live.txt)) {
      return ok({
        success: false,
        isVerified: false,
        checks: { cname: !!live.cname, txt: !!live.txt, routable: live.routable ?? null },
        status: doc.status,
      });
    }
    // Transfer ownership.
    const fromSid = doc.sessionId;
    doc.sessionId = p.sessionId;
    doc.verificationToken = doc.pendingClaim.token;
    doc.pendingClaim = null;
    doc.isVerified = true;
    doc.dnsVerification = {
      cnameValid: true,
      txtVerified: true,
      sslVerified: !!live.ssl,
      routable: live.routable ?? null,
    };
    refreshCoverage(doc);
    if (doc.isVerified && doc.paymentStatus === "paid" && coverageValid(doc)) {
      doc.status = "active";
      await ensureSaaSHostname(doc);
    } else if (doc.status === "active" && !coverageValid(doc)) {
      doc.status = "pending_verification";
    } else if (doc.isVerified && doc.paymentStatus === "paid" && coverageValid(doc)) {
      doc.status = "active";
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    // Move links (history + stats follow: clicks/ keyed by host/code).
    try {
      const blobs = await listAll(s, "link/");
      const docs = await mapWithConcurrency(blobs, 12, (b) =>
        freshGet(s, b.key, { type: "json" }).catch(() => null)
      );
      const mine = docs.filter((l) => {
        if (!l) return false;
        const h = (l.domain || "").toLowerCase();
        if (h === doc.domain) return true;
        try { return new URL(l.short).hostname.toLowerCase() === doc.domain; } catch { return false; }
      });
      await mapWithConcurrency(mine, 12, (l) => {
        l.sessionId = p.sessionId;
        if (!l.domain) {
          try { l.domain = new URL(l.short).hostname.toLowerCase(); } catch { /* keep */ }
        }
        return s.setJSON(linkKey(l.domain || doc.domain, l.code), l);
      });
      await bumpSessionLinkCount(s, p.sessionId, mine.length);
      if (fromSid) await bumpSessionLinkCount(s, fromSid, -mine.length);
    } catch (e) {
      console.error(`claim link move failed for ${doc.domain}:`, e?.message || e);
    }
    return ok({
      success: true,
      isVerified: true,
      status: doc.status,
      paymentStatus: doc.paymentStatus,
      coverageExpiresAt: doc.coverageExpiresAt || null,
      coverageLifetime: doc.coverageLifetime === true,
      coverageValid: coverageValid(doc),
    });
  },

  async verifyCustomDomainDns(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    const live = await verifyDns(doc.domain, doc.verificationToken).catch(() => ({
      cname: false,
      txt: false,
      ssl: false,
      routable: null,
      cfHostnameStatus: null,
      cfSslStatus: null,
    }));
    // routable: true = resolves to edge, false = definitively unservable as
    // configured, null = unknown (fail-open, never blocks on lookup hiccups).
    const routable = live.routable === false ? false : live.routable === true ? true : null;
    doc.dnsVerification = {
      cnameValid: !!live.cname,
      txtVerified: !!live.txt,
      sslVerified: !!live.ssl,
      routable,
    };
    if (live.cfHostnameStatus) doc.cfHostnameStatus = live.cfHostnameStatus;
    if (live.cfSslStatus) doc.cfSslStatus = live.cfSslStatus;
    // Sticky ownership: once proven, stays proven (matches frontend).
    if (live.cname && live.txt) doc.isVerified = true;
    // Coverage can lapse independently of DNS: drop dead discounts and
    // demote before deciding activation below.
    refreshCoverage(doc);
    // A definitively unroutable domain cannot serve links: drop it back to
    // pending (payment kept) so no new links mint on a dead domain.
    // Re-verify re-activates once it resolves. Unknown (null) never demotes.
    if (routable === false && doc.status === "active") doc.status = "pending_verification";
    // If verified + paid + resolvable, ensure the SaaS custom hostname exists
    // so TLS provisions.
    if (doc.isVerified && doc.paymentStatus === "paid" && routable !== false) {
      await ensureSaaSHostname(doc);
      // Re-read live SaaS status after ensure (it may have just been created -> pending).
      const cf = cfConfig() ? await cfGetCustomHostname(doc.domain) : null;
      if (cf) {
        doc.cfHostnameId = cf.id || doc.cfHostnameId || null;
        doc.cfHostnameStatus = cf.status || null;
        doc.cfSslStatus = cf.ssl?.status || null;
        doc.dnsVerification.sslVerified = cf.ssl?.status === "active" ? true : doc.dnsVerification.sslVerified;
      }
      // Active requires ownership + payment + live coverage. TLS (cfSslStatus active) is reported
      // separately so the UI can show "Propagating" without blocking link creation
      // once DNS + payment are done. Links serve as soon as CNAME resolves (HTTP
      // validation completes in minutes); strict TLS gating would strand paid users.
      if (coverageValid(doc)) doc.status = "active";
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    return ok({
      success: true,
      isVerified: doc.isVerified,
      checks: { cname: !!live.cname, txt: !!live.txt, ssl: !!doc.dnsVerification.sslVerified, routable },
      cfHostnameStatus: doc.cfHostnameStatus || live.cfHostnameStatus || null,
      cfSslStatus: doc.cfSslStatus || live.cfSslStatus || null,
      status: doc.status,
      paymentStatus: doc.paymentStatus,
      coverageExpiresAt: doc.coverageExpiresAt || null,
      coverageLifetime: doc.coverageLifetime === true,
      coverageValid: coverageValid(doc),
    });
  },

  async deleteCustomDomain(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    // Remove Cloudflare SaaS hostname first (best effort) so certs are cleaned up.
    if (cfConfig()) await cfDeleteCustomHostname(doc.domain);
    await s.delete(`domain/${doc.domain}`);
    const linkBlobs = await listAll(s, "link/");
    const linkDocs = await mapWithConcurrency(linkBlobs, 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const target = doc.domain.toLowerCase();
    const doomed = [];
    const seen = new Set();
    for (const l of linkDocs) {
      if (!l || !l.code) continue;
      let match = false;
      if ((l.domain || "").toLowerCase() === target) match = true;
      if (!match) {
        try { if (new URL(l.short).hostname.toLowerCase() === target) match = true; } catch { /* no */ }
      }
      if (!match) continue;
      // Delete by BOTH possible keys (legacy docs may have mismatched domain field).
      const keys = new Set([linkKey(l.domain || doc.domain, l.code)]);
      try { keys.add(linkKey(new URL(l.short).hostname, l.code)); } catch { /* ignore */ }
      for (const k of keys) {
        if (!seen.has(k)) { seen.add(k); doomed.push({ link: l, key: k }); }
      }
    }
    await mapWithConcurrency(doomed, 12, (d) => s.delete(d.key));
    try {
      const uniqCodes = new Set(doomed.map((d) => d.link.code));
      await bumpSessionLinkCount(s, p.sessionId, -uniqCodes.size);
    } catch { /* best effort */ }
    return ok({ deletedUrls: doomed.length });
  },

  // ----- billing (Bitcoin) -----
  // Address uniqueness model: quotes live on the domain doc (session-owned —
  // cross-session access is rejected), each fresh quote consumes the next
  // global wallet index, and an unexpired quote is re-shown verbatim. So a
  // displayed address belongs to exactly one session and is stable while
  // unpaid. When a quote is superseded (manual refresh / expiry), the old
  // {address, amount} is retired into doc.quoteHistory so the watcher still
  // credits funds sent to an address the user actually saw.
  //
  // Blobs has no compare-and-swap, so two simultaneous quotes could read the
  // same wallet index. Collision is resolved KEEP-FIRST (never random — the
  // first session may already be paying): after deriving, the address is
  // checked against every other domain's current + retired quotes and
  // re-issued from the next index on clash. A post-save re-check closes the
  // residual race where two requests derive the same index concurrently —
  // whoever saved second re-issues. This runs server-side before the
  // response, so no duplicate ever reaches a screen — no flash needed.

  async generatePaymentAddress(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    // Drop dead discounts first so a renewal after code expiry prices full
    // again (a renewal payment is always allowed — it is how lapsed domains
    // come back). Never blocks: paying is the way out of expiry.
    if (refreshCoverage(doc)) await s.setJSON(`domain/${doc.domain}`, doc);
    const dns = doc.dnsVerification || {};
    // Exact substring the frontend matches on — keep stable.
    if (!(dns.cnameValid && dns.txtVerified)) {
      return fail(412, "failed-precondition", "DNS verification required before payment.");
    }
    const now = Date.now();
    // A consumed quote (already paid) is never re-shown: renewals always get
    // a fresh address, otherwise the user would pay an address the watcher
    // already credited.
    const quoteConsumed = !!doc.quote?.paidAt;
    if (!p.forceRefresh && !quoteConsumed && doc.quote && doc.quote.address && new Date(doc.quote.expiresAt).getTime() > now) {
      return ok({
        amount: doc.quote.amount,
        address: doc.quote.address,
        expiresAt: doc.quote.expiresAt,
        index: doc.quote.index,
        ...(doc.quote.discountPercent ? { discountPercent: doc.quote.discountPercent, originalAmount: doc.quote.originalAmount } : {}),
        coverageExpiresAt: doc.coverageExpiresAt || null,
        coverageLifetime: doc.coverageLifetime === true,
        coverageValid: coverageValid(doc),
      });
    }
    const price = await btcUsdPrice().catch((e) => {
      throw Object.assign(new Error(e.message), { statusCode: 503, code: "unavailable" });
    });
    const pct = doc.discount ? doc.discount.percent : 0;
    const q = quoteFor(pct, price);
    let address = doc.quote && doc.quote.address && !p.forceRefresh && !quoteConsumed ? doc.quote.address : null;
    if (!address) {
      // Retire the quote being replaced (if any) so late payments to an
      // address the user already saw are still credited by the watcher.
      if (doc.quote && doc.quote.address) {
        doc.quoteHistory = Array.isArray(doc.quoteHistory) ? doc.quoteHistory : [];
        if (!doc.quoteHistory.some((h) => h && h.address === doc.quote.address)) {
          doc.quoteHistory.push({
            address: doc.quote.address,
            amount: doc.quote.amount,
            index: doc.quote.index,
            expiresAt: doc.quote.expiresAt,
            supersededAt: new Date().toISOString(),
            // Tag discounted deals: removeDiscountCode voids them so the
            // discounted amount can never stay payable after removal.
            ...(doc.quote.discountPercent ? { discountPercent: doc.quote.discountPercent } : {}),
          });
          if (doc.quoteHistory.length > 50) doc.quoteHistory = doc.quoteHistory.slice(-50);
        }
      }
      let idx = await nextWalletIndex(s);
      try {
        address = await deriveAddress(idx);
      } catch (e) {
        return fail(e.statusCode || 412, e.code || "failed-precondition", e.message);
      }
      // Keep-first collision loop: another session may hold this address
      // already (current or retired quote). Re-issue from the next index;
      // bounded so a pathological store can't hang the request.
      let clashes = 0;
      while (clashes < 5 && (await addressTakenByOtherDomain(s, doc.domain, address))) {
        console.warn(`address clash on index ${idx} for ${doc.domain}, re-issuing`);
        idx = await nextWalletIndex(s);
        try {
          address = await deriveAddress(idx);
        } catch (e) {
          return fail(e.statusCode || 412, e.code || "failed-precondition", e.message);
        }
        clashes++;
      }
      doc.quote = { ...q, address, index: idx };
    } else {
      doc.quote = { ...q, address, index: doc.quote.index };
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    // Post-save clash re-check (see model above): whoever saved second
    // re-issues. Derivation is deterministic, so a working xpub cannot start
    // failing here; bounded so a pathological store can't hang the request.
    // The retired entry keeps its discount tag (spread) for removeDiscountCode.
    let reverified = 0;
    while (reverified < 3 && (await addressTakenByOtherDomain(s, doc.domain, doc.quote.address))) {
      console.warn(`post-save address clash on index ${doc.quote.index} for ${doc.domain}, re-issuing`);
      doc.quoteHistory = Array.isArray(doc.quoteHistory) ? doc.quoteHistory : [];
      doc.quoteHistory.push({ ...doc.quote, supersededAt: new Date().toISOString() });
      if (doc.quoteHistory.length > 20) doc.quoteHistory = doc.quoteHistory.slice(-20);
      const idx = await nextWalletIndex(s);
      const fresh = await deriveAddress(idx);
      doc.quote = { ...q, address: fresh, index: idx };
      await s.setJSON(`domain/${doc.domain}`, doc);
      reverified++;
    }
    return ok({ amount: doc.quote.amount, address: doc.quote.address, expiresAt: doc.quote.expiresAt, index: doc.quote.index, ...(q.discountPercent ? { discountPercent: q.discountPercent, originalAmount: q.originalAmount } : {}), coverageExpiresAt: doc.coverageExpiresAt || null, coverageLifetime: doc.coverageLifetime === true, coverageValid: coverageValid(doc) });
  },

  async checkDomainDiscount(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    if (refreshCoverage(doc)) await s.setJSON(`domain/${doc.domain}`, doc);
    if (doc.discount && doc.discount.percent > 0) {
      return ok({
        hasDiscount: true,
        discountCode: doc.discount.code,
        discountPercent: doc.discount.percent,
        amount: doc.quote ? doc.quote.amount : undefined,
        originalAmount: doc.quote ? doc.quote.originalAmount : undefined,
        coverageExpiresAt: doc.coverageExpiresAt || null,
        coverageLifetime: doc.coverageLifetime === true,
        coverageValid: coverageValid(doc),
      });
    }
    return ok({
      hasDiscount: false,
      coverageExpiresAt: doc.coverageExpiresAt || null,
      coverageLifetime: doc.coverageLifetime === true,
      coverageValid: coverageValid(doc),
    });
  },

  async adminCreateDiscountCode(s, p, event) {
    await needAdmin(s, p, event);
    let code = cleanPromoCode(p.code);
    if (!code) {
      // Auto-generate a readable unique code when blank/invalid.
      code = null;
      for (let i = 0; i < 5 && !code; i++) {
        const c = `TUNNEL-${newCode(6).toUpperCase()}`;
        if (!(await freshGet(s, `promo/${c}`, { type: "json" }).catch(() => null))) code = c;
      }
      if (!code) return fail(503, "unavailable", "Could not mint a unique code, try again.");
    } else if (await freshGet(s, `promo/${code}`, { type: "json" }).catch(() => null)) {
      return fail(409, "already-exists", "That code already exists — delete it first or pick another.");
    }
    const percent = Number.isFinite(Number(p.percent)) ? Math.floor(Number(p.percent)) : 0;
    if (!(percent >= 1 && percent <= 100)) return fail(400, "invalid-argument", "Percent must be 1–100.");
    const maxUses = p.maxUses === undefined || p.maxUses === null || p.maxUses === ""
      ? 1
      : Math.floor(Number(p.maxUses));
    if (!(maxUses >= 1 && maxUses <= 10000)) return fail(400, "invalid-argument", "Max uses must be 1–10000.");
    let expiresAt = null;
    if (p.expiresAt) {
      const t = new Date(p.expiresAt).getTime();
      if (!Number.isFinite(t) || t <= Date.now()) return fail(400, "invalid-argument", "Expiry must be a future date.");
      expiresAt = new Date(t).toISOString();
    }
    const note = String(p.note || "").slice(0, 140);
    const promo = {
      code,
      percent,
      maxUses,
      uses: [],
      note,
      createdAt: new Date().toISOString(),
      expiresAt,
      disabled: false,
    };
    await s.setJSON(`promo/${code}`, promo);
    return ok(promoShape(promo));
  },

  async adminListDiscountCodes(s, p, event) {
    await needAdmin(s, p, event);
    const blobs = await listAll(s, "promo/");
    const docs = await mapWithConcurrency(blobs, 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const out = docs.filter(Boolean).map(promoShape);
    out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return ok({ codes: out });
  },

  async adminDeleteDiscountCode(s, p, event) {
    await needAdmin(s, p, event);
    const code = cleanPromoCode(p.code);
    if (!code) return fail(400, "invalid-argument", "Invalid code.");
    await s.delete(`promo/${code}`);
    // Past redemptions stay consumed (recorded on each domain doc + gone
    // with the promo doc): deleting revokes FUTURE use only.
    return ok({ deleted: code });
  },

  // ----- Link Management (admin moderation) -----
  // All gated by needAdmin + audit-logged. Redaction happens in the UI
  // (redacted-by-default, click-to-reveal); the backend returns full values
  // so moderation (quarantine/delete/block) is possible.

  async adminSearchLinks(s, p, event) {
    await needAdmin(s, p, event);
    const qCode = typeof p.code === "string" ? p.code.trim() : "";
    const qDomain = cleanDomain(p.domain || "");
    const qOrig = typeof p.originalContains === "string" ? p.originalContains.trim().toLowerCase().slice(0, 120) : "";
    const onlyQ = p.quarantinedOnly === true;
    const blobs = await listAll(s, "link/");
    const docs = await mapWithConcurrency(blobs.slice(0, 2000), 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    let found = docs.filter(Boolean);
    if (qDomain) found = found.filter((l) => (l.domain || "").toLowerCase() === qDomain);
    if (qCode) found = found.filter((l) => (l.code || "") === qCode);
    if (qOrig) found = found.filter((l) => String(l.original || "").toLowerCase().includes(qOrig));
    if (onlyQ) found = found.filter((l) => l.quarantined === true);
    found.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return ok({ links: found.slice(0, 50).map(linkShape), truncated: found.length > 50, total: found.length });
  },

  async adminSetQuarantine(s, p, event) {
    await needAdmin(s, p, event);
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    link.quarantined = p.quarantined !== false;
    if (link.quarantined) {
      link.quarantineReason = String(p.reason || "ADMIN").slice(0, 40);
      link.quarantineAt = new Date().toISOString();
    } else {
      delete link.quarantined;
      delete link.quarantineReason;
      delete link.quarantineAt;
    }
    await s.setJSON(linkKey(host, link.code), link);
    try {
      await s.setJSON(`admin-log/${new Date().toISOString()}-quarantine`, {
        at: new Date().toISOString(), host, code: link.code, quarantined: link.quarantined,
      }).catch(() => {});
    } catch { /* ignore */ }
    return ok({ quarantined: link.quarantined === true });
  },

  async adminDeleteLink(s, p, event) {
    await needAdmin(s, p, event);
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    await s.delete(linkKey(host, link.code));
    try {
      const alt = new URL(link.short).hostname.toLowerCase();
      if (alt && alt !== host.toLowerCase()) await s.delete(linkKey(alt, link.code));
    } catch { /* ignore */ }
    await deleteClickKeys(s, host, link.code);
    try {
      const counts = await listAll(s, `counts/${host.toLowerCase()}/${link.code}/`);
      await mapWithConcurrency(counts.slice(0, 500), 12, (b) => s.delete(b.key).catch(() => null));
    } catch { /* ignore */ }
    try { await bumpSessionLinkCount(s, link.sessionId, -1); } catch { /* ignore */ }
    try {
      await s.setJSON(`admin-log/${new Date().toISOString()}-dellink`, {
        at: new Date().toISOString(), host, code: link.code,
      }).catch(() => {});
    } catch { /* ignore */ }
    return ok({ deleted: link.code });
  },

  async adminBlockOriginal(s, p, event) {
    await needAdmin(s, p, event);
    const original = String(p.original || "").trim();
    if (!original || original.length > 2048) return fail(400, "invalid-argument", "Invalid URL.");
    const h = await originalHash(original);
    if (!h) return fail(400, "invalid-argument", "Invalid URL.");
    let host = "";
    try { host = new URL(original).hostname.toLowerCase().slice(0, 120); } catch { /* keep empty */ }
    await s.setJSON(`blocked/${h}`, { hash: h, host, at: new Date().toISOString(), reason: String(p.reason || "ADMIN").slice(0, 40) });
    // Sweep existing links with the exact same original (bounded).
    let swept = 0;
    try {
      const blobs = await listAll(s, "link/");
      const docs = await mapWithConcurrency(blobs.slice(0, 2000), 12, (b) =>
        freshGet(s, b.key, { type: "json" }).catch(() => null)
      );
      const matches = docs.filter((l) => l && String(l.original || "").trim() === original).slice(0, 200);
      await mapWithConcurrency(matches, 12, (l) => {
        l.quarantined = true;
        l.quarantineReason = "BLOCKLISTED";
        l.quarantineAt = new Date().toISOString();
        return s.setJSON(linkKey(l.domain || host, l.code), l);
      });
      swept = matches.length;
    } catch (e) {
      console.error("block sweep failed:", e?.message || e);
    }
    try {
      await s.setJSON(`admin-log/${new Date().toISOString()}-block`, {
        at: new Date().toISOString(), hash: h, host, swept,
      }).catch(() => {});
    } catch { /* ignore */ }
    return ok({ blocked: true, swept });
  },

  async adminUnblockOriginal(s, p, event) {
    await needAdmin(s, p, event);
    const original = String(p.original || "").trim();
    const hash = typeof p.hash === "string" ? p.hash.trim().toLowerCase() : null;
    const h = hash && /^[0-9a-f]{64}$/.test(hash) ? hash : await originalHash(original);
    if (!h) return fail(400, "invalid-argument", "Invalid URL or hash.");
    await s.delete(`blocked/${h}`);
    return ok({ unblocked: true });
  },

  async applyDiscountCode(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    const code = String(p.code || "").trim().toUpperCase();
    if (!cleanPromoCode(code)) return fail(400, "invalid-argument", "Invalid or expired discount code.");
    // Idempotent: this domain already holds this exact code.
    if (doc.discount && doc.discount.code === code) {
      if (doc.discount.percent >= 100 && doc.paymentStatus === "paid") {
        return ok({
          isFullDiscount: true,
          discounted: true,
          message: "Discount covers the full price — your domain is activated.",
          amount: "0.00000000",
          discountPercent: 100,
          coverageExpiresAt: doc.coverageExpiresAt || null,
          coverageLifetime: doc.coverageLifetime === true,
          coverageValid: coverageValid(doc),
        });
      }
      if (doc.quote && doc.quote.address) {
        return ok({
          discounted: true,
          amount: doc.quote.amount,
          address: doc.quote.address,
          expiresAt: doc.quote.expiresAt,
          index: doc.quote.index,
          discountPercent: doc.discount.percent,
          originalAmount: doc.quote.originalAmount,
          coverageExpiresAt: doc.coverageExpiresAt || null,
          coverageLifetime: doc.coverageLifetime === true,
          coverageValid: coverageValid(doc),
        });
      }
    }
    // Managed Blobs promos are the only source of discount codes.
    const stored = await freshGet(s, `promo/${code}`, { type: "json" }).catch(() => null);
    if (!stored || stored.disabled) {
      return fail(400, "invalid-argument", "Invalid or expired discount code.");
    }
    if (stored.expiresAt && new Date(stored.expiresAt).getTime() <= Date.now()) {
      return fail(400, "invalid-argument", "Invalid or expired discount code.");
    }
    const used = Array.isArray(stored.uses) ? stored.uses.length : 0;
    if (used >= (stored.maxUses || 1)) {
      return fail(400, "invalid-argument", "This code has already been redeemed.");
    }
    const pct = stored.percent;
    const promo = stored;
    // Reserve BEFORE applying (use stays burned if doc save fails — a code can
    // never stretch past maxUses through retries). Activate-after-trim: the
    // winner is decided BEFORE touching the domain, so concurrent losers never
    // flash active and can never mint in a double-active window.
    promo.uses = Array.isArray(promo.uses) ? promo.uses : [];
    const myUse = { domain: doc.domain, sessionId: p.sessionId, at: new Date().toISOString() };
    promo.uses.push(myUse);
    await s.setJSON(`promo/${code}`, promo);
    try {
      const fresh = await freshGet(s, `promo/${code}`, { type: "json" }).catch(() => null);
      const max = (fresh && fresh.maxUses) || promo.maxUses || 1;
      if (fresh && Array.isArray(fresh.uses) && fresh.uses.length > max) {
        const sorted = [...fresh.uses].sort(
          (a, b) => String(a?.at || "").localeCompare(String(b?.at || "")) ||
            String(a?.domain || "").localeCompare(String(b?.domain || ""))
        );
        const kept = sorted.slice(0, max);
        const won = kept.some((u) => u && u.domain === doc.domain && u.sessionId === p.sessionId);
        fresh.uses = kept;
        await s.setJSON(`promo/${code}`, fresh);
        if (!won) return fail(400, "invalid-argument", "This code has already been redeemed.");
      }
    } catch (e) {
      console.error(`promo trim check failed for ${code}:`, e?.message || e);
    }
    // The code's expiry doubles as the domain's coverage end: redeeming pins
    // it to the domain so later expiry checks know what capped this deal.
    doc.discount = { code, percent: pct, expiresAt: promo.expiresAt || null };
    if (pct >= 100) {
      doc.paymentStatus = "paid";
      doc.quote = null;
      // Full grant covers until the code's expiry — lifetime when the code
      // itself never expires. It never shortens coverage already in force
      // (e.g. a paid year outlasting the code): best coverage wins.
      if (!promo.expiresAt) {
        doc.coverageExpiresAt = null;
        doc.coverageLifetime = true;
      } else if (!coverageValid(doc) || (doc.coverageExpiresAt && new Date(promo.expiresAt).getTime() > new Date(doc.coverageExpiresAt).getTime())) {
        doc.coverageExpiresAt = promo.expiresAt;
        doc.coverageLifetime = false;
      }
      if (doc.isVerified && coverageValid(doc)) {
        doc.status = "active";
        await ensureSaaSHostname(doc);
      }
      await s.setJSON(`domain/${doc.domain}`, doc);
      return ok({
        isFullDiscount: true,
        discounted: true,
        message: "Discount covers the full price — your domain is activated.",
        amount: "0.00000000",
        discountPercent: 100,
        coverageExpiresAt: doc.coverageExpiresAt,
        coverageLifetime: doc.coverageLifetime,
        coverageValid: coverageValid(doc),
      });
    }
    // Regenerate quote at the discounted price.
    const price = await btcUsdPrice().catch((e) => {
      throw Object.assign(new Error(e.message), { statusCode: 503, code: "unavailable" });
    });
    const q = quoteFor(pct, price);
    let address = doc.quote && doc.quote.address ? doc.quote.address : null;
    if (!address) {
      let idx = await nextWalletIndex(s);
      try {
        address = await deriveAddress(idx);
      } catch (e) {
        return fail(e.statusCode || 412, e.code || "failed-precondition", e.message);
      }
      // Same keep-first collision guard as generatePaymentAddress.
      let clashes = 0;
      while (clashes < 5 && (await addressTakenByOtherDomain(s, doc.domain, address))) {
        console.warn(`address clash on index ${idx} for ${doc.domain}, re-issuing`);
        idx = await nextWalletIndex(s);
        try {
          address = await deriveAddress(idx);
        } catch (e) {
          return fail(e.statusCode || 412, e.code || "failed-precondition", e.message);
        }
        clashes++;
      }
      doc.quote = { ...q, address, index: idx };
    } else {
      doc.quote = { ...q, address, index: doc.quote.index };
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    // Post-save clash re-check: same simultaneous-issuance race as
    // generatePaymentAddress (see model above) — whoever saved second
    // re-issues, keeping its discounted price.
    let reverified = 0;
    while (reverified < 3 && (await addressTakenByOtherDomain(s, doc.domain, doc.quote.address))) {
      console.warn(`post-save address clash on index ${doc.quote.index} for ${doc.domain}, re-issuing`);
      doc.quoteHistory = Array.isArray(doc.quoteHistory) ? doc.quoteHistory : [];
      doc.quoteHistory.push({ ...doc.quote, supersededAt: new Date().toISOString() });
      if (doc.quoteHistory.length > 50) doc.quoteHistory = doc.quoteHistory.slice(-50);
      const idx = await nextWalletIndex(s);
      const fresh = await deriveAddress(idx);
      doc.quote = { ...q, address: fresh, index: idx };
      await s.setJSON(`domain/${doc.domain}`, doc);
      reverified++;
    }
    // Winner already decided before apply (trim-before-activate); no second
    // overshoot possible here (no further pushes). Address clash loop above
    // preserves the discounted price.
    return ok({
      discounted: true,
      amount: doc.quote.amount,
      address: doc.quote.address,
      expiresAt: doc.quote.expiresAt,
      index: doc.quote.index,
      discountPercent: pct,
      originalAmount: q.originalAmount,
      coverageExpiresAt: doc.coverageExpiresAt || null,
      coverageLifetime: doc.coverageLifetime === true,
      coverageValid: coverageValid(doc),
    });
  },

  async removeDiscountCode(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    // Funds-in-flight guard: voiding discounted history while a discounted
    // payment is unconfirmed (or partially confirmed) would make that money
    // invisible forever. If ANY displayed address shows movement, refuse and
    // tell the user to wait for confirmation first.
    try {
      const addrs = [];
      if (doc.quote?.address) addrs.push(doc.quote.address);
      for (const h of Array.isArray(doc.quoteHistory) ? doc.quoteHistory : []) {
        if (h?.address && h?.discountPercent) addrs.push(h.address);
      }
      for (const a of [...new Set(addrs)].slice(0, 5)) {
        const res = await fetch(`https://mempool.space/api/address/${encodeURIComponent(a)}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        const chain = (Number(data?.chain_stats?.funded_txo_sum) || 0) - (Number(data?.chain_stats?.spent_txo_sum) || 0);
        const mem = (Number(data?.mempool_stats?.funded_txo_sum) || 0) - (Number(data?.mempool_stats?.spent_txo_sum) || 0);
        if (chain > 0 || mem > 0) {
          return fail(409, "failed-precondition", "Payment detected to this domain's address — wait for confirmation before removing the code.");
        }
      }
    } catch (e) {
      console.error(`removeDiscountCode pre-check failed for ${doc.domain}:`, e?.message || e);
      // Fail-closed here is wrong (price feed hiccup shouldn't trap users),
      // but log loudly: the void below is irreversible for discounted history.
    }
    doc.discount = null;
    // Coverage follows the money, not the removed deal: a payment within
    // the last year still covers (recomputed from it); otherwise coverage
    // lapses and the domain goes pending until renewed. Lifetime grants
    // (never-expiring 100% codes) are left untouched.
    if (doc.coverageLifetime !== true) {
      const paidAt = doc.lastPaymentAt ? new Date(doc.lastPaymentAt).getTime() : NaN;
      if (Number.isFinite(paidAt) && paidAt + COVERAGE_YEAR_MS > Date.now()) {
        doc.coverageExpiresAt = new Date(paidAt + COVERAGE_YEAR_MS).toISOString();
      } else {
        doc.coverageExpiresAt = null;
      }
      if (doc.status === "active" && !coverageValid(doc)) doc.status = "pending_verification";
    }
    // Void discounted history entries: they priced a deal that no longer
    // exists — otherwise the discounted amount would stay payable forever
    // on a retired address. Full-price entries are untouched (late payments
    // and top-ups to them keep crediting).
    if (Array.isArray(doc.quoteHistory)) {
      doc.quoteHistory = doc.quoteHistory.filter((h) => !(h && h.discountPercent));
    }
    // Re-price the current quote at full price in place (same address), so
    // the displayed amount can never be a stale discount. If the price feed
    // is down, drop the quote so the next call mints a fresh full-price one.
    if (doc.quote && doc.quote.address) {
      try {
        const price = await btcUsdPrice();
        const q = quoteFor(0, price);
        doc.quote = { ...q, address: doc.quote.address, index: doc.quote.index };
      } catch (e) {
        doc.quote = null;
      }
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    // NOTE: promo uses are intentionally NOT freed — a consumed single-use
    // code stays consumed, otherwise apply/remove would loop into infinite
    // discounts. The domain simply returns to full price.
    return ok({});
  },

  // Instant on-demand payment check (no admin token): owner clicks
  // "I've paid — Check now". Same balance logic as the hourly watcher but
  // scoped to this domain only. Rate-limited to avoid mempool hammering.
  async checkPaymentNow(s, p, event) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    const ip = clientIp(event);
    if (!(await checkRate(s, "checkpay", `${ip}:${doc.domain}`, 2))) {
      const e = new Error("Checking too often — wait 30s and try again.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    // Idempotency gate (mirrors the hourly watcher): an already-covered paid
    // domain is a no-op. Without this, every check would stack another free
    // year — and concurrent double-fires would double-extend one payment.
    if (doc.paymentStatus === "paid" && coverageValid(doc)) {
      return ok({
        paid: true,
        alreadyCovered: true,
        status: doc.status,
        coverageExpiresAt: doc.coverageExpiresAt || null,
        coverageLifetime: doc.coverageLifetime === true,
        coverageValid: true,
      });
    }
    const lastPaidAt = doc.lastPaymentAt ? new Date(doc.lastPaymentAt).getTime() : 0;
    const candidates = [];
    // Unpaid domains: current quote always counts (even expired — late payers
    // must still credit). Paid-but-lapsed domains: only a genuine renewal
    // quote (unconsumed, issued after the last payment) plus retired history.
    // Consumed (already-credited) quotes are NEVER re-checked — otherwise
    // every re-check would instantly "re-pay" and extend coverage for free.
    if (doc.paymentStatus !== "paid") {
      if (doc.quote?.address && doc.quote?.amount) {
        candidates.push({ address: doc.quote.address, amount: doc.quote.amount, current: true });
      }
    } else if (doc.quote?.address && doc.quote?.amount && isRenewalQuote(doc.quote, lastPaidAt)) {
      candidates.push({ address: doc.quote.address, amount: doc.quote.amount, current: true });
    }
    for (const h of Array.isArray(doc.quoteHistory) ? doc.quoteHistory : []) {
      if (h?.address && h?.amount) candidates.push({ address: h.address, amount: h.amount, current: false });
    }
    if (!candidates.length) return ok({ paid: false, reason: "no-quote" });
    let seenUnconfirmed = false;
    let partial = null;
    try {
      for (const c of candidates) {
        const res = await fetch(`https://mempool.space/api/address/${encodeURIComponent(c.address)}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        const stats = data?.chain_stats || {};
        const mem = data?.mempool_stats || {};
        const bal = BigInt(Number(stats.funded_txo_sum) || 0) - BigInt(Number(stats.spent_txo_sum) || 0);
        const memBal = BigInt(Number(mem.funded_txo_sum) || 0) - BigInt(Number(mem.spent_txo_sum) || 0);
        if (memBal > 0n) seenUnconfirmed = true;
        const required = satsFromBtc(c.amount);
        if (bal >= required) {
          // Race guard: re-read before writing. If another check/watcher
          // activated between our read and now, take the no-op path instead
          // of stacking a second year for one payment.
          const seenPaidAt = doc.lastPaymentAt || null;
          const latest = await freshGet(s, `domain/${doc.domain}`, { type: "json" }).catch(() => null);
          if (latest && (latest.lastPaymentAt || null) !== seenPaidAt && latest.paymentStatus === "paid" && coverageValid(latest)) {
            return ok({
              paid: true,
              alreadyCovered: true,
              status: latest.status,
              coverageExpiresAt: latest.coverageExpiresAt || null,
              coverageLifetime: latest.coverageLifetime === true,
              coverageValid: true,
            });
          }
          const now = Date.now();
          doc.paymentStatus = "paid";
          const currentExp = coverageValid(doc) ? new Date(doc.coverageExpiresAt).getTime() : now;
          let exp = Math.max(now, currentExp) + COVERAGE_YEAR_MS;
          if (doc.discount?.expiresAt) {
            const cap = new Date(doc.discount.expiresAt).getTime();
            if (Number.isFinite(cap) && cap > now) exp = Math.min(exp, cap);
          }
          if (doc.coverageLifetime !== true) {
            doc.coverageExpiresAt = new Date(exp).toISOString();
            doc.coverageLifetime = false;
          }
          doc.lastPaymentAt = new Date(now).toISOString();
          if (doc.isVerified && coverageValid(doc)) doc.status = "active";
          doc.paidAddress = c.address;
          doc.paidAmount = c.amount;
          if (doc.quote) doc.quote.paidAt = new Date().toISOString();
          if (cfConfig() && doc.isVerified) {
            try {
              const cf = await cfEnsureCustomHostname(doc.domain);
              if (cf) {
                doc.cfHostnameId = cf.id || null;
                doc.cfHostnameStatus = cf.status || null;
                doc.cfSslStatus = cf.ssl?.status || null;
              }
            } catch (e) {
              console.error(`SaaS ensure failed for ${doc.domain}:`, e?.message || e);
            }
          }
          await s.setJSON(`domain/${doc.domain}`, doc);
          return ok({
            paid: true,
            status: doc.status,
            coverageExpiresAt: doc.coverageExpiresAt || null,
            coverageLifetime: doc.coverageLifetime === true,
            coverageValid: coverageValid(doc),
          });
        }
        // Exact amounts are required (copy button shows the full sum, fee is
        // separate) — but a confirmed shortfall must be REPORTED with numbers
        // so the user can top up the same address instead of hanging blind.
        if (bal > 0n && !partial) {
          partial = { received: satsToBtc(bal), required: c.amount, address: c.address };
        }
      }
    } catch (e) {
      console.error(`checkPaymentNow failed for ${doc.domain}:`, e?.message || e);
      return fail(503, "unavailable", "Balance check failed, try again.");
    }
    return ok({ paid: false, status: doc.status, coverageValid: coverageValid(doc), seenUnconfirmed, partial });
  },

  async getBtcPrice() {
    try {
      return ok({ price: await btcUsdPrice() });
    } catch (e) {
      return fail(503, "unavailable", e.message);
    }
  },
};

// ---------- entry ----------

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return fail(405, "unimplemented", "Use POST with { action, ...params }.");
  }
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return fail(400, "invalid-argument", "Invalid JSON body.");
  }
  const fn = actions[body.action];
  if (!fn) return fail(400, "invalid-argument", `Unknown action: ${body.action || "(missing)"}.`);
  const s = store(event);
  try {
    return await fn(s, body, event);
  } catch (e) {
    console.error(`api:${body.action} failed:`, e);
    return fail(e.statusCode || 500, e.code || "internal", e.message || "Internal error.");
  }
}
