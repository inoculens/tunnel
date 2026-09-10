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
  validSlug,
  cleanDomain,
  validHttpUrl,
  newCode,
  newToken,
  detectPlatform,
  clientIp,
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
  deriveAddress,
  nextWalletIndex,
  listAll,
  coverageValid,
  COVERAGE_YEAR_MS,
  linkKey,
  clicksPrefix,
} from "./lib/util.js";

// Ensure a Cloudflare SaaS custom hostname exists once the domain is
// verified + paid — identically for every custom domain. Only s./tunnel.
// are the app itself (reserved in addCustomDomain, can never be claimed).
// Best effort: DNS ownership remains the source of truth; SaaS failures are
// logged and surfaced via cf fields, never block payment.
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

async function getSession(s, sid) {
  if (!validSessionId(sid)) return null;
  return s.get(`sessions/${sid}`, { type: "json" });
}

async function needSession(s, sid) {
  const sess = await getSession(s, sid);
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
  return s.get(linkKey(host, code), { type: "json" });
}

async function needLink(s, host, code) {
  const link = await getLink(s, host, code);
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
  return s.get(`domain/${d}`, { type: "json" });
}

async function needOwnedDomain(s, domain, sessionId) {
  const d = cleanDomain(domain);
  if (!d) {
    const e = new Error("Invalid domain name.");
    e.statusCode = 400;
    e.code = "invalid-argument";
    throw e;
  }
  const doc = await s.get(`domain/${d}`, { type: "json" });
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

async function domainInfo(doc) {
  const route = routingTarget();
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
    dnsVerificationToken: doc.verificationToken,
    verificationToken: doc.verificationToken,
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
      txt: doc.verificationToken,
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
  };
}

async function listLinksOfSession(s, sid) {
  const found = [];
  for (const b of await listAll(s, "link/")) {
    const l = await s.get(b.key, { type: "json" });
    if (l && l.sessionId === sid) found.push(l);
  }
  found.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return found;
}

async function deleteClickKeys(s, host, code) {
  for (const b of await listAll(s, clicksPrefix(host, code))) {
    await s.delete(b.key);
  }
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
  if (!key) {
    const e = new Error("Promo admin is not configured on this deployment (no ADMIN_KEY).");
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
  if (typeof p.adminKey !== "string" || p.adminKey.length < 8 || p.adminKey !== key) {
    const e = new Error("Invalid admin key.");
    e.statusCode = 403;
    e.code = "permission-denied";
    throw e;
  }
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
  for (const b of await listAll(s, "domain/")) {
    let d = null;
    try {
      d = await s.get(b.key, { type: "json" });
    } catch { continue; }
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
    const { originalUrl, customSlug, sessionId, domain } = p;
    if (!validHttpUrl(originalUrl)) {
      const e = new Error("ERR_INVALID_URL");
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

    let code;
    if (customSlug) {
      if (!validSlug(customSlug)) {
        const e = new Error("Custom slugs must be 3–64 chars: letters, numbers, - _");
        e.statusCode = 400;
        e.code = "invalid-argument";
        throw e;
      }
      // Scoped uniqueness: the same slug may live on other root domains.
      if (await getLink(s, host, customSlug)) {
        const e = new Error("ERR_SLUG_TAKEN");
        e.statusCode = 409;
        e.code = "already-exists";
        throw e;
      }
      code = customSlug;
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
      const doc = await s.get(`domain/${host}`, { type: "json" });
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
      original: String(originalUrl),
      short: `https://${host}/${code}`,
      domain: host,
      sessionId,
      deleteToken: newToken(),
      label: "",
      clickCount: 0,
      platform: detectPlatform(originalUrl),
      createdAt: Date.now(),
    };
    await s.setJSON(linkKey(host, code), link);
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
    const clicks = [];
    for (const b of await listAll(s, clicksPrefix(host, link.code))) {
      const c = await s.get(b.key, { type: "json" });
      if (c) clicks.push(c);
    }
    clicks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return ok({ clickCount: link.clickCount || 0, clicks });
  },

  async deleteAllClicks(s, p) {
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    needToken(link, p.deleteToken);
    await deleteClickKeys(s, host, link.code);
    link.clickCount = 0;
    await s.setJSON(linkKey(host, link.code), link);
    return ok({});
  },

  async deleteClickEntry(s, p) {
    const host = needLinkHost(p);
    const link = await needLink(s, host, p.shortCode);
    needToken(link, p.deleteToken);
    await s.delete(`${clicksPrefix(host, link.code)}${p.clickId}`);
    link.clickCount = Math.max(0, (link.clickCount || 1) - 1);
    await s.setJSON(linkKey(host, link.code), link);
    return ok({});
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
    await needSession(s, oldSessionId);
    await needSession(s, newSessionId);
    const links = await listLinksOfSession(s, oldSessionId);
    for (const l of links) {
      l.sessionId = newSessionId;
      // Keys are (host, code): derive the host from the stored doc, falling
      // back to the link URL itself so the key can never go missing.
      let lh = l.domain;
      if (!lh) {
        try { lh = new URL(l.short).hostname; } catch { lh = ""; }
        l.domain = lh;
      }
      await s.setJSON(linkKey(lh, l.code), l);
    }
    // Custom domains belong to the session too: move them along so a merge
    // transfers everything (links + domains). Hostnames are unique docs, so
    // no conflicts are possible. Past promo redemptions stay recorded.
    let movedDomains = 0;
    for (const b of await listAll(s, "domain/")) {
      const d = await s.get(b.key, { type: "json" });
      if (d && d.sessionId === oldSessionId) {
        d.sessionId = newSessionId;
        await s.setJSON(`domain/${d.domain}`, d);
        movedDomains++;
      }
    }
    return ok({ success: true, count: links.length, domains: movedDomains });
  },

  // ----- custom domains -----

  async getUserDomains(s, p) {
    await needSession(s, p.sessionId);
    const out = [];
    for (const b of await listAll(s, "domain/")) {
      const d = await s.get(b.key, { type: "json" });
      if (!d || d.sessionId !== p.sessionId) continue;
      // Keep the list truthful: lapsed coverage demotes here too, so the
      // dropdown never offers a dead domain as active.
      if (refreshCoverage(d)) await s.setJSON(`domain/${d.domain}`, d);
      out.push(await domainInfo(d));
    }
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
    });
  },

  async addCustomDomain(s, p) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
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
    const existing = await s.get(`domain/${host}`, { type: "json" });
    if (existing) {
      if (existing.sessionId !== p.sessionId) {
        // Claim flow: any session may attach this name to itself (e.g. the
        // owner lost their Session ID), but the claim starts INERT — fresh
        // TXT token, verification flags cleared, demoted to pending. Use
        // (shortenUrl) stays gated on sessionId + active status, so the
        // domain cannot serve under any circumstances until THIS session
        // proves ownership: the new token must appear at
        // verification.<domain> in live DNS (verifyCustomDomainDns), which
        // only someone controlling the domain's DNS can arrange. Payment /
        // quote state carries over (it prices the domain, not the session)
        // and re-activates automatically once the new owner verifies.
        existing.sessionId = p.sessionId;
        existing.status = "pending_verification";
        existing.isVerified = false;
        existing.verificationToken = newToken(32);
        existing.dnsVerification = { cnameValid: false, txtVerified: false, sslVerified: false };
        await s.setJSON(`domain/${host}`, existing);
        return ok(await domainInfo(existing));
      }
      return ok(await domainInfo(existing)); // idempotent re-entry
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
    return ok(await domainInfo(doc));
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
    return ok({ ...(await domainInfo(doc)), paymentStatus: doc.paymentStatus });
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
    let deletedUrls = 0;
    for (const b of await listAll(s, "link/")) {
      const l = await s.get(b.key, { type: "json" });
      if (l) {
        try {
          if (new URL(l.short).hostname === doc.domain) {
            await s.delete(b.key);
            deletedUrls++;
          }
        } catch { /* ignore malformed */ }
      }
    }
    return ok({ deletedUrls });
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
          if (doc.quoteHistory.length > 20) doc.quoteHistory = doc.quoteHistory.slice(-20);
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
        if (!(await s.get(`promo/${c}`, { type: "json" }).catch(() => null))) code = c;
      }
      if (!code) return fail(503, "unavailable", "Could not mint a unique code, try again.");
    } else if (await s.get(`promo/${code}`, { type: "json" }).catch(() => null)) {
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
    const out = [];
    for (const b of await listAll(s, "promo/")) {
      const promo = await s.get(b.key, { type: "json" }).catch(() => null);
      if (promo) out.push(promoShape(promo));
    }
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
    const stored = await s.get(`promo/${code}`, { type: "json" }).catch(() => null);
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
    // Reserve the single-use BEFORE applying: if the doc save below ever
    // failed, the use stays burned (conservative — a code can never stretch
    // to maxUses+1 through retries).
    promo.uses = Array.isArray(promo.uses) ? promo.uses : [];
    promo.uses.push({ domain: doc.domain, sessionId: p.sessionId, at: new Date().toISOString() });
    await s.setJSON(`promo/${code}`, promo);
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
      if (doc.quoteHistory.length > 20) doc.quoteHistory = doc.quoteHistory.slice(-20);
      const idx = await nextWalletIndex(s);
      const fresh = await deriveAddress(idx);
      doc.quote = { ...q, address: fresh, index: idx };
      await s.setJSON(`domain/${doc.domain}`, doc);
      reverified++;
    }
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
