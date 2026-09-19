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
  isPublicSuffix,
  sslDelegationTarget,
  cfConfig,
  cfGetCustomHostname,
  cfEnsureSaaS,
  cfNeedsTxt,
  cfDeleteCustomHostname,
  btcUsdPrice,
  quoteFor,
  satsFromBtc,
  satsToBtc,
  isRenewalQuote,
  checkUrlSafety,
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
  canonicalOriginalForms,
  isBlockedOriginal,
  listAll,
  coverageValid,
  COVERAGE_YEAR_MS,
  ignoredAddresses,
  markIgnored,
  linkKey,
  clicksPrefix,
  freshGet,
  getWithRetry,
  mapWithConcurrency,
  apexRedirectTargets,
  wwwForApex,
  apexForWww,
  fallbackCanonicalFor,
  verifyApexRedirect as verifyApexRedirectDns,
} from "./lib/util.js";
// Static import (not dynamic): node_bundler="nft" traces static imports for
// the function bundle — a dynamic import() can be missed at bundle time and
// fail at runtime with "cannot find module", silently killing mail notify.
import nodemailer from "nodemailer";

// Ensure a Cloudflare SaaS custom hostname exists once the domain is
// verified + paid — identically for every custom domain. Only s./tunnel.
// are the app itself (reserved in addCustomDomain, can never be claimed).
// Best effort: DNS ownership remains the source of truth; SaaS failures are
// logged and surfaced via cf fields, never block payment.

async function fetchWithTimeoutMs(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Turnstile gate (mint-family only, never resolve): lenient risk-based.
// Throws 412 turnstile-required when a widget must be solved.
async function requireTurnstile(s, p, event, kind) {
  if (!(await turnstileRequired(s, kind, clientIp(event), p.sessionId || null))) return;
  const v = await verifyTurnstileToken(p.turnstileToken, trustedRawIp(event));
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
      `Contact: ${doc.contact || "-"}`,
      `IP: ${doc.ip || "-"}`,
      `UA: ${doc.ua || "-"}`,
      ``,
      String(doc.message || ""),
    ];
    await transporter.sendMail({
      from: `INOCULENS TUNNEL Feedback <${from}>`,
      to,
      subject: `[INOCULENS TUNNEL Feedback] ${doc.id}`,
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
  // Single SaaS policy (see cfEnsureSaaS): http first, txt only when SaaS
  // reports the CNAME problem. Orange/proxied CNAMEs classifying as alias on
  // the wire keep working http with no extra TXT step.
  try {
    const cf = await cfEnsureSaaS(doc.domain, doc.dnsVerification?.routingMethod || null);
    if (cf) {
      doc.cfHostnameId = cf.id || doc.cfHostnameId || null;
      doc.cfHostnameStatus = cf.status || null;
      doc.cfSslStatus = cf.ssl?.status || null;
      doc.cfSslMethod = cf.ssl?.method || wantMethod;
      const ov = cf.ownership_verification || null;
      if (ov && ov.name && ov.value) {
        doc.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
      }
    }
    return cf;
  } catch (e) {
    console.error(`ensureSaaSHostname(${doc.domain}) failed:`, e?.message || e);
    return null;
  }
}

// Effective display label, shared by add/display-claim routing and claim DNS
// resolution: stored name, else apex for paired docs (incl. legacy rows),
// else canonical. One rule everywhere so a typed label always finds its setup.
function effectiveDisplayLabel(d) {
  if (!d) return "";
  const storedApex = (typeof d.apexSource === "string" && d.apexSource) ? d.apexSource : null;
  const pairedApex = storedApex || (d.isApexFlow === true ? apexForWww(d.domain) : null);
  return String(
    ((typeof d.displayName === "string" && d.displayName) ? d.displayName : null) ||
    ((d.isApexFlow === true && pairedApex) ? pairedApex : null) ||
    d.domain || ""
  ).toLowerCase();
}

// Convert a touched primary (redirect host X) into its fallback pair on the
// canonical www.X — the explicit user-confirmed alternative to refusing with
// 409. Setup state moves so NO new payment is ever charged: coverage +
// payment state, current/retired quotes (in-flight money still credits),
// settled-address guards (funds can never double-trigger), promo grant,
// consent record, and root-routing target. Links NEVER move host: a link's
// host is set in stone at mint (what the user picked stays picked) — link,
// click, and count rows stay exactly where they are, and the entry owns both
// hosts' rows (delete sweeps the pair; transfers move both hosts' session).
// The abandoned host keeps serving its links (old X/… URLs keep working,
// including through the path-preserving redirect). Caller guarantees: same
// session (or claimant session on claim-migrate), no pendingClaim, explicit
// user intent. Destination host free except exit-restore paths, which check.
// Non-atomic by design (batched writes); the hourly watcher window is
// negligible and moved lastPaymentAt/paidAt guards keep it consistent.
// Move a whole domain setup between hosts — coverage/payment state, quotes,
// promo grant, consent, and root-routing target all follow; links, click
// rows, and count shards stay in place (host set in stone). Used both ways:
// primary -> fallback pair on convert (no new payment) and pair -> primary
// on exit or recommended-claim of a pair (the entered host is fixed in
// stone: exit must never morph it into the canonical). Fresh DNS state +
// fresh token on arrival (new names need new records); SaaS hostname of the
// abandoned host is dropped best-effort.
// Full stone-history set for a domain doc: its own host plus every
// previously-abandoned host (single-field chain + full history array).
// Readers must use this helper so multi-hop moves (S1→S2→S1→S2) never drop
// the oldest hosts from sweeps, moves, or serving checks.
function stoneHostsForDoc(doc) {
  const set = new Set();
  const add = (v) => {
    const x = String(v || "").toLowerCase();
    if (x) set.add(x);
  };
  if (!doc) return set;
  add(doc.domain);
  add(doc.apexSource);
  add(doc.movedFrom);
  add(doc.movedFromChain);
  try {
    if (Array.isArray(doc.movedFromHistory)) {
      for (const h of doc.movedFromHistory) add(h);
    }
  } catch { /* ignore */ }
  return set;
}

async function migrateDomainSetup(s, p, srcDoc, srcHost, destHost, { display, paired, redirect }) {
  const delegation = sslDelegationTarget();
  const now = Date.now();
  // Preserve full stone history: the new entry keeps owning every abandoned
  // host's rows until an independent setup occupies it, so delete sweeps and
  // transfers never orphan links behind. movedFromChain stays as compat for
  // older readers; movedFromHistory carries the complete chain.
  const prevChain = [...stoneHostsForDoc(srcDoc)].filter(
    (h) => h && h !== String(srcHost || "").toLowerCase() && h !== String(destHost || "").toLowerCase()
  );
  const dest = {
    domain: destHost,
    displayName: display || destHost,
    // Stone-history pointer: links stay on srcHost, and this entry keeps
    // owning that host's rows (delete sweeps it, transfers move it) until an
    // independent setup occupies it.
    movedFrom: srcHost,
    ...(prevChain.length ? { movedFromChain: prevChain[0], movedFromHistory: prevChain.slice(0, 20) } : {}),
    sessionId: p.sessionId,
    status: "pending_verification",
    paymentStatus: srcDoc.paymentStatus === "paid" ? "paid" : "unpaid",
    coverageExpiresAt: srcDoc.coverageExpiresAt || null,
    coverageLifetime: srcDoc.coverageLifetime === true,
    lastPaymentAt: srcDoc.lastPaymentAt || null,
    paidAddress: srcDoc.paidAddress || null,
    paidAmount: srcDoc.paidAmount || null,
    ignoredAddresses: Array.isArray(srcDoc.ignoredAddresses) ? [...srcDoc.ignoredAddresses] : [],
    quote: srcDoc.quote || null,
    quoteHistory: Array.isArray(srcDoc.quoteHistory) ? [...srcDoc.quoteHistory] : [],
    discount: srcDoc.discount || null,
    withdrawalConsent: srcDoc.withdrawalConsent || null,
    apexTarget: (typeof srcDoc.apexTarget === "string" && srcDoc.apexTarget) ? srcDoc.apexTarget : null,
    apexUpdatedAt: srcDoc.apexUpdatedAt || null,
    isVerified: false,
    verificationToken: newToken(32),
    sslTarget: delegation || `automatic via Cloudflare (${routingTarget()})`,
    dnsVerification: { cnameValid: false, txtVerified: false, sslVerified: false },
    cfHostnameId: null,
    cfHostnameStatus: null,
    cfSslStatus: null,
    createdAt: now,
    ...(paired ? { isApexFlow: true, apexSource: redirect } : {}),
  };
  await s.setJSON(`domain/${destHost}`, dest);
  // Links stay on their minted host (set in stone) — only the session moves,
  // and only for cross-session callers (claim-migrate); same-session callers
  // are a no-op write. Click rows and count shards are host/code keyed and
  // follow their links with zero work.
  // A paired entry owns BOTH hosts' rows (plus any stone chain): move every
  // related host's links, not just the abandoned host, so the source session
  // is left clean and no www/apex ghost rows linger behind. Hosts occupied
  // by an independent live doc are never touched. Two passes close the race
  // where a link is minted between the list and the move (issue #1).
  const ownedHosts = new Set([String(srcHost || "").toLowerCase(), String(destHost || "").toLowerCase()]);
  try {
    for (const h of stoneHostsForDoc(srcDoc)) ownedHosts.add(h);
    if (redirect) ownedHosts.add(String(redirect).toLowerCase());
    const w1 = (() => { try { return fallbackCanonicalFor(srcHost); } catch { return null; } })();
    if (w1) ownedHosts.add(String(w1).toLowerCase());
    const a1 = (() => { try { return apexForWww(srcHost); } catch { return null; } })();
    if (a1) ownedHosts.add(String(a1).toLowerCase());
  } catch { /* srcHost only */ }
  ownedHosts.delete("");
  // Resolve occupancy once so independent setups' rows are never stolen.
  const occupants = new Map();
  for (const h of ownedHosts) {
    if (h === String(destHost || "").toLowerCase() || h === String(srcHost || "").toLowerCase()) continue;
    try {
      const occ = await freshGet(s, `domain/${h}`, { type: "json" }).catch(() => null);
      if (occ) occupants.set(h, true);
    } catch { /* treat as unoccupied */ }
  }
  const matchesOwned = (key) => {
    const k = String(key || "").toLowerCase();
    for (const h of ownedHosts) {
      if (!h || occupants.has(h)) continue;
      if (k.startsWith(`link/${h}/`)) return true;
    }
    return false;
  };
  for (let pass = 0; pass < 2; pass++) {
    const linkBlobs = await listAll(s, "link/");
    const doomedLinks = linkBlobs.filter((b) => matchesOwned(b.key));
    if (!doomedLinks.length) break;
    await mapWithConcurrency(doomedLinks, 12, async (b) => {
      const l = await freshGet(s, b.key, { type: "json" }).catch(() => null);
      if (!l || !l.code) return;
      if (l.sessionId === p.sessionId) return;
      await s.setJSON(b.key, { ...l, sessionId: p.sessionId });
    });
  }
  try {
    if (cfConfig()) await cfDeleteCustomHostname(srcHost).catch(() => null);
  } catch { /* best effort: abandoned host no longer serves links */ }
  await s.delete(`domain/${srcHost}`);
  return dest;
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
  if (typeof code !== "string" || !code || !validSlug(code)) {
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
  // Uniform fallback pairing: a paired doc (apexSource/isApexFlow) serves short
  // links from its canonical host while its redirect host X 301-redirects to
  // it (X = whatever was entered: apex, www, or deeper). Unpaired primaries
  // have no pairing context — fallback is entered per host from the UI, which
  // derives www.X locally, so no zone guessing happens here.
  // displayName is what the user originally typed (write-once); legacy docs
  // without it fall back to the redirect host or canonical.
  const apexTargets = apexRedirectTargets();
  const storedApex = typeof doc.apexSource === "string" && doc.apexSource ? doc.apexSource : null;
  const derivedApex = apexForWww(doc.domain);
  const apexHost = storedApex || (doc.isApexFlow === true ? derivedApex : null);
  const displayName =
    (typeof doc.displayName === "string" && doc.displayName ? doc.displayName : null) ||
    (doc.isApexFlow === true && apexHost ? apexHost : doc.domain);
  // Paired docs only: the canonical IS this doc's host by construction.
  const fallbackApex = apexHost;
  const fallbackWww = fallbackApex ? doc.domain : null;
  return {
    domain: doc.domain,
    id: doc.domain,
    displayName,
    mode: doc.isApexFlow === true ? "fallback" : "primary",
    status: doc.status,
    paymentStatus: doc.paymentStatus,
    isVerified: doc.isVerified,
    coverageExpiresAt: doc.coverageExpiresAt || null,
    coverageLifetime: doc.coverageLifetime === true,
    coverageValid: coverageValid(doc),
    apexTarget: typeof doc.apexTarget === "string" && doc.apexTarget ? doc.apexTarget : null,
    isApexFlow: doc.isApexFlow === true,
    apex: apexHost,
    apexInstructions: apexHost
      ? { apex: apexHost, a: apexTargets.ipv4, aaaa: apexTargets.ipv6 }
      : null,
    fallback: fallbackApex
      ? { apex: fallbackApex, www: fallbackWww || doc.domain, a: apexTargets.ipv4, aaaa: apexTargets.ipv6, paired: doc.isApexFlow === true }
      : null,
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
      sslMethod: doc.cfSslMethod || null,
      ownershipVerification: doc.cfOwnershipVerification || null,
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
      ...(doc.cfOwnershipVerification?.name && doc.cfOwnershipVerification?.value && isOwner
        ? { cfOwnershipName: doc.cfOwnershipVerification.name, cfOwnershipValue: doc.cfOwnershipVerification.value }
        : {}),
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
  // Single choke point for the whole admin panel (all 13 admin* actions
  // gate here): 60/min/IP keeps active moderation smooth. Brute force stays
  // meaningless (~68^10 keyspace), and the check runs before key validation
  // so wrong-key probing is still throttled.
  if (!(await checkRate(s, "admin", ip, 60))) {
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

// Terms version pinned to the withdrawal-consent record below.
const TERMS_VERSION = "2026-09-14";

// EU withdrawal gate (Directive 2011/83 Art. 16(m)): no quote or discount
// may be issued until the owner consents to immediate performance and
// acknowledges losing the 14-day withdrawal right. Recorded once per domain;
// later calls pass on the stored record. Returns a fail response or null.
async function withdrawalConsentGate(s, doc, p, what) {
  if (doc.withdrawalConsent && doc.withdrawalConsent.at) return null;
  if (p.withdrawalConsent !== true) {
    // Exact prefix the frontend matches on — keep stable.
    return fail(412, "failed-precondition", `WITHDRAWAL_CONSENT_REQUIRED: tick the consent box before ${what}.`);
  }
  doc.withdrawalConsent = { at: new Date().toISOString(), termsVersion: TERMS_VERSION, sessionId: p.sessionId };
  await s.setJSON(`domain/${doc.domain}`, doc);
  return null;
}

// True when target is exactly this domain's own root (infinite loop).
function isSelfRootTarget(domain, target) {
  try {
    const u = new URL(String(target).trim());
    const path = u.pathname || "/";
    return u.hostname.toLowerCase() === String(domain).toLowerCase() &&
      (path === "/" || path === "");
  } catch {
    return false;
  }
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
    const host = cleanDomain(domain) || systemShortHost();
    // Independent pre-checks run concurrently (one round of store reads
    // instead of four serial ones). allSettled + ordered evaluation keeps
    // the exact error precedence of the old serial code (400 unsafe before
    // 429 quota), since rejection timing alone must not pick the error.
    const quotaRaw = Number(process.env.LINK_QUOTA_SYSTEM || 500);
    const q = Number.isFinite(quotaRaw) && quotaRaw > 0 ? Math.min(quotaRaw, 5000) : 500;
    const [safetyRes, quotaRes, domainRes, sessionRes] = await Promise.allSettled([
      (async () => {
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
      })(),
      // Per-session quota (default 500). Count doc preferred, scan fallback.
      // Resolves -1 when unreadable: quota gate skipped, as before (fail-open).
      (async () => {
        try {
          let count = await sessionLinkCount(s, sessionId);
          if (count === null) {
            const blobs = await listAll(s, "link/");
            const docs = await mapWithConcurrency(blobs, 12, (b) =>
              freshGet(s, b.key, { type: "json" }).catch(() => null)
            );
            count = docs.filter((l) => l && l.sessionId === sessionId).length;
            try { await s.setJSON(`sessions/${sessionId}/meta`, { linkCount: count }); } catch { /* ignore */ }
          }
          return count;
        } catch (e) {
          console.error("quota check failed open:", e?.message || e);
          return -1;
        }
      })(),
      (async () => (host !== systemShortHost()
        ? freshGet(s, `domain/${host}`, { type: "json" })
        : null))(),
      getSession(s, sessionId),
    ]);
    if (safetyRes.status === "rejected") throw safetyRes.reason;
    const quotaCount = quotaRes.status === "fulfilled" ? quotaRes.value : -1;
    if (quotaCount >= 0 && quotaCount >= q) {
      const e = new Error(`Link quota reached (${q}). Delete old links to create more.`);
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    // Store-read failures here behaved as 500s before; keep that (no silent mint).
    if (domainRes.status === "rejected") throw domainRes.reason;
    if (sessionRes.status === "rejected") throw sessionRes.reason;
    const domainDoc = domainRes.value;
    const sessionDoc = sessionRes.value;

    let code;
    // Twin-slug guard: the same slug on a counterpart host owned by this
    // session would be unreachable (serving-host wins, the other stays
    // invisible) — refuse with a clear message instead of minting a ghost.
    // Different sessions may reuse slugs freely (resolve isolates by owner).
    const counterpartHosts = (() => {
      const out = [];
      try {
        const w = fallbackCanonicalFor(host);
        if (w && w.toLowerCase() !== host.toLowerCase()) out.push(w.toLowerCase());
      } catch { /* ignore */ }
      try {
        const a = apexForWww(host);
        if (a && a.toLowerCase() !== host.toLowerCase() && !out.includes(a.toLowerCase())) out.push(a.toLowerCase());
      } catch { /* ignore */ }
      return out.slice(0, 2);
    })();
    const slugTakenOnTwin = async (slug) => {
      for (const cHost of counterpartHosts) {
        const other = await getLink(s, cHost, slug).catch(() => null);
        if (other && other.sessionId === sessionId) return cHost;
      }
      return null;
    };
    if (cleanSlug) {
      if (!validSlug(cleanSlug)) {
        const e = new Error(
          String(cleanSlug).includes(".")
            ? "Slugs cannot contain dots (they would never resolve as short links) — use - or _ instead."
            : "Custom slugs must be 1–60 chars: letters, numbers, - _"
        );
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
      const twinHost = await slugTakenOnTwin(cleanSlug);
      if (twinHost) {
        const e = new Error(`That slug is already used on ${twinHost} in this session — pick another slug or delete the twin link first.`);
        e.statusCode = 409;
        e.code = "already-exists";
        throw e;
      }
      code = cleanSlug;
    } else {
      code = null;
      for (let i = 0; i < 10 && !code; i++) {
        const c = newCode(8);
        if (await getLink(s, host, c)) continue;
        if (await slugTakenOnTwin(c)) continue;
        code = c;
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
      const doc = domainDoc;
      if (doc && refreshCoverage(doc)) await s.setJSON(`domain/${host}`, doc);
      const usable =
        doc && doc.sessionId === sessionId && doc.status === "active" && coverageValid(doc);
      if (!usable) {
        const owned = doc && doc.sessionId === sessionId;
        // Distinguish "no usable edge address" from "payment lapsed": a
        // typo'd routing target must never read as an expired subscription.
        const unroutable = owned && (doc.dnsVerification || {}).routable === false;
        const lapsed = owned && !coverageValid(doc);
        const e = new Error(unroutable
          ? "Domain does not resolve to Tunnel edge — fix the routing target (CNAME/ALIAS/ANAME) or wait for propagation, then try again."
          : lapsed
            ? "Domain coverage expired — renew the domain (new code or $10/year) to create new links."
            : "permission-denied");
        e.statusCode = 403;
        e.code = "permission-denied";
        throw e;
      }
    }

    // Implicit session creation (frontend persists it after success).
    if (!sessionDoc) {
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

  // NOTE: intentionally no rate limit on these read-only session probes —
  // each checkRate call costs Blobs round-trips on the hot refresh path,
  // and ~59-bit session IDs are not brute-forceable at any practical rate.
  async checkSessionExists(s, p) {
    return ok({ exists: !!(await getSession(s, p.sessionId)) });
  },

  async createSession(s, p, event) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session ID.");
    const ip = clientIp(event);
    if (!(await checkRate(s, "create-sess", ip, 20))) {
      const e = new Error("Too many attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
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
  // contact|null, createdAt, ip, ua }. The reporter IP is stored in plain
  // choice, for abuse triage) — visible only in the admin viewer + notify
  // mail, never to reporters. Rate-limited per IP + per session, with a
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
    // Optional reporter contact email (blank = no contact). Single mailbox
    // only — validated like envelope addresses (no CR/LF, one @).
    let contact = String(p.contact || "").trim() || null;
    if (contact) {
      contact = cleanMailbox(contact);
      if (!contact) return fail(400, "invalid-argument", "That contact email doesn’t look valid — fix it or leave the field blank.");
    }
    await needSession(s, p.sessionId);
    // Plain-text reporter IP (operator choice for abuse triage). Only ever
    // surfaces in the admin viewer + notify mail, never to reporters.
    let reporterIp = null;
    try {
      reporterIp = String(trustedRawIp(event) || "").slice(0, 64) || null;
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
      contact,
      createdAt: new Date(now).toISOString(),
      ip: reporterIp,
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
        contact: d.contact || null,
        createdAt: d.createdAt || null,
        ip: d.ip || null,
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

  // Bulk-delete every issue report. Admin-gated like all admin ops. Keys
  // come from the store listing itself (fixed feedback/ prefix), so there
  // is no id input to validate. Blobs-only: notify-mailbox copies are kept.
  async adminDeleteAllFeedback(s, p, event) {
    await needAdmin(s, p, event);
    const blobs = await listAll(s, "feedback/");
    await mapWithConcurrency(blobs, 12, (b) => s.delete(b.key).catch(() => null));
    return ok({ deleted: blobs.length });
  },

  // Diagnose mail notify from inside the app (Admin → Feedback → Send test
  // mail). Sends a real test message via the configured SMTP env and reports
  // the outcome. Never echoes credentials: only a short reason string.
  async adminTestFeedbackMail(s, p, event) {
    await needAdmin(s, p, event);
    const host = String(process.env.SMTP_HOST || "").trim() || null;
    const user = String(process.env.SMTP_USER || "").trim() || null;
    const pass = process.env.SMTP_PASS || null;
    if (!host || !user || !pass) {
      return fail(412, "failed-precondition", "Mail not configured: set SMTP_HOST, SMTP_USER and SMTP_PASS in Netlify env, then redeploy.");
    }
    const probe = {
      id: "test-mail",
      sessionId: "(admin test)",
      message: "Tunnel feedback mail is working. You can delete this message.",
      contact: null,
      createdAt: new Date().toISOString(),
      ip: null,
      ua: null,
    };
    const r = await sendFeedbackEmail(probe, s);
    if (r.ok) return ok({ sent: true });
    const reason = String(r.reason || "send-failed").slice(0, 200);
    const status = reason === "throttled" ? 429 : 502;
    const code = reason === "throttled" ? "resource-exhausted" : "unavailable";
    return fail(status, code, `Test mail failed: ${reason}. Check SMTP_HOST/PORT/user/password in Netlify env (redeploy after changing them) and the function logs.`);
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
    await deleteClickKeys(s, host, link.code);
    // Count shards must go too: totals are key-counted, so orphaned shards
    // would inflate a later link re-created under the same slug. Same bound
    // as deleteAllClicks (remainder ages out with no link to attribute to).
    try {
      const counts = await listAll(s, `counts/${(host || "").toLowerCase()}/${link.code}/`);
      await mapWithConcurrency(counts.slice(0, 500), 12, (b) => s.delete(b.key).catch(() => null));
    } catch { /* best effort */ }
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
    // Exact total: link-doc baseline + write-only shard delta (key-counted, no
    // body reads, lossless under concurrency). Badge clickCount stays approx.
    let clickCount = link.clickCount || 0;
    let daily = [];
    try {
      const countBlobs = await listAll(s, `counts/${(host || "").toLowerCase()}/${link.code}/`);
      const { delta, byDay } = sumShardsFromKeys(countBlobs);
      const base = link.baseCount !== undefined ? Number(link.baseCount) || 0 : (link.clickCount || 0);
      const hasShards = countBlobs.some((b) => String(b.key || "").split("/").length === 5);
      clickCount = hasShards ? base + delta : (link.clickCount || 0);
      // Daily graph: minute-shard grouping first; rolled-up day totals fill
      // days with no shards (never double-counted).
      const days = new Map(byDay);
      const dayAggs = countBlobs.filter((b) => String(b.key || "").split("/").length === 4).slice(-90);
      if (dayAggs.length) {
        const dayDocs = await mapWithConcurrency(dayAggs, 6, (b) =>
          freshGet(s, b.key, { type: "json" }).catch(() => null)
        );
        dayAggs.forEach((b, i) => {
          const day = String(b.key || "").split("/").pop();
          if (day && !days.has(day)) days.set(day, Number(dayDocs[i]?.count) || 0);
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
    if (!p.clickId || typeof p.clickId !== "string" || p.clickId.length > 80 || !/^[A-Za-z0-9._-]+$/.test(p.clickId) || p.clickId.includes("..")) {
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
    // Two passes close the race where a link is minted mid-merge.
    let links = [];
    for (let pass = 0; pass < 2; pass++) {
      const batch = (await listLinksOfSession(s, oldSessionId)).filter(
        (l) => !links.some((k) => k.code === l.code && (k.domain || "") === (l.domain || ""))
      );
      if (!batch.length) break;
      await mapWithConcurrency(batch, 12, (l) => {
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
      links = links.concat(batch);
    }
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
      return s.setJSON(`domain/${d.domain}`, d);
    });
    const outgoingClaims = domainDocs.filter((d) => d && d.pendingClaim && d.pendingClaim.sessionId === oldSessionId && d.sessionId !== newSessionId);
    await mapWithConcurrency(outgoingClaims, 12, (d) => {
      d.pendingClaim.sessionId = newSessionId;
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
    // Pending takeovers in flight: foreign docs this session claimed but not
    // yet verified must still show up (otherwise the claim is invisible and
    // its TXT token undiscoverable after a refresh). Slim view only — owner
    // payment/coverage state is none of the claimant's business, while the
    // pending token is the claimant's own and must persist verbatim.
    for (const d of docs) {
      if (!d || d.sessionId === p.sessionId || !d.pendingClaim || d.pendingClaim.sessionId !== p.sessionId) continue;
      out.push({
        domain: d.domain,
        id: d.domain,
        displayName: d.domain,
        mode: "claim",
        status: "pending_verification",
        paymentStatus: "unpaid",
        isVerified: false,
        coverageExpiresAt: null,
        coverageLifetime: false,
        coverageValid: false,
        apexTarget: null,
        isApexFlow: d.isApexFlow === true,
        apex: (typeof d.apexSource === "string" && d.apexSource) ? d.apexSource : null,
        apexInstructions: null,
        fallback: null,
        dnsVerification: d.dnsVerification || null,
        dnsVerificationToken: null,
        verificationToken: null,
        pendingClaim: { byYou: true, at: (d.pendingClaim && d.pendingClaim.at) || null },
        pendingToken: d.pendingClaim.token,
        claimPending: true,
        sslVerification: { status: "pending", hostnameStatus: null },
        cloudflare: { configured: !!cfConfig(), hostnameId: null, hostnameStatus: null, sslStatus: null },
        instructions: {
          cnameTarget: routingTarget(),
          recordName: d.domain,
          isApex: await isApexDomain(d.domain),
          txtHost: `verification.${d.domain}`,
          txt: d.pendingClaim.token,
          routingTarget: routingTarget(),
        },
      });
    }
    // Twin surfacing: two own setups sharing one display label (legacy or
    // residual rows predating the creation guards) would otherwise render as
    // two identical rows with no way to tell them apart. Flag them so the UI
    // can explain and offer per-row Manage (which routes by canonical host).
    // Never auto-merge: touched twins may hold distinct links/value.
    try {
      const seen = new Map();
      for (const info of out) {
        const label = String(info.displayName || info.domain || "").toLowerCase();
        if (!label) continue;
        const canon = String(info.domain || "").toLowerCase();
        if (!seen.has(label)) seen.set(label, new Set());
        seen.get(label).add(canon);
      }
      const twinLabels = new Set([...seen.entries()].filter(([, v]) => v.size > 1).map(([k]) => k));
      if (twinLabels.size) {
        for (const info of out) {
          if (twinLabels.has(String(info.displayName || info.domain || "").toLowerCase())) {
            info.twin = true;
          }
        }
      }
      return ok({ domains: out, twins: [...twinLabels] });
    } catch {
      return ok({ domains: out });
    }
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

  // Contact-email reveal (Terms page): the address lives only in env, never
  // in served files, and is disclosed solely after a valid Turnstile token —
  // static scrapers see nothing, scripted harvesters hit the challenge wall.
  // Rate-limited; availability wins over strictness (a contact address must
  // stay reachable, so a missing Turnstile secret degrades to rate-limit).
  async getContactEmail(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "contact", ip, 5))) {
      const e = new Error("Too many attempts, wait a moment and try again.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    if (process.env.TURNSTILE_SECRET) {
      const v = await verifyTurnstileToken(p.turnstileToken, trustedRawIp(event));
      if (!v.ok) return fail(412, "failed-precondition", "Human verification required — solve the challenge and try again.");
    }
    // Env-only on purpose (no hardcoded fallback): the address must not
    // appear anywhere in served or bundled files where scrapers could find
    // it. Set CONTACT_EMAIL in Netlify env, then redeploy.
    const email = String(process.env.CONTACT_EMAIL || "").trim();
    if (!email || /[\r\n<>]/.test(email) || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(412, "failed-precondition", "Contact channel is not configured right now — try the in-app Report page instead.");
    }
    return ok({ email });
  },

  async addCustomDomain(s, p, event) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    try { await bumpKindCounter(s, "domain-add", clientIp(event)); } catch { /* ignore */ }
    await requireTurnstile(s, p, event, "domain");
    const rawHost = cleanDomain(p.domain);
    if (!rawHost) return fail(400, "invalid-argument", "Invalid domain name.");
    // Primary vs fallback (paired) modes:
    // - Primary (default): every hostname is independent. example.com and
    //   www.example.com are separate docs with separate payments/link spaces.
    //   ALIAS/ANAME/flattened CNAME all satisfy routing (see verifyDns).
    // - Fallback (paired, IP safety net): a single www doc covers apex+www via
    //   apex A/AAAA redirect + www CNAME. Entered explicitly via
    //   p.fallback===true / p.mode==='fallback', or via the legacy apexSource
    //   pairing param (old UI sent it for apex inputs). displayName preserves
    //   exactly what the user typed on the first screen.
    let host = rawHost;
    let displayName = rawHost;
    let apexSource = null;
    let isApexFlow = false;
    const fallbackRequested =
      p.fallback === true || p.mode === "fallback" || p.useFallback === true;
    // Explicit redirect intent (new UI sends the typed host as apexSource):
    // valid when it pairs exactly with the host under the uniform rule
    // (host === www.redirect). Legacy apex sources keep working through the
    // same check whenever psl agrees they are registrable apexes.
    const paramApex = cleanDomain(p.apexSource);
    let redirectPairsHost = false;
    try {
      if (paramApex && fallbackCanonicalFor(paramApex) === host) {
        redirectPairsHost = true;
      }
    } catch { /* pairing ignored */ }
    // Legacy apex validated the old way (kept for old callers sending
    // apexSource without a fallback flag).
    let paramApexValid = false;
    try {
      if (paramApex && (await isApexDomain(paramApex).catch(() => false)) && wwwForApex(paramApex) === host) {
        paramApexValid = true;
      }
    } catch { /* pairing ignored */ }
    if (fallbackRequested) {
      // Uniform rule: pair (X, www.X) for whatever X was entered. The redirect
      // host X takes A/AAAA to the redirect edge; the canonical www.X takes
      // the routing record. Only names derived from the entered host are ever
      // touched — never another zone's apex.
      try {
        if (redirectPairsHost) {
          apexSource = paramApex;
          // Record what the user actually typed: X entry shows X, www entry
          // shows www. The optional p.display is constrained to the two hosts
          // of this pairing (never trusted blindly); callers without it keep
          // the redirect host as display.
          const wantDisplay = cleanDomain(p.display);
          displayName = (wantDisplay && (wantDisplay === host || wantDisplay === paramApex))
            ? wantDisplay
            : paramApex;
          isApexFlow = true;
        } else {
          const X = rawHost;
          const canonical = fallbackCanonicalFor(X);
          if (!canonical) return fail(400, "invalid-argument", "Invalid domain name.");
          apexSource = X;
          displayName = rawHost;
          host = canonical;
          isApexFlow = true;
        }
      } catch { /* fail-open to host as typed */ }
    } else if (paramApexValid && paramApex) {
      // Legacy apex branch without explicit fallback flag (old UI): preserve
      // the paired behavior so existing flows never break.
      apexSource = paramApex;
      host = wwwForApex(paramApex) || host;
      displayName = rawHost;
      isApexFlow = true;
    }
    // Only tunnel. (app) and s. (short links) are system hosts, plus the SaaS
    // infrastructure names. Everything else is a customer domain — including
    // other *.inoculens.com names, which route and validate exactly like
    // external domains (CNAME/ALIAS/ANAME/flattened to the SaaS target).
    // Apex and www are independent primaries: each needs its own doc/payment.
    const reserved = new Set([systemShortHost(), routingTarget(), "tunnel.inoculens.com", "customers.inoculens.com", "proxy-fallback.inoculens.com", "inoculens.com", "www.inoculens.com"]);
    if (reserved.has(host) || (apexSource && reserved.has(apexSource)) || reserved.has(displayName)) return fail(400, "invalid-argument", "This domain is reserved for INOCULENS infrastructure.");
    // Bare public suffixes (co.uk, com, …) are not registrable and can never
    // verify — reject instead of creating an uncompletable setup.
    try {
      if (await isPublicSuffix(host).catch(() => false)) return fail(400, "invalid-argument", "That address is a public suffix, not a domain you can own. Use your own domain (e.g. example.com) instead.");
    } catch { /* fail-open: suffix check never blocks registration */ }
    // Primary apex docs (example.com as its own host) follow the standard flow
    // (routing + TXT gating, payment). Fallback pairing additionally requires
    // the apex A/AAAA redirect before payment (client-side Continue gating).
    if (!(await getSession(s, p.sessionId))) {
      await s.setJSON(`sessions/${p.sessionId}`, { createdAt: Date.now() });
    }
    // Fallback dedupe helper: entering fallback from an apex primary
    // (example.com) creates the www pair (www.example.com) displaying the same
    // apex label. A pristine apex primary (same session, no DNS proof, no
    // payment, no payment address shown, no promo, no links) is retired so
    // Manage never lists two identical entries. Strictly fail-closed: anything
    // touched (verified, paid, quoted, discounted, claimed, linked) is kept —
    // the user then owns two genuinely independent setups by design.
    const retirePristinePrimary = async (primaryHost) => {
      try {
        if (!primaryHost || primaryHost === host) return false;
        const primaryDoc = await freshGet(s, `domain/${primaryHost}`, { type: "json" });
        const pristine =
          primaryDoc &&
          primaryDoc.sessionId === p.sessionId &&
          primaryDoc.paymentStatus !== "paid" &&
          primaryDoc.isVerified !== true &&
          primaryDoc.status === "pending_verification" &&
          !primaryDoc.pendingClaim &&
          !primaryDoc.discount &&
          !primaryDoc.quote?.address &&
          !(Array.isArray(primaryDoc.quoteHistory) && primaryDoc.quoteHistory.length) &&
          !coverageValid(primaryDoc);
        if (!pristine) return false;
        let hasLinks = false;
        try {
          const blobs = await listAll(s, "link/");
          for (const b of blobs) {
            const k = String(b.key || "");
            if (k.startsWith(`link/${primaryHost}/`)) {
              const l = await freshGet(s, k, { type: "json" }).catch(() => null);
              if (l) { hasLinks = true; break; }
            }
          }
        } catch { hasLinks = true; /* fail-closed: keep on read error */ }
        if (hasLinks) return false;
        try {
          if (cfConfig()) await cfDeleteCustomHostname(primaryHost).catch(() => null);
        } catch { /* best effort */ }
        await s.delete(`domain/${primaryHost}`);
        return true;
      } catch { /* dedupe best-effort, never blocks */ }
      return false;
    };
    // Silent retires must be visible to the UI: without this flag the frontend
    // keeps just-created markers (and selections) for a host that no longer
    // exists, painting ghost rows that 404 on click.
    let retiredHost = null;
    if (isApexFlow && apexSource && (await retirePristinePrimary(apexSource))) retiredHost = apexSource;
    // Effective display label, shared by the twin guards below and the
    // display-based claim routing (single rule: effectiveDisplayLabel).
    const docDisplay = (displayName || host).toLowerCase();
    const twinLabelOf = (d) => effectiveDisplayLabel(d);
    const existing = await freshGet(s, `domain/${host}`, { type: "json" });
    // Twin state: same-session primary on the redirect host carrying value.
    // Pairing must never implicitly take over such a setup (its DNS serves
    // live links) — stamping skips it, creation refuses it, conversion moves
    // it only on explicit user confirmation. Computed once, reused below.
    let twinDoc = null;
    let twinTouched = false;
    if (isApexFlow && apexSource && host !== apexSource) {
      const d = await freshGet(s, `domain/${apexSource}`, { type: "json" }).catch(() => null);
      if (d && d.sessionId === p.sessionId) {
        twinDoc = d;
        twinTouched = d.isVerified === true || d.paymentStatus === "paid" ||
          !!d.quote?.address || (Array.isArray(d.quoteHistory) && d.quoteHistory.length > 0) ||
          !!d.discount || !!d.pendingClaim || coverageValid(d);
        if (!twinTouched) {
          try {
            const blobs = await listAll(s, "link/");
            for (const b of blobs) {
              if (String(b.key || "").startsWith(`link/${apexSource}/`)) {
                const l = await freshGet(s, b.key, { type: "json" }).catch(() => null);
                if (l) { twinTouched = true; break; }
              }
            }
          } catch { twinTouched = true; /* fail-closed */ }
        }
      }
    }
    // Convert: explicit user-confirmed migration of the touched primary into
    // the pair (no new payment, links/stats/coverage move). Only when the
    // canonical is free; a pending claim must resolve first; an owned
    // canonical setup can never be merged into.
    if (p.convert === true && fallbackRequested && isApexFlow && apexSource && host !== apexSource && twinDoc) {
      if (existing && existing.sessionId === p.sessionId) {
        const samePair = existing.isApexFlow === true && (existing.apexSource || "").toLowerCase() === apexSource.toLowerCase();
        if (samePair) return ok(await domainInfo(existing, p.sessionId)); // nothing to convert
        return fail(409, "already-exists", `${host} is already set up on its own — delete one of the two setups first.`);
      }
      if (!existing) {
        if (twinDoc.pendingClaim) {
          return fail(409, "failed-precondition", `A takeover claim is pending on ${apexSource} — resolve it first.`);
        }
        if (twinTouched) {
          const dest = await migrateDomainSetup(s, p, twinDoc, apexSource, host, { display: displayName || apexSource, paired: true, redirect: apexSource });
          return ok({ ...(await domainInfo(dest, p.sessionId)), converted: true, retired: apexSource });
        }
        // Pristine → fall through (dedupe retired it; normal create below).
      }
      // Foreign canonical → fall through to pendingClaim handling below.
    }
    // Stamp fallback pairing onto docs missing it — owner sessions ONLY, and
    // never over a touched twin (that would hijack its live DNS config).
    // A stranger's fallback input must never mutate another session's doc (no
    // card flips, no new payment gates for the owner). Claimants stamp at
    // transfer time instead (see verifyClaimedDomainDns), once proven.
    // displayName is write-once (first entry wins) so the list always shows
    // what the user originally typed.
    if (existing && isApexFlow && !existing.isApexFlow && apexSource && existing.sessionId === p.sessionId && !twinTouched) {
      existing.isApexFlow = true;
      existing.apexSource = apexSource;
      if (!existing.displayName) existing.displayName = displayName || host;
      try { await s.setJSON(`domain/${host}`, existing); } catch { /* ignore */ }
    }
    if (existing && !existing.displayName) {
      // Self-heal legacy docs: fallback docs entered via apex show the apex,
      // primaries show their canonical host. Owner-only write, best effort.
      if (existing.sessionId === p.sessionId) {
        try {
          existing.displayName = (existing.isApexFlow && existing.apexSource) ? existing.apexSource : existing.domain;
          await s.setJSON(`domain/${host}`, existing);
        } catch { /* display-only, ignore */ }
      }
    }
    // Self-heal pre-existing duplicates: reopening a paired www doc retires a
    // pristine apex primary left behind by an earlier fallback entry, so the
    // list converges back to one entry without the user deleting anything.
    if (existing && existing.isApexFlow && existing.sessionId === p.sessionId) {
      if (await retirePristinePrimary(existing.apexSource || apexSource || null)) {
        retiredHost = retiredHost || existing.apexSource || apexSource || null;
      }
    }
    if (existing) {
      if (existing.sessionId !== p.sessionId) {
        // Secure reclaim: ownership NEVER transfers here. A pending claim is
        // recorded (last claim wins across sessions) with its own TXT token.
        // Stable per session: re-entering (reopen, pricing Continue, Manage)
        // reuses the claimant's existing token instead of rotating it — every
        // rotation voids the TXT the user may already have added, making
        // verification deterministically impossible. The token changes only
        // when a different session claims or the claimant abandons it.
        // Old owner keeps full rights (mint/delete/manage) until claimant
        // proves DNS via verifyClaimedDomainDns. Claimant gets zero
        // destructive rights until then — no delete, no mint, no payment.
        // Links move only on verified transfer (with stats, since clicks/ are
        // host/code keyed).
        if (!existing.pendingClaim || existing.pendingClaim.sessionId !== p.sessionId) {
          existing.pendingClaim = {
            sessionId: p.sessionId,
            token: newToken(32),
            at: new Date().toISOString(),
          };
          await s.setJSON(`domain/${host}`, existing);
        }
        const route = routingTarget();
        return ok({
          ...(await domainInfo(existing, p.sessionId)),
          pendingClaim: true,
          ...(retiredHost ? { retired: retiredHost } : {}),
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
      // Idempotent re-entry (a retire may still have happened above).
      return ok({ ...(await domainInfo(existing, p.sessionId)), ...(retiredHost ? { retired: retiredHost } : {}) });
    }
    // Display-based claim routing: no doc on the typed host, but a foreign
    // setup displays exactly the typed label (e.g. typed apex.com, paired
    // www.apex.com displaying it). Route the claim there — payment, coverage,
    // and links move with the setup on transfer — instead of forking an empty
    // primary that must be paid for again. Own docs are excluded (exact path
    // + clash guard own that case). Last-wins across sessions, stable per
    // session, exactly like exact-host claims.
    try {
      const blobs = await listAll(s, "domain/");
      const docs = await mapWithConcurrency(blobs, 12, (b) =>
        freshGet(s, b.key, { type: "json" }).catch(() => null)
      );
      const foreign = docs.find((d) =>
        d && d.sessionId !== p.sessionId && twinLabelOf(d) === docDisplay);
      if (foreign) {
        if (!foreign.pendingClaim || foreign.pendingClaim.sessionId !== p.sessionId) {
          foreign.pendingClaim = {
            sessionId: p.sessionId,
            token: newToken(32),
            at: new Date().toISOString(),
          };
          await s.setJSON(`domain/${foreign.domain}`, foreign);
        }
        const route = routingTarget();
        return ok({
          ...(await domainInfo(foreign, p.sessionId)),
          pendingClaim: true,
          ...(retiredHost ? { retired: retiredHost } : {}),
          pendingToken: foreign.pendingClaim.token,
          instructions: {
            cnameTarget: route,
            recordName: foreign.domain,
            txtHost: `verification.${foreign.domain}`,
            txt: foreign.pendingClaim.token,
            routingTarget: route,
          },
        });
      }
    } catch { /* fail-open to creation below */ }
    // Twin policy (simplified per product decision): apex and www are
    // independent primaries and may coexist in one session even when they
    // share a display label (e.g. an apex primary plus a fallback pair
    // displaying the same apex). No 409, no displayConflict redirect — DNS
    // itself decides which setup can verify (a single apex host cannot carry
    // both a routing record and a redirect pair at once, so "routing will not
    // happen anyways if the user tries both"). The UI flags same-label twins
    // as a warning (see getUserDomains twins) instead of blocking creation.
    // Convert remains as an explicit, no-new-payment migration for users who
    // want to consolidate, but it is never forced.
    const delegation = sslDelegationTarget();
    const doc = {
      domain: host,
      displayName: displayName || host,
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
      ...(isApexFlow ? { isApexFlow: true, apexSource } : {}),
    };
    await s.setJSON(`domain/${host}`, doc);
    return ok({ ...(await domainInfo(doc, p.sessionId)), ...(retiredHost ? { retired: retiredHost } : {}) });
  },

  // Apex redirect check: live DNS read for the caller's OWN doc.
  // Fail-closed: anonymous callers and non-owners are rejected before any
  // outbound DNS happens (no free oracle, no shared-DoH-quota burn).
  // Method-agnostic: paired docs check their stored redirect host; unpaired
  // primaries check the most plausible redirect host instead of erroring, so
  // a setup can move between recommended and fallback in either direction
  // regardless of how it was first verified. An explicit client redirect is
  // honored only when it belongs to this setup (the doc host itself or its
  // uniform www pairing) — never a stranger's zone.
  // Results cache briefly (positives 5 min, negatives 60 s) so repeat clicks
  // and floods don't re-hit the shared resolver. Never writes domain docs.
  // Required before payment in apex flows (client-side Continue gating).
  async verifyApexRedirect(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "apex-check", ip, 5))) {
      const e = new Error("Too many attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    // Throws 400/404/403 unless the caller owns this doc.
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    const stored = (typeof doc.apexSource === "string" && doc.apexSource) || null;
    const derived = doc.isApexFlow === true ? apexForWww(doc.domain) : null;
    const paramR = cleanDomain(p.apex);
    let paramOk = false;
    try {
      if (paramR && (paramR === doc.domain.toLowerCase() || fallbackCanonicalFor(paramR) === doc.domain.toLowerCase() || (stored && paramR === stored.toLowerCase()) || fallbackCanonicalFor(doc.domain.toLowerCase()) === paramR)) {
        paramOk = true;
      }
    } catch { /* ignore */ }
    // Paired docs keep their stored redirect; primaries fall back to an
    // explicit valid intent, else their own host (fallback on X redirects X).
    // Never 400 for "not paired" — that locked recommended-first setups out
    // of the fallback path and vice versa.
    const apex = stored || derived || (paramOk ? paramR : null) || doc.domain;
    if (!apex) return fail(400, "invalid-argument", "Could not determine the redirect host for this setup.");
    const wwwHost = doc.domain;
    const cacheKey = `apexcheck/${apex}`;
    let r = null;
    try {
      const cached = await freshGet(s, cacheKey, { type: "json" }).catch(() => null);
      if (cached && cached.at && cached.result) {
        const age = Date.now() - cached.at;
        const ttl = cached.result.aValid && cached.result.aaaaValid ? 5 * 60 * 1000 : 60 * 1000;
        if (age >= 0 && age < ttl) r = cached.result;
      }
    } catch { /* cache miss: live lookup below */ }
    if (!r) {
      r = await verifyApexRedirectDns(apex).catch(() => null);
      if (r) {
        try { await s.setJSON(cacheKey, { at: Date.now(), result: r }); } catch { /* cache best-effort */ }
      }
    }
    if (!r) return fail(502, "unavailable", "DNS lookup failed, try again.");
    return ok({ apex, www: wwwHost, ...r, ok: r.aValid && r.aaaaValid });
  },

  // Exit fallback pairing: back to the recommended DNS setup (CNAME / ALIAS /
  // ANAME / flattened CNAME directly on the entered host), no delete-and-restart.
  // The entered host is fixed in stone: exit always restores it, never the
  // canonical. Owner-only, never destructive to anything of value:
  // - Own primary still exists on the redirect host, or entry was via the
  //   canonical: unpair in place. Same doc, same TXT token (already-added TXT
  //   stays valid), verification / payment / coverage untouched.
  // - Otherwise the entered host is restored via migration (pristine or
  //   touched alike — links, stats, coverage, quotes all move back, no new
  //   payment), so nothing is ever orphaned on the retired host. A foreign
  //   occupant on the entered host can never be displaced — exit then keeps
  //   the setup working under its canonical.
  async exitFallbackMode(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "exit-fallback", ip, 10))) {
      const e = new Error("Too many attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    if (doc.isApexFlow !== true) return ok(await domainInfo(doc, p.sessionId)); // already primary
    const apex = (typeof doc.apexSource === "string" && doc.apexSource) || apexForWww(doc.domain);
    // Effective display (same rule as domainInfo): the stored name when set,
    // else the apex for paired docs. Legacy paired docs predate the stored
    // field, so reading the raw field alone would misroute them as www-entered.
    const effDisplay = ((typeof doc.displayName === "string" && doc.displayName) ? doc.displayName : null) ||
      (doc.isApexFlow === true && apex ? apex : doc.domain);
    const enteredViaApex = !!apex &&
      effDisplay.toLowerCase() === apex.toLowerCase() &&
      doc.domain.toLowerCase() !== apex.toLowerCase();
    let apexPrimary = null;
    if (apex && apex.toLowerCase() !== doc.domain.toLowerCase()) {
      apexPrimary = await freshGet(s, `domain/${apex}`, { type: "json" }).catch(() => null);
    }
    const ownApexPrimary = apexPrimary && apexPrimary.sessionId === p.sessionId ? apexPrimary : null;
    if (ownApexPrimary || !enteredViaApex) {
      doc.isApexFlow = false;
      delete doc.apexSource;
      // Avoid twin labels with the surviving apex entry.
      if (ownApexPrimary && effDisplay.toLowerCase() === (apex || "").toLowerCase()) {
        doc.displayName = doc.domain;
      }
      if (!doc.displayName) doc.displayName = doc.domain;
      await s.setJSON(`domain/${doc.domain}`, doc);
      return ok(await domainInfo(doc, p.sessionId));
    }
    // Entered via the redirect host and no own primary exists there: restore
    // the entered host as a primary so the registered name never morphs into
    // the canonical. Setup state reverse-migrates (coverage, quotes, no new
    // payment); links stay on their minted host (set in stone) and keep
    // working + listing under this entry either way. Either way the redirect
    // host must be free — a foreign occupant can never be displaced, so exit
    // then keeps this setup working under its canonical instead (function
    // preserved, label bent).
    if (doc.pendingClaim) {
      return fail(409, "failed-precondition", "A takeover claim is pending on this setup — resolve it first.");
    }
    if (apexPrimary) {
      doc.isApexFlow = false;
      delete doc.apexSource;
      doc.displayName = doc.domain;
      await s.setJSON(`domain/${doc.domain}`, doc);
      return ok({ ...(await domainInfo(doc, p.sessionId)), relabeled: true });
    }
    // Defense in depth: the restored host is re-validated like a fresh
    // registration (registrable, unreserved, not a public suffix), even
    // though it paired successfully on entry.
    const reservedExit = new Set([systemShortHost(), routingTarget(), "tunnel.inoculens.com", "customers.inoculens.com", "proxy-fallback.inoculens.com", "inoculens.com", "www.inoculens.com"]);
    if (!apex || !cleanDomain(apex) || reservedExit.has(apex.toLowerCase()) || (await isPublicSuffix(apex).catch(() => false))) {
      return fail(400, "invalid-argument", "That address can no longer be restored — delete the domain and re-add it instead.");
    }
    // Restore via migration in all cases (pristine or touched): setup state
    // moves to the entered host while links stay on their minted host (set
    // in stone) — history rows can never flip to a host the user never
    // picked, and nothing is orphaned (rows keep serving + listing).
    const dest = await migrateDomainSetup(s, p, doc, doc.domain, apex, { display: apex, paired: false, redirect: null });
    return ok({ ...(await domainInfo(dest, p.sessionId)), restored: true });
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
  // instructions without leaking payment/quote state. Mirrors the add-flow:
  // routing accepts CNAME/ALIAS/ANAME/flattened, fallback pairing via apex.
  async getClaimVerificationInfo(s, p) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    const host = cleanDomain(p.domain);
    if (!host) return fail(400, "invalid-argument", "Invalid domain name.");
    let doc = await getWithRetry(s, `domain/${host}`, { type: "json" }, { attempts: 3, delayMs: 350 });
    if (!doc || !doc.pendingClaim || doc.pendingClaim.sessionId !== p.sessionId) {
      // Display resolution: the claim can live on a setup displaying the
      // typed label (paired www doc) while the typed host itself holds no
      // doc — the modal proves the typed label first, same as adding fresh.
      try {
        const blobs = await listAll(s, "domain/");
        const docs = await mapWithConcurrency(blobs, 12, (b) =>
          freshGet(s, b.key, { type: "json" }).catch(() => null)
        );
        const mine = docs.find((d) =>
          d && d.pendingClaim && d.pendingClaim.sessionId === p.sessionId &&
          effectiveDisplayLabel(d) === host);
        if (mine) doc = mine;
      } catch { /* fall through to 404 */ }
    }
    if (!doc || !doc.pendingClaim || doc.pendingClaim.sessionId !== p.sessionId) {
      return fail(404, "not-found", "No pending claim for this session.");
    }
    const route = routingTarget();
    const info = await domainInfo(doc, p.sessionId);
    return ok({
      domain: doc.domain,
      displayName: info.displayName || doc.domain,
      isApexFlow: info.isApexFlow === true,
      apex: info.apex || null,
      apexInstructions: info.apexInstructions || null,
      fallback: info.fallback || null,
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
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    const host = cleanDomain(p.domain);
    if (!host) return fail(400, "invalid-argument", "Invalid domain name.");
    const doc = await getWithRetry(s, `domain/${host}`, { type: "json" }, { attempts: 3, delayMs: 350 });
    if (!doc || !doc.pendingClaim || doc.pendingClaim.sessionId !== p.sessionId) {
      return fail(404, "not-found", "No pending claim for this session.");
    }
    // Per-field check mode (claim modal Verify buttons): reports ONLY the
    // requested record live — same badge lifecycle as the main verification
    // screen — and never transfers or mutates anything. Turnstile stays on
    // the transfer path below (every click still feeds the pace counter
    // above, so a burst still challenges at transfer). Checks are fixed to
    // this doc's records (public DNS anyway), so no oracle is opened.
    // Fallback intent for this claim: an explicit redirect host that is either
    // the claimed host itself (banner path: pair X with a new www.X) or pairs
    // with it as canonical (enter-fallback path: stamp the pair in place).
    // Anything else is ignored (never trusted for pairing).
    const pairedDoc = doc.isApexFlow === true;
    const storedRedirect = (typeof doc.apexSource === "string" && doc.apexSource) || null;
    const intentR = cleanDomain(p.apexSource);
    const intentValid = !!intentR && (intentR === doc.domain || fallbackCanonicalFor(intentR) === doc.domain);
    // Redirect host for intent mode: explicit when valid, else the claimed
    // host itself for bare-flag calls. An explicit but non-pairing apexSource
    // (e.g. stale client state) disables intent rather than migrating blindly.
    const intentHost = intentValid ? intentR : ((p.fallback === true && !pairedDoc && !intentR) ? doc.domain : null);
    const useIntent = !!intentHost;
    const claimField = p.field === "cname" || p.field === "txt" || p.field === "apex" ? p.field : null;
    if (claimField) {
      // Redirect host: stored pairing wins; otherwise the validated intent
      // (for intent on the claimed host itself, that host IS the redirect).
      // Method-agnostic: a primary without intent falls back to its own host
      // (fallback on X redirects X) instead of 400ing — the UI then reports
      // a normal Failed/Verified badge and Verify Claim stays gated on the
      // visible pills, so recommended-first setups can move either way.
      let redirect = storedRedirect || (pairedDoc ? apexForWww(doc.domain) : null);
      if (!redirect && useIntent) redirect = intentHost;
      if (!redirect) redirect = doc.domain;
      if (claimField === "apex") {
        const ar = await verifyApexRedirectDns(redirect).catch(() => null);
        if (!ar) return fail(503, "unavailable", "DNS lookup failed, try again.");
        return ok({
          success: false,
          field: "apex",
          isVerified: false,
          ...(pairedDoc ? { isApexFlow: true } : {}),
          apex: redirect,
          checks: { cname: null, txt: null, apex: ar.aValid === true && ar.aaaaValid === true },
          status: doc.status,
        });
      }
      // Routing host follows the intent: the www canonical when pairing a
      // fresh redirect host, a recommended pair proves its typed (redirect)
      // host — same records as adding it fresh — else the claimed host.
      // Ownership (TXT) follows the same host on paired setups; unpaired
      // setups ALWAYS prove TXT on the claimed host itself (the migrate
      // transfer checks TXT on X while routing on www.X — proving TXT on
      // www.X instead made green badges fail transfer deterministically).
      // An explicit check host from the modal (the row it actually shows) is
      // honored when it belongs to this setup (canonical, redirect, or the
      // www canonical derived from either); anything else falls back to the
      // computed host. Check-only: no state changes here.
      const redirectHost0 = storedRedirect || (pairedDoc ? apexForWww(doc.domain) : null);
      const allowedChecks = new Set([doc.domain.toLowerCase()]);
      if (redirectHost0) allowedChecks.add(redirectHost0.toLowerCase());
      try {
        const w1 = fallbackCanonicalFor(doc.domain);
        if (w1) allowedChecks.add(w1.toLowerCase());
        if (redirectHost0) {
          const w2 = fallbackCanonicalFor(redirectHost0);
          if (w2) allowedChecks.add(w2.toLowerCase());
        }
      } catch { /* computed hosts below */ }
      const rawCheck = cleanDomain(p.checkHost);
      const checkedHost = (rawCheck && allowedChecks.has(rawCheck.toLowerCase())) ? rawCheck.toLowerCase() : null;
      let routeHost = doc.domain;
      if (!pairedDoc && useIntent && intentHost === doc.domain) {
        routeHost = fallbackCanonicalFor(doc.domain);
        if (!routeHost) return fail(400, "invalid-argument", "Fallback pairing is not available for that address.");
      } else if (pairedDoc && !useIntent && redirectHost0) {
        routeHost = redirectHost0;
      }
      const txtHost = pairedDoc ? routeHost : doc.domain;
      const live = await verifyDns(checkedHost || (claimField === "txt" ? txtHost : routeHost), doc.pendingClaim.token, claimField).catch(() => ({
        cname: false, txt: false, ssl: false, routable: null, cfHostnameStatus: null,
        cfSslStatus: null, routingMethod: null, routingUnknown: true, txtUnknown: true,
      }));
      const stale =
        (claimField === "cname" && live.routingUnknown === true) ||
        (claimField === "txt" && live.txtUnknown === true);
      const normRoutable = live.routable === false ? false : live.routable === true ? true : null;
      return ok({
        success: false,
        field: claimField,
        ...(stale ? { stale: true } : {}),
        isVerified: false,
        ...(pairedDoc ? { isApexFlow: true, apex: storedRedirect || apexForWww(doc.domain) } : {}),
        ...(useIntent && !pairedDoc ? { isApexFlow: true, apex: intentHost } : {}),
        checks: {
          cname: claimField === "cname" ? !!live.cname : null,
          txt: claimField === "txt" ? !!live.txt : null,
          apex: null,
          routable: claimField === "cname" ? normRoutable : null,
          ...(claimField === "cname" ? { routingMethod: live.routingMethod || null } : {}),
        },
        status: doc.status,
      });
    }
    await requireTurnstile(s, p, event, "claim");
    if (!(await getSession(s, p.sessionId))) {
      await s.setJSON(`sessions/${p.sessionId}`, { createdAt: Date.now() });
    }
    // Proof host: a recommended claim on a paired setup proves the typed
    // (redirect) host itself — same records as adding it fresh — then the
    // setup exit-migrates to a primary there (branch below). Fallback claims
    // prove the doc host. Unpaired claims always prove the doc host.
    const redirectHostFull = storedRedirect || (pairedDoc ? apexForWww(doc.domain) : null);
    const recommendedPair = pairedDoc && !(p.fallback === true) && !useIntent && !!redirectHostFull;
    const proofHost = recommendedPair ? redirectHostFull : doc.domain;
    const live = await verifyDns(proofHost, doc.pendingClaim.token).catch(() => ({
      cname: false, txt: false, ssl: false, routable: null, routingMethod: null, alias: false,
      routingUnknown: true, txtUnknown: true,
    }));
    // DNS outage during transfer is UNKNOWN, not proof of absence: report
    // stale so the UI keeps badges instead of failing the claim.
    if (live.routingUnknown === true && live.txtUnknown === true) {
      return ok({
        success: false,
        isVerified: false,
        stale: true,
        checks: { cname: false, txt: false, routable: null, routingMethod: null },
        status: doc.status,
      });
    }
    // Pairing is doc-driven under the uniform rule: an already-paired doc
    // requires its stored redirect host too; unpaired docs need routing +
    // TXT only. Claimant intent params can no longer add a pairing (that
    // would bind a foreign zone apex) — they are accepted but ignored.
    const claimApexFlow = doc.isApexFlow === true;
    const claimApexHost = (typeof doc.apexSource === "string" && doc.apexSource) ||
      (claimApexFlow ? apexForWww(doc.domain) : null);
    // Plain-claim gate only. The migrate case below proves split hosts (TXT on
    // X, routing on www.X) with its own checks — letting this full check on X
    // alone reject first made green per-field badges fail transfer
    // deterministically (X correctly carries A records, never a CNAME).
    const isMigrateCase = useIntent && !pairedDoc && intentHost === doc.domain;
    if (!isMigrateCase && !(live.cname && live.txt)) {
      return ok({
        success: false,
        isVerified: false,
        // Carry fallback context only when the redirect was actually required
        // (opt-in above) so the UI names the true requirement set.
        ...(claimApexFlow && claimApexHost && (p.fallback === true || useIntent) ? { isApexFlow: true, apex: claimApexHost } : {}),
        checks: { cname: !!live.cname, txt: !!live.txt, routable: live.routable ?? null, routingMethod: live.routingMethod || null },
        status: doc.status,
      });
    }
    // Fallback gate for transfers: the redirect proof applies only when the
    // claimant opted into the fallback UI (fallback flag / valid intent).
    // An already-paired doc otherwise transfers on routing + TXT alone —
    // transfer changes store ownership, not DNS (records persist globally),
    // and A/AAAA rows at our own IPs carry no ownership signal. Forcing them
    // gave paired claims no recommended-first choice (same as first-time
    // add). Unpaired claims skip the gate entirely — routing via
    // CNAME/ALIAS/ANAME/flattened plus TXT is enough.
    if (claimApexFlow && (p.fallback === true || useIntent)) {
      if (claimApexHost) {
        const ar = await verifyApexRedirectDns(claimApexHost).catch(() => null);
        const apexOk = !!ar && ar.aValid === true && ar.aaaaValid === true;
        if (!apexOk) {
          return ok({
            success: false,
            isVerified: false,
            isApexFlow: true,
            apex: claimApexHost,
            checks: { cname: true, txt: true, apex: false, routable: live.routable ?? null, routingMethod: live.routingMethod || null },
            status: doc.status,
          });
        }
      }
    }
    // Same-label policy (simplified): twins are allowed — DNS decides which
    // setup can verify. Claim transfers never 409 on the claimant's own
    // labels; the UI flags twins as a warning instead. Helper kept for
    // diagnostics only.
    const ownLabelTaken = async (label) => {
      try {
        const blobs = await listAll(s, "domain/");
        const docs = await mapWithConcurrency(blobs, 12, (b) =>
          freshGet(s, b.key, { type: "json" }).catch(() => null)
        );
        const want = String(label || "").toLowerCase();
        return docs.some((d) => d && d.sessionId === p.sessionId &&
          String(d.domain || "").toLowerCase() !== doc.domain.toLowerCase() &&
          String(((typeof d.displayName === "string" && d.displayName) ? d.displayName : null) ||
            ((d.isApexFlow === true && d.apexSource) ? d.apexSource : null) ||
            d.domain || "").toLowerCase() === want);
      } catch { return false; }
    };
    // STAMP transfer (enter-fallback path: the claimed doc IS the canonical,
    // the redirect intent pairs with it). Full routing + TXT proof on the doc
    // plus the redirect on the intent host, then transfer in place and stamp
    // the pairing with the typed label. Falls through to the shared tail.
    if (useIntent && !pairedDoc && intentHost !== doc.domain) {
      const redirS = await verifyApexRedirectDns(intentHost).catch(() => null);
      const redirSOk = !!redirS && redirS.aValid === true && redirS.aaaaValid === true;
      if (!(live.cname && live.txt && redirSOk)) {
        return ok({
          success: false,
          isVerified: false,
          isApexFlow: true,
          apex: intentHost,
          checks: { cname: !!live.cname, txt: !!live.txt, apex: redirSOk, routable: live.routable ?? null, routingMethod: live.routingMethod || null },
          status: doc.status,
        });
      }
      // Twins allowed: no own-label 409 (see policy above).
      doc.isApexFlow = true;
      doc.apexSource = intentHost;
      doc.displayName = intentHost;
      // Fall through to the shared transfer tail below.
    }
    // Fallback-intent takeover of an unpaired doc: prove TXT on X (pending
    // token), routing on www.X (any method, no token needed), and the redirect
    // on X — then migrate everything into a new paired www.X doc owned by the
    // claimant. Coverage and payment state carry over exactly like a plain
    // takeover (no new payment). Refuses when the canonical is occupied.
    if (useIntent && !pairedDoc && intentHost === doc.domain) {
      const W = fallbackCanonicalFor(doc.domain);
      if (!W) return fail(400, "invalid-argument", "Fallback pairing is not available for that address.");
      const occupied = await freshGet(s, `domain/${W}`, { type: "json" }).catch(() => null);
      if (occupied) {
        return fail(409, "already-exists", `${W} is already set up — delete it or claim it first.`);
      }
      const X = doc.domain;
      const token = doc.pendingClaim.token;
      const [txtLive, routeLive] = await Promise.all([
        verifyDns(X, token, "txt").catch(() => ({ txt: false, txtUnknown: true })),
        verifyDns(W, null, "cname").catch(() => ({ cname: false, routable: null, routingMethod: null, routingUnknown: true })),
      ]);
      const redir = await verifyApexRedirectDns(X).catch(() => null);
      const redirOk = !!redir && redir.aValid === true && redir.aaaaValid === true;
      const routeOk = !!routeLive.cname;
      const txtOk = !!txtLive.txt;
      if (!(txtOk && routeOk && redirOk)) {
        return ok({
          success: false,
          isVerified: false,
          isApexFlow: true,
          apex: X,
          checks: {
            cname: routeOk,
            txt: txtOk,
            apex: redirOk,
            routable: routeLive.routable === false ? false : routeLive.routable === true ? true : null,
            routingMethod: routeLive.routingMethod || null,
          },
          status: doc.status,
        });
      }
      // Count links for session bookkeeping before the move.
      let movedCount = 0;
      try {
        const blobs = await listAll(s, "link/");
        for (const b of blobs) {
          if (!String(b.key || "").startsWith(`link/${X}/`)) continue;
          const l = await freshGet(s, b.key, { type: "json" }).catch(() => null);
          if (l && l.code) movedCount++;
        }
      } catch { /* best effort; bumps stay approximate */ }
      const fromSid = doc.sessionId;
      const dest = await migrateDomainSetup(s, p, doc, X, W, { display: X, paired: true, redirect: X });
      dest.verificationToken = token;
      dest.isVerified = true;
      dest.pendingClaim = null;
      dest.dnsVerification = {
        cnameValid: true,
        txtVerified: true,
        sslVerified: false,
        routable: routeLive.routable === false ? false : routeLive.routable === true ? true : null,
        routingMethod: routeLive.routingMethod || null,
      };
      refreshCoverage(dest);
      if (dest.isVerified && dest.paymentStatus === "paid" && coverageValid(dest)) {
        dest.status = "active";
        await ensureSaaSHostname(dest);
        const cf = cfConfig() ? await cfGetCustomHostname(dest.domain) : null;
        if (cf) {
          dest.cfHostnameId = cf.id || dest.cfHostnameId || null;
          dest.cfHostnameStatus = cf.status || null;
          dest.cfSslStatus = cf.ssl?.status || null;
          dest.cfSslMethod = cf.ssl?.method || dest.cfSslMethod || null;
          const ov = cf.ownership_verification || null;
          if (ov && ov.name && ov.value) {
            dest.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
          }
          dest.dnsVerification.sslVerified = cf.ssl?.status === "active" ? true : dest.dnsVerification.sslVerified;
        }
      }
      await s.setJSON(`domain/${dest.domain}`, dest);
      try {
        await bumpSessionLinkCount(s, p.sessionId, movedCount);
        if (fromSid) await bumpSessionLinkCount(s, fromSid, -movedCount);
      } catch { /* best effort */ }
      return ok({
        success: true,
        converted: true,
        isVerified: true,
        linksMoved: movedCount,
        ...(await domainInfo(dest, p.sessionId)),
        coverageExpiresAt: dest.coverageExpiresAt || null,
        coverageLifetime: dest.coverageLifetime === true,
        coverageValid: coverageValid(dest),
      });
    }
    // Recommended takeover of a paired setup: the redirect host is proven
    // (routing + TXT, same as adding it fresh), so the setup exit-migrates
    // into a primary there — the entered name stays exactly what was typed.
    // Links stay on their minted hosts (set in stone); payment, coverage,
    // quotes, and history move with the setup (no new payment). Refuses when
    // the redirect host is occupied (409, same as the migrate direction).
    if (recommendedPair) {
      const X = redirectHostFull;
      const occupied = await freshGet(s, `domain/${X}`, { type: "json" }).catch(() => null);
      if (occupied) {
        return fail(409, "already-exists", `${X} is already set up — delete it or claim it first.`);
      }
      // Twins allowed: no own-label 409 (see policy above).
      const token = doc.pendingClaim.token;
      const fromSid = doc.sessionId;
      // Count both hosts' rows for session bookkeeping before the move.
      let movedCount = 0;
      try {
        const blobs = await listAll(s, "link/");
        for (const b of blobs) {
          const k = String(b.key || "");
          if (!k.startsWith(`link/${doc.domain}/`) && !k.startsWith(`link/${X}/`)) continue;
          const l = await freshGet(s, b.key, { type: "json" }).catch(() => null);
          if (l && l.code) movedCount++;
        }
      } catch { /* best effort; bumps stay approximate */ }
      const dest = await migrateDomainSetup(s, p, doc, doc.domain, X, { display: X, paired: false, redirect: null });
      // Adopt stone leftover rows on the redirect host (migrate adopts the
      // source host; these never change key — only session).
      try {
        const xBlobs = await listAll(s, `link/${X}/`);
        await mapWithConcurrency(xBlobs, 12, async (b) => {
          const l = await freshGet(s, b.key, { type: "json" }).catch(() => null);
          if (!l || !l.code || l.sessionId === p.sessionId) return;
          await s.setJSON(b.key, { ...l, sessionId: p.sessionId });
        });
      } catch { /* best effort; bumps stay approximate */ }
      dest.verificationToken = token;
      dest.isVerified = true;
      dest.pendingClaim = null;
      dest.dnsVerification = {
        cnameValid: true,
        txtVerified: true,
        sslVerified: !!live.ssl,
        routable: live.routable ?? null,
        routingMethod: live.routingMethod || null,
      };
      refreshCoverage(dest);
      if (dest.isVerified && dest.paymentStatus === "paid" && coverageValid(dest)) {
        dest.status = "active";
        await ensureSaaSHostname(dest);
        const cf = cfConfig() ? await cfGetCustomHostname(dest.domain) : null;
        if (cf) {
          dest.cfHostnameId = cf.id || dest.cfHostnameId || null;
          dest.cfHostnameStatus = cf.status || null;
          dest.cfSslStatus = cf.ssl?.status || null;
          dest.cfSslMethod = cf.ssl?.method || dest.cfSslMethod || null;
          const ov = cf.ownership_verification || null;
          if (ov && ov.name && ov.value) {
            dest.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
          }
          dest.dnsVerification.sslVerified = cf.ssl?.status === "active" ? true : dest.dnsVerification.sslVerified;
        }
      }
      await s.setJSON(`domain/${dest.domain}`, dest);
      try {
        await bumpSessionLinkCount(s, p.sessionId, movedCount);
        if (fromSid) await bumpSessionLinkCount(s, fromSid, -movedCount);
      } catch { /* best effort */ }
      return ok({
        success: true,
        isVerified: true,
        linksMoved: movedCount,
        restored: true,
        ...(await domainInfo(dest, p.sessionId)),
        coverageExpiresAt: dest.coverageExpiresAt || null,
        coverageLifetime: dest.coverageLifetime === true,
        coverageValid: coverageValid(dest),
      });
    }
    // Transfer ownership.
    const fromSid = doc.sessionId;
    doc.sessionId = p.sessionId;
    doc.verificationToken = doc.pendingClaim.token;
    doc.pendingClaim = null;
    doc.isVerified = true;
    // displayName is preserved (first entry wins) so lists never flicker.
    if (!doc.displayName) doc.displayName = doc.domain;
    doc.dnsVerification = {
      cnameValid: true,
      txtVerified: true,
      sslVerified: !!live.ssl,
      routable: live.routable ?? null,
      routingMethod: live.routingMethod || null,
    };
    refreshCoverage(doc);
    if (doc.isVerified && doc.paymentStatus === "paid" && coverageValid(doc)) {
      doc.status = "active";
      await ensureSaaSHostname(doc);
      const cf = cfConfig() ? await cfGetCustomHostname(doc.domain) : null;
      if (cf) {
        doc.cfHostnameId = cf.id || doc.cfHostnameId || null;
        doc.cfHostnameStatus = cf.status || null;
        doc.cfSslStatus = cf.ssl?.status || null;
        doc.cfSslMethod = cf.ssl?.method || doc.cfSslMethod || null;
        const ov = cf.ownership_verification || null;
        if (ov && ov.name && ov.value) {
          doc.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
        }
        doc.dnsVerification.sslVerified = cf.ssl?.status === "active" ? true : doc.dnsVerification.sslVerified;
      }
    } else if (doc.status === "active" && !coverageValid(doc)) {
      doc.status = "pending_verification";
    } else if (doc.isVerified && doc.paymentStatus === "paid" && coverageValid(doc)) {
      doc.status = "active";
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    // Move links (history + stats follow: clicks/ keyed by host/code).
    // A paired entry owns both hosts' rows (links stay on their minted host —
    // set in stone — only the session changes). Two passes close the race
    // where a link is minted mid-transfer. The count is reported so the
    // UI can say exactly what moved — a silent zero-move success is
    // indistinguishable from a broken transfer otherwise.
    let movedLinks = 0;
    try {
      const moveHosts = new Set([doc.domain.toLowerCase()]);
      // A host joins the move only while no live doc occupies it — an
      // independent setup's rows must never change session.
      const maybeMove = async (h) => {
        try {
          const lh = String(h || "").toLowerCase();
          if (!lh || moveHosts.has(lh)) return;
          const occupant = await freshGet(s, `domain/${lh}`, { type: "json" }).catch(() => null);
          if (!occupant) moveHosts.add(lh);
        } catch { /* skip */ }
      };
      try {
        const rh = (typeof doc.apexSource === "string" && doc.apexSource) ||
          (doc.isApexFlow === true ? apexForWww(doc.domain) : null);
        await maybeMove(rh);
        for (const h of stoneHostsForDoc(doc)) await maybeMove(h);
        // Uniform counterparts so no ghost rows linger on either side.
        try {
          const w0 = fallbackCanonicalFor(doc.domain);
          if (w0) await maybeMove(w0);
          if (rh) {
            const w1 = fallbackCanonicalFor(rh);
            if (w1) await maybeMove(w1);
          }
        } catch { /* doc + known hosts only */ }
      } catch { /* doc host only */ }
      const moveMine = async () => {
        const blobs = await listAll(s, "link/");
        const docs = await mapWithConcurrency(blobs, 12, (b) =>
          freshGet(s, b.key, { type: "json" }).catch(() => null)
        );
        const mine = docs.filter((l) => {
          if (!l || l.sessionId === p.sessionId) return false;
          const h = (l.domain || "").toLowerCase();
          if (moveHosts.has(h)) return true;
          try { return moveHosts.has(new URL(l.short).hostname.toLowerCase()); } catch { return false; }
        });
        await mapWithConcurrency(mine, 12, (l) => {
          l.sessionId = p.sessionId;
          if (!l.domain) {
            try { l.domain = new URL(l.short).hostname.toLowerCase(); } catch { /* keep */ }
          }
          return s.setJSON(linkKey(l.domain || doc.domain, l.code), l);
        });
        return mine.length;
      };
      movedLinks += await moveMine();
      movedLinks += await moveMine(); // second pass catches mid-transfer mints
      await bumpSessionLinkCount(s, p.sessionId, movedLinks);
      if (fromSid) await bumpSessionLinkCount(s, fromSid, -movedLinks);
    } catch (e) {
      console.error(`claim link move failed for ${doc.domain}:`, e?.message || e);
    }
    return ok({
      success: true,
      isVerified: true,
      linksMoved: movedLinks,
      status: doc.status,
      paymentStatus: doc.paymentStatus,
      coverageExpiresAt: doc.coverageExpiresAt || null,
      coverageLifetime: doc.coverageLifetime === true,
      coverageValid: coverageValid(doc),
    });
  },

  async verifyCustomDomainDns(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    // Per-field mode: each Verify button checks ONLY its own record.
    // "cname" → routing (CNAME/ALIAS/ANAME/flattened) + routable.
    // "txt"   → ownership TXT. Anything else → full check (unchanged).
    // Only the requested field is persisted and reported live; the other
    // keeps its stored value so one button can never flip the other's badge.
    const field = p.field === "cname" || p.field === "txt" ? p.field : "all";
    const only = field === "all" ? null : field;
    const stored = doc.dnsVerification || {};
    const live = await verifyDns(doc.domain, doc.verificationToken, only).catch(() => ({
      cname: false,
      txt: false,
      ssl: false,
      routable: null,
      cfHostnameStatus: null,
      cfSslStatus: null,
      routingMethod: null,
      routingUnknown: true,
      txtUnknown: true,
    }));
    // Fail-open on hiccups: a transport failure is UNKNOWN, not negative —
    // the stored badge survives and the UI reports stale. A definitive empty
    // answer still flips the badge. Full mode ("all") keeps unknown parts on
    // stored values too and reports stale when nothing live answered, so one
    // DoH outage can no longer wipe both badges at payment time.
    const stale =
      (field === "cname" && live.routingUnknown === true) ||
      (field === "txt" && live.txtUnknown === true) ||
      (field === "all" && live.routingUnknown === true && live.txtUnknown === true);
    // routable: true = resolves to edge, false = definitively unservable as
    // configured, null = unknown (fail-open, never blocks on lookup hiccups).
    // Routing valid = CNAME OR ALIAS OR ANAME OR flattened CNAME (live.cname).
    const liveRoutable = live.routable === false ? false : live.routable === true ? true : null;
    const cnameUnknown = (field === "cname" || field === "all") && live.routingUnknown === true;
    const txtUnknown = (field === "txt" || field === "all") && live.txtUnknown === true;
    const routable = field === "txt" || cnameUnknown
      ? (stored.routable === false ? false : stored.routable === true ? true : null)
      : liveRoutable;
    const cnameValid = field === "txt" || cnameUnknown ? !!stored.cnameValid : !!live.cname;
    const txtVerified = field === "cname" || txtUnknown ? !!stored.txtVerified : !!live.txt;
    doc.dnsVerification = {
      cnameValid,
      txtVerified,
      sslVerified: field === "all" ? !!live.ssl : !!stored.sslVerified,
      routable,
      routingMethod: field === "txt" || cnameUnknown ? (stored.routingMethod || null) : (live.routingMethod || null),
    };
    if (field === "all") {
      if (live.cfHostnameStatus) doc.cfHostnameStatus = live.cfHostnameStatus;
      if (live.cfSslStatus) doc.cfSslStatus = live.cfSslStatus;
    }
    // Sticky ownership: once proven, stays proven (matches frontend).
    // Per-field clicks combine: a live TXT plus an already-stored routing
    // pass (or vice versa) completes verification.
    if (cnameValid && txtVerified) doc.isVerified = true;
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
        doc.cfSslMethod = cf.ssl?.method || doc.cfSslMethod || null;
        const ov = cf.ownership_verification || null;
        if (ov && ov.name && ov.value) {
          doc.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
        }
        doc.dnsVerification.sslVerified = cf.ssl?.status === "active" ? true : doc.dnsVerification.sslVerified;
      }
      // Active requires ownership + payment + live coverage. TLS (cfSslStatus active) is reported
      // separately so the UI can show "Propagating" without blocking link creation
      // once DNS + payment are done. Links serve as soon as CNAME resolves (HTTP
      // validation completes in minutes); strict TLS gating would strand paid users.
      if (coverageValid(doc)) doc.status = "active";
    }
    // Pre-payment CF ownership surfacing for ALIAS/ANAME apex (CNAME illegal
    // at delegated zone apex): the _cf-custom-hostname TXT must be visible
    // BEFORE payment/activation, or users hit pending/530 with no guidance.
    // Read-only fetch when alias routing detected; creation (to obtain a
    // token when none exists) only once DNS-proven (routing + our TXT) to
    // avoid quota burn from unverified callers. SaaS policy itself stays
    // http-first (see cfEnsureSaaS): true apex-A migrates to txt on the CNAME
    // signal, working proxied CNAMEs never gain a card. Owner-only (needOwned).
    const aliasHere = doc.dnsVerification?.routingMethod === "alias";
    if (aliasHere && cfConfig()) {
      try {
        let cfLive = await cfGetCustomHostname(doc.domain).catch(() => null);
        if (!cfLive && cnameValid && txtVerified) {
          cfLive = await cfEnsureSaaS(doc.domain, "alias").catch(() => null);
        }
        if (cfLive) {
          doc.cfHostnameId = cfLive.id || doc.cfHostnameId || null;
          doc.cfHostnameStatus = cfLive.status || doc.cfHostnameStatus || null;
          doc.cfSslStatus = cfLive.ssl?.status || doc.cfSslStatus || null;
          doc.cfSslMethod = cfLive.ssl?.method || doc.cfSslMethod || null;
          const ov = cfLive.ownership_verification || null;
          if (ov && ov.name && ov.value) {
            doc.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
          }
        }
      } catch { /* display-only, never blocks verify */ }
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    return ok({
      success: true,
      field,
      ...(stale ? { stale: true } : {}),
      isVerified: doc.isVerified,
      checks: { cname: cnameValid, txt: txtVerified, ssl: !!doc.dnsVerification.sslVerified, routable, routingMethod: doc.dnsVerification.routingMethod || null },
      cfHostnameStatus: doc.cfHostnameStatus || live.cfHostnameStatus || null,
      cfSslStatus: doc.cfSslStatus || live.cfSslStatus || null,
      ...(doc.cfOwnershipVerification?.name && doc.cfOwnershipVerification?.value
        ? { cfOwnershipName: doc.cfOwnershipVerification.name, cfOwnershipValue: doc.cfOwnershipVerification.value }
        : {}),
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
    // A paired entry owns both hosts' rows (links stay on their minted host —
    // set in stone — so apex-host rows survive converts/exits under the pair).
    // The redirect host is swept too, unless a live doc still occupies it (an
    // independent setup there must never be touched).
    const sweepHosts = new Set([target]);
    // A host joins the sweep only while no live doc occupies it — an
    // independent setup there must never be touched.
    const maybeSweep = async (h) => {
      try {
        const lh = String(h || "").toLowerCase();
        if (!lh || lh === target || sweepHosts.has(lh)) return;
        const occupant = await freshGet(s, `domain/${lh}`, { type: "json" }).catch(() => null);
        if (!occupant) sweepHosts.add(lh);
      } catch { /* skip */ }
    };
    try {
      const redirect = (typeof doc.apexSource === "string" && doc.apexSource)
        ? doc.apexSource.toLowerCase()
        : (doc.isApexFlow === true ? apexForWww(doc.domain) : null);
      await maybeSweep(redirect);
      for (const h of stoneHostsForDoc(doc)) await maybeSweep(h);
      // Uniform counterparts: a stone chain can reference either direction.
      try {
        const w0 = fallbackCanonicalFor(doc.domain);
        if (w0) await maybeSweep(w0);
        if (redirect) {
          const w1 = fallbackCanonicalFor(redirect);
          if (w1) await maybeSweep(w1);
        }
      } catch { /* target + known hosts only */ }
    } catch { /* target-only sweep */ }
    const doomed = [];
    const seen = new Set();
    for (const l of linkDocs) {
      if (!l || !l.code) continue;
      let match = false;
      const lh = (l.domain || "").toLowerCase();
      if (sweepHosts.has(lh)) match = true;
      if (!match) {
        try { if (sweepHosts.has(new URL(l.short).hostname.toLowerCase())) match = true; } catch { /* no */ }
      }
      if (!match) continue;
      // Delete by both key derivations (domain field and short-URL host),
      // so a doc with a mismatched domain field can't orphan its link.
      const keys = new Set([linkKey(l.domain || doc.domain, l.code)]);
      try { keys.add(linkKey(new URL(l.short).hostname, l.code)); } catch { /* ignore */ }
      for (const k of keys) {
        if (!seen.has(k)) { seen.add(k); doomed.push({ link: l, key: k }); }
      }
    }
    await mapWithConcurrency(doomed, 12, (d) => s.delete(d.key));
    // Cascade click rows + count shards for every swept host: deleting the
    // domain must not leave visitor IPs (clicks/) or statistics (counts/)
    // behind — the terms promise permanent removal. Clicks go in full
    // (privacy); counts are capped per call with a loud log so a viral
    // domain can't time the function out (remainder ages out of reads with
    // its links).
    for (const h of sweepHosts) {
      try {
        const clickKeys = await listAll(s, `clicks/${h}/`);
        await mapWithConcurrency(clickKeys, 12, (b) => s.delete(b.key).catch(() => null));
      } catch (e) {
        console.error(`deleteCustomDomain(${doc.domain}) click sweep failed for ${h}:`, e?.message || e);
      }
      try {
        const countKeys = await listAll(s, `counts/${h}/`);
        const capped = countKeys.slice(0, 2000);
        if (countKeys.length > capped.length) {
          console.error(`deleteCustomDomain(${doc.domain}) count sweep truncated for ${h}: ${countKeys.length - capped.length} shards left behind`);
        }
        await mapWithConcurrency(capped, 12, (b) => s.delete(b.key).catch(() => null));
      } catch (e) {
        console.error(`deleteCustomDomain(${doc.domain}) count sweep failed for ${h}:`, e?.message || e);
      }
    }
    try {
      const uniqCodes = new Set(doomed.map((d) => d.link.code));
      await bumpSessionLinkCount(s, p.sessionId, -uniqCodes.size);
    } catch { /* best effort */ }
    return ok({ deletedUrls: doomed.length });
  },

  // Abandon a pending takeover claim on a foreign domain. Removes ONLY the
  // claimant's own pendingClaim (links, owner doc, and everyone else's claims
  // are untouched). This is how a recorded TXT token finally changes: stable
  // per session until here, a rival claim, or a verified transfer.
  async abandonClaimedDomain(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "abandon", ip, 10))) {
      const e = new Error("Too many attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    const host = cleanDomain(p.domain);
    if (!host) return fail(400, "invalid-argument", "Invalid domain name.");
    const doc = await getWithRetry(s, `domain/${host}`, { type: "json" }, { attempts: 3, delayMs: 350 });
    if (!doc || !doc.pendingClaim || doc.pendingClaim.sessionId !== p.sessionId) {
      return fail(404, "not-found", "No pending claim for this session.");
    }
    doc.pendingClaim = null;
    await s.setJSON(`domain/${host}`, doc);
    return ok({ abandoned: host });
  },

  // ----- apex (root) routing -----
  // Paid-and-ready domains may point their root path (https://domain/) at any
  // destination. Stored on the domain doc; served by resolve.js. Unset (null)
  // keeps the default behavior (app landing page).

  async setApexTarget(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "apex", ip, 10))) {
      const e = new Error("Too many attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    // Manage-gate mirrors mint gating: only paid-and-ready (active + covered)
    // domains may configure root routing. The UI hides the option earlier,
    // but the backend decides.
    if (!(doc.status === "active" && coverageValid(doc))) {
      return fail(412, "failed-precondition", "APEX routing unlocks once the domain is paid and active.");
    }
    const raw = p.target === null || p.target === undefined ? "" : String(p.target).trim();
    if (!raw) {
      doc.apexTarget = null;
      doc.apexUpdatedAt = new Date().toISOString();
      await s.setJSON(`domain/${doc.domain}`, doc);
      return ok({ apexTarget: null });
    }
    if (raw.length > 2048 || !validHttpUrl(raw)) {
      return fail(400, "invalid-argument", "That destination is not a valid http(s) URL.");
    }
    if (isSelfRootTarget(doc.domain, raw)) {
      return fail(400, "invalid-argument", "The destination cannot be this domain's own root (that would loop forever).");
    }
    // Root destinations get the same safety screening as short links: a
    // compromised root would otherwise redirect every bare-domain visitor.
    try {
      const verdict = await checkUrlSafety(s, raw);
      if (verdict && verdict.safe === false) {
        return fail(400, "invalid-argument", "ERR_UNSAFE_URL");
      }
    } catch (e) {
      console.error("apex target safety check failed open:", e?.message || e);
    }
    doc.apexTarget = raw;
    doc.apexUpdatedAt = new Date().toISOString();
    await s.setJSON(`domain/${doc.domain}`, doc);
    return ok({ apexTarget: doc.apexTarget });
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

  async generatePaymentAddress(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "pay-addr", `${ip}:${cleanDomain(p.domain) || "nodomain"}`, 10))) {
      const e = new Error("Too many address requests, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
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
    // ALIAS/ANAME apex: nothing technical may remain after payment — the
    // chain must be fully green before any money moves, then 1 confirmation
    // activates automatically. CNAME/http needs no extra record; true apex-A
    // (SaaS reporting the CNAME problem) requires the hostname ACTIVE via its
    // ownership TXT. Working proxied CNAMEs classifying as alias on the wire
    // pass through with no card and no block. Exact prefixes below — keep stable.
    if ((dns.routingMethod || null) === "alias" && cfConfig()) {
      let cf = await cfGetCustomHostname(doc.domain).catch(() => null);
      if (!cf && dns.cnameValid && dns.txtVerified) {
        cf = await cfEnsureSaaS(doc.domain, "alias").catch(() => null);
      } else if (cf && cfNeedsTxt(cf)) {
        cf = await cfEnsureSaaS(doc.domain, "alias").catch(() => cf);
      }
      if (cf) {
        doc.cfHostnameId = cf.id || doc.cfHostnameId || null;
        doc.cfHostnameStatus = cf.status || null;
        doc.cfSslStatus = cf.ssl?.status || null;
        doc.cfSslMethod = cf.ssl?.method || doc.cfSslMethod || null;
        const ov = cf.ownership_verification || null;
        if (ov && ov.name && ov.value) {
          doc.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
        }
        await s.setJSON(`domain/${doc.domain}`, doc);
      }
      const st = (cf && cf.status) || doc.cfHostnameStatus || null;
      if (st !== "active") {
        const hasOv = !!(doc.cfOwnershipVerification?.name && doc.cfOwnershipVerification?.value);
        return fail(412, "failed-precondition", hasOv
          ? "CLOUDFLARE_TXT_REQUIRED: add the shown _cf-custom-hostname TXT and Re-verify until Cloudflare is active, then continue to payment."
          : "CLOUDFLARE_PENDING: Cloudflare is still activating this hostname — wait a moment and Re-verify, then continue to payment.");
      }
    }
    const consentBlock = await withdrawalConsentGate(s, doc, p, "requesting a payment address");
    if (consentBlock) return consentBlock;
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
        withdrawalConsent: true,
      });
    }
    const price = await btcUsdPrice().catch((e) => {
      throw Object.assign(new Error(e.message), { statusCode: 503, code: "unavailable" });
    });
    const pct = doc.discount ? doc.discount.percent : 0;
    const q = quoteFor(pct, price);
    // New money always gets a fresh address: a consumed quote (already paid)
    // or an address that already bought coverage (ignored) is never re-issued.
    // Unpaid persistence is unaffected — an outstanding unpaid quote keeps its
    // address so in-flight and late payments still land.
    const ignored = ignoredAddresses(doc);
    let address = doc.quote && doc.quote.address && !p.forceRefresh && !quoteConsumed && !ignored.has(doc.quote.address) ? doc.quote.address : null;
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
    // Concurrent-mint merge: two simultaneous fresh mints can both read a
    // null/stale quote and derive different addresses. Without a merge the
    // second save would silently drop the first displayed address, stranding
    // that payment. Re-read and retire any foreign quote we never saw.
    try {
      const latest = await freshGet(s, `domain/${doc.domain}`, { type: "json" }).catch(() => null);
      const latestAddr = latest && latest.quote && latest.quote.address;
      if (latestAddr && latestAddr !== doc.quote.address) {
        doc.quoteHistory = Array.isArray(doc.quoteHistory) ? doc.quoteHistory : [];
        if (!doc.quoteHistory.some((h) => h && h.address === latestAddr)) {
          doc.quoteHistory.push({
            address: latest.quote.address,
            amount: latest.quote.amount,
            index: latest.quote.index,
            expiresAt: latest.quote.expiresAt,
            supersededAt: new Date().toISOString(),
            ...(latest.quote.discountPercent ? { discountPercent: latest.quote.discountPercent } : {}),
          });
          if (doc.quoteHistory.length > 50) doc.quoteHistory = doc.quoteHistory.slice(-50);
        }
      }
    } catch { /* merge best-effort; clash loops below still guard dupes */ }
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
    return ok({ amount: doc.quote.amount, address: doc.quote.address, expiresAt: doc.quote.expiresAt, index: doc.quote.index, ...(q.discountPercent ? { discountPercent: q.discountPercent, originalAmount: q.originalAmount } : {}), coverageExpiresAt: doc.coverageExpiresAt || null, coverageLifetime: doc.coverageLifetime === true, coverageValid: coverageValid(doc), withdrawalConsent: true });
  },

  async checkDomainDiscount(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    if (refreshCoverage(doc)) await s.setJSON(`domain/${doc.domain}`, doc);
    const consentRecorded = !!(doc.withdrawalConsent && doc.withdrawalConsent.at);
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
        withdrawalConsent: consentRecorded,
      });
    }
    return ok({
      hasDiscount: false,
      coverageExpiresAt: doc.coverageExpiresAt || null,
      coverageLifetime: doc.coverageLifetime === true,
      coverageValid: coverageValid(doc),
      withdrawalConsent: consentRecorded,
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
  // All gated by needAdmin + audit-logged. The backend returns full values
  // (admin-only UI) so moderation (quarantine/delete/block) is possible.

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
    if (qDomain) {
      // Apex-aware: typing ghiveci.com also matches www.ghiveci.com docs
      // (links are stored on the www canonical, displayed as apex).
      const candidates = new Set([qDomain]);
      try {
        if (await isApexDomain(qDomain)) {
          const w = wwwForApex(qDomain);
          if (w) candidates.add(w);
        }
      } catch { /* exact match only */ }
      found = found.filter((l) => candidates.has((l.domain || "").toLowerCase()));
    }
    if (qCode) found = found.filter((l) => (l.code || "") === qCode);
    if (qOrig) found = found.filter((l) => String(l.original || "").toLowerCase().includes(qOrig));
    if (onlyQ) found = found.filter((l) => l.quarantined === true);
    found.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const page = found.slice(0, 50);
    // Blocklist flags: the blocked/ prefix is tiny, so one list read builds
    // the hash set and each link is marked with local hashing only (no
    // per-link reads). Lets the UI badge Blocked originals directly.
    let blockedSet = new Set();
    try {
      const bblobs = await listAll(s, "blocked/");
      blockedSet = new Set(bblobs.map((b) => String(b.key || "").split("/").pop()));
    } catch { /* ignore: flags default to false */ }
    const hashes = await mapWithConcurrency(page, 12, (l) => originalHash(l.original || ""));
    // Apex display: attach each link's apex form when its domain doc is
    // apex-flagged, so admin sees links exactly as the user sees them.
    // Batched by distinct host — a handful of reads per page, not per link.
    // Identity (domain/code for quarantine/delete) stays canonical.
    let apexByHost = {};
    try {
      const hosts = [...new Set(page.map((l) => String(l.domain || "").toLowerCase()).filter(Boolean))];
      const docs = await mapWithConcurrency(hosts, 12, (h) =>
        freshGet(s, `domain/${h}`, { type: "json" }).catch(() => null)
      );
      hosts.forEach((h, i) => {
        const d = docs[i];
        if (d && d.isApexFlow === true) {
          const a = (typeof d.apexSource === "string" && d.apexSource) || apexForWww(d.domain);
          if (a) apexByHost[h] = String(a).toLowerCase();
        }
      });
    } catch { /* display-only: fall back to canonical */ }
    const links = page.map((l, i) => ({
      ...linkShape(l),
      ...(hashes[i] && blockedSet.has(hashes[i]) ? { originalBlocked: true } : {}),
      ...(apexByHost[String(l.domain || "").toLowerCase()] ? { apexDisplay: apexByHost[String(l.domain || "").toLowerCase()] } : {}),
    }));
    return ok({ links, truncated: found.length > 50, total: found.length });
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
    const forms = canonicalOriginalForms(original);
    const primary = forms[0] || original;
    const h = await originalHash(primary);
    if (!h) return fail(400, "invalid-argument", "Invalid URL.");
    let host = "";
    try { host = new URL(original).hostname.toLowerCase().slice(0, 120); } catch { /* keep empty */ }
    await s.setJSON(`blocked/${h}`, { hash: h, host, original: original.slice(0, 2048), at: new Date().toISOString(), reason: String(p.reason || "ADMIN").slice(0, 40) });
    try {
      const { createHash } = await import("node:crypto");
      const bare = forms[1] || null;
      if (bare && bare !== primary) {
        const h2 = createHash("sha256").update(bare).digest("hex");
        if (h2 !== h) await s.setJSON(`blocked/${h2}`, { hash: h2, host, original: bare.slice(0, 2048), at: new Date().toISOString(), reason: String(p.reason || "ADMIN").slice(0, 40) });
      }
    } catch { /* companion bare entry best effort */ }
    let swept = 0;
    try {
      const blobs = await listAll(s, "link/");
      const docs = await mapWithConcurrency(blobs.slice(0, 2000), 12, (b) =>
        freshGet(s, b.key, { type: "json" }).catch(() => null)
      );
      const normSet = new Set(forms.map((f) => f.toLowerCase()));
      normSet.add(original.trim().toLowerCase());
      const matches = docs.filter((l) => {
        if (!l || !l.original) return false;
        const lo = String(l.original).trim().toLowerCase();
        if (normSet.has(lo)) return true;
        try {
          const lf = canonicalOriginalForms(l.original);
          return lf.some((f) => normSet.has(f.toLowerCase()));
        } catch { return false; }
      }).slice(0, 200);
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
    const h = hash && /^[0-9a-f]{64}$/.test(hash) ? hash : await originalHash(canonicalOriginalForms(original)[0] || original);
    if (!h) return fail(400, "invalid-argument", "Invalid URL or hash.");
    await s.delete(`blocked/${h}`);
    try {
      const forms = canonicalOriginalForms(original);
      const { createHash } = await import("node:crypto");
      for (const f of forms) {
        const hh = createHash("sha256").update(f).digest("hex");
        if (hh !== h) await s.delete(`blocked/${hh}`).catch(() => null);
      }
    } catch { /* companion cleanup best effort */ }
    return ok({ unblocked: true });
  },

  // Visible blocklist (orphan-safe): blocks survive link deletions by
  // design, so the admin needs a list to review/undo them even when no
  // link carries the original anymore. Prefix is tiny — one list read.
  async adminListBlocked(s, p, event) {
    await needAdmin(s, p, event);
    const blobs = await listAll(s, "blocked/");
    const docs = await mapWithConcurrency(blobs, 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const out = docs
      .filter((d) => d && d.hash)
      .map((d) => ({
        hash: String(d.hash),
        host: String(d.host || ""),
        original: typeof d.original === "string" ? d.original.slice(0, 2048) : null,
        at: d.at || null,
        reason: String(d.reason || ""),
      }));
    out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return ok({ blocked: out.slice(0, 500) });
  },

  async applyDiscountCode(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "discount", ip, 10))) {
      const e = new Error("Too many attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
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
          withdrawalConsent: true,
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
          withdrawalConsent: true,
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
    const consentBlock = await withdrawalConsentGate(s, doc, p, "applying a discount code");
    if (consentBlock) return consentBlock;
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
      // Settle the previous trigger, if any, so its funds can never buy a
      // later year on their own. (The cleared quote below was never payable
      // through this path, so there is no new trigger address to record.)
      markIgnored(doc, doc.paidAddress);
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
        withdrawalConsent: true,
      });
    }
    // Regenerate quote at the discounted price.
    const price = await btcUsdPrice().catch((e) => {
      throw Object.assign(new Error(e.message), { statusCode: 503, code: "unavailable" });
    });
    const q = quoteFor(pct, price);
    // New money always gets a fresh address here too: a consumed quote or an
    // address that already bought coverage is retired, never re-issued. The
    // retired entry stays in history (ignored thereafter) for the audit trail.
    const ignored = ignoredAddresses(doc);
    let address = doc.quote && doc.quote.address && !doc.quote.paidAt && !ignored.has(doc.quote.address) ? doc.quote.address : null;
    if (!address) {
      // Retire the displaced quote (if any) exactly like generatePaymentAddress
      // so the audit trail matches; it stays ignored thereafter.
      if (doc.quote && doc.quote.address) {
        doc.quoteHistory = Array.isArray(doc.quoteHistory) ? doc.quoteHistory : [];
        if (!doc.quoteHistory.some((h) => h && h.address === doc.quote.address)) {
          doc.quoteHistory.push({
            address: doc.quote.address,
            amount: doc.quote.amount,
            index: doc.quote.index,
            expiresAt: doc.quote.expiresAt,
            supersededAt: new Date().toISOString(),
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
    // Concurrent-mint merge (same as generatePaymentAddress): preserve a
    // foreign quote saved between our read and write so its address stays
    // credited.
    try {
      const latest = await freshGet(s, `domain/${doc.domain}`, { type: "json" }).catch(() => null);
      const latestAddr = latest && latest.quote && latest.quote.address;
      if (latestAddr && latestAddr !== doc.quote.address) {
        doc.quoteHistory = Array.isArray(doc.quoteHistory) ? doc.quoteHistory : [];
        if (!doc.quoteHistory.some((h) => h && h.address === latestAddr)) {
          doc.quoteHistory.push({
            address: latest.quote.address,
            amount: latest.quote.amount,
            index: latest.quote.index,
            expiresAt: latest.quote.expiresAt,
            supersededAt: new Date().toISOString(),
            ...(latest.quote.discountPercent ? { discountPercent: latest.quote.discountPercent } : {}),
          });
          if (doc.quoteHistory.length > 50) doc.quoteHistory = doc.quoteHistory.slice(-50);
        }
      }
    } catch { /* merge best-effort */ }
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
      withdrawalConsent: true,
    });
  },

  async removeDiscountCode(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    // Funds-in-flight guard: voiding discounted history while a discounted
    // payment is unconfirmed (or partially confirmed) would make that money
    // invisible forever. If ANY displayed address shows movement, refuse and
    // tell the user to wait for confirmation first. Fail CLOSED on lookup
    // outages: voiding history is irreversible, so an incomplete check must
    // refuse rather than silently strand in-flight money.
    let balanceCheckIncomplete = false;
    try {
      const addrs = [];
      if (doc.quote?.address) addrs.push(doc.quote.address);
      for (const h of Array.isArray(doc.quoteHistory) ? doc.quoteHistory : []) {
        if (h?.address && h?.discountPercent) addrs.push(h.address);
      }
      for (const a of [...new Set(addrs)].slice(0, 5)) {
        let res = null;
        try {
          res = await fetchWithTimeoutMs(`https://mempool.space/api/address/${encodeURIComponent(a)}`, 6000);
        } catch {
          balanceCheckIncomplete = true;
          continue;
        }
        if (!res.ok) { balanceCheckIncomplete = true; continue; }
        const data = await res.json().catch(() => null);
        if (!data) { balanceCheckIncomplete = true; continue; }
        const chain = (Number(data?.chain_stats?.funded_txo_sum) || 0) - (Number(data?.chain_stats?.spent_txo_sum) || 0);
        const mem = (Number(data?.mempool_stats?.funded_txo_sum) || 0) - (Number(data?.mempool_stats?.spent_txo_sum) || 0);
        if (chain > 0 || mem > 0) {
          return fail(409, "failed-precondition", "Payment detected to this domain's address — wait for confirmation before removing the code.");
        }
      }
    } catch (e) {
      console.error(`removeDiscountCode pre-check failed for ${doc.domain}:`, e?.message || e);
      balanceCheckIncomplete = true;
    }
    if (balanceCheckIncomplete) {
      return fail(503, "unavailable", "Balance check unavailable — could not verify no payment is in flight. Try again in a moment; nothing was changed.");
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
    // Keep the shown address only if it never bought coverage: re-pricing onto
    // an ignored address would leave a renewal quote no checker may honor.
    // (Removal is refused while any displayed address shows movement, so no
    // in-flight money is stranded by minting fresh here.)
    const keepAddr = doc.quote && doc.quote.address && !ignoredAddresses(doc).has(doc.quote.address)
      ? { address: doc.quote.address, index: doc.quote.index }
      : null;
    if (keepAddr) {
      try {
        const price = await btcUsdPrice();
        const q = quoteFor(0, price);
        doc.quote = { ...q, address: keepAddr.address, index: keepAddr.index };
      } catch (e) {
        doc.quote = null;
      }
    } else {
      doc.quote = null;
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
    // Settled money never re-triggers: skipped addresses bought coverage in
    // an earlier activation (chain balances only grow, so re-checking them
    // would renew every lapsed domain for free). Unpaid money — including
    // late payments to retired quotes and top-ups — always counts.
    const ignored = ignoredAddresses(doc);
    // Unpaid domains: current quote always counts (even expired — late payers
    // must still credit). Paid-but-lapsed domains: only a genuine renewal
    // quote (unconsumed, issued after the last payment) plus retired history.
    // Settled addresses are NEVER re-checked — otherwise every re-check
    // would instantly "re-pay" and extend coverage for free.
    if (doc.paymentStatus !== "paid") {
      if (doc.quote?.address && doc.quote?.amount && !ignored.has(doc.quote.address)) {
        candidates.push({ address: doc.quote.address, amount: doc.quote.amount, current: true });
      }
    } else if (doc.quote?.address && doc.quote?.amount && isRenewalQuote(doc.quote, lastPaidAt) && !ignored.has(doc.quote.address)) {
      candidates.push({ address: doc.quote.address, amount: doc.quote.amount, current: true });
    }
    for (const h of Array.isArray(doc.quoteHistory) ? doc.quoteHistory : []) {
      if (h?.address && h?.amount && !ignored.has(h.address)) candidates.push({ address: h.address, amount: h.amount, current: false });
    }
    if (!candidates.length) return ok({ paid: false, reason: "no-quote" });
    let seenUnconfirmed = false;
    let partial = null;
    try {
      for (const c of candidates) {
        const res = await fetchWithTimeoutMs(`https://mempool.space/api/address/${encodeURIComponent(c.address)}`, 6000);
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
          // Settle the triggering address (plus the previous trigger, if any)
          // so its on-chain funds can never buy another year on their own.
          markIgnored(doc, c.address, doc.paidAddress);
          doc.paidAddress = c.address;
          doc.paidAmount = c.amount;
          if (c.current && doc.quote) doc.quote.paidAt = new Date().toISOString();
          if (cfConfig() && doc.isVerified) {
            try {
              const cf = await cfEnsureSaaS(doc.domain, doc.dnsVerification?.routingMethod || null);
              if (cf) {
                doc.cfHostnameId = cf.id || null;
                doc.cfHostnameStatus = cf.status || null;
                doc.cfSslStatus = cf.ssl?.status || null;
                doc.cfSslMethod = cf.ssl?.method || doc.cfSslMethod || null;
                const ov = cf.ownership_verification || null;
                if (ov && ov.name && ov.value) {
                  doc.cfOwnershipVerification = { name: String(ov.name), value: String(ov.value) };
                }
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

  async getBtcPrice(s, p, event) {
    const ip = clientIp(event);
    if (!(await checkRate(s, "btc-price", ip, 20))) {
      const e = new Error("Too many attempts, wait a moment.");
      e.statusCode = 429;
      e.code = "resource-exhausted";
      throw e;
    }
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
  // Own-property + typeof guards (not just truthiness): blocks
  // prototype-edge lookups like action:"constructor" (inherited Object
  // constructor IS a function) from reaching a non-action function.
  const name = typeof body.action === "string" ? body.action : "";
  const fn = Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (typeof fn !== "function") return fail(400, "invalid-argument", `Unknown action: ${body.action || "(missing)"}.`);
  const s = store(event);
  try {
    return await fn(s, body, event);
  } catch (e) {
    console.error(`api:${body.action} failed:`, e);
    return fail(e.statusCode || 500, e.code || "internal", e.message || "Internal error.");
  }
}
