/**
 * INOCULENS Tunnel API — single Netlify Function routing all backend actions.
 * Replaces the Firebase `functions.httpsCallable(...)` surface 1:1 so the
 * existing frontend keeps working unchanged (see frontend api shim).
 *
 * POST /.netlify/functions/api  { action: "<name>", ...params }
 * Success: 200 + JSON payload. Failure: { error: { code, message } }.
 */
import {
  store,
  json,
  ok,
  fail,
  validSessionId,
  validSlug,
  cleanDomain,
  validHttpUrl,
  newCode,
  newToken,
  newClickId,
  detectPlatform,
  clientIp,
  checkRate,
  verifyDns,
  routingTarget,
  systemShortHost,
  dcvDelegationTargetFor,
  dcvDelegationSuffix,
  isInZoneCustomDomain,
  isApexDomain,
  apexBlockedMessage,
  sslDelegationTarget,
  cfConfig,
  cfGetCustomHostname,
  cfEnsureCustomHostname,
  cfDeleteCustomHostname,
  btcUsdPrice,
  quoteFor,
  discountCodes,
  deriveAddress,
  nextWalletIndex,
  listAll,
} from "./lib/util.js";

// Ensure a Cloudflare SaaS custom hostname exists once the domain is
// verified + paid. Best effort: DNS ownership remains the source of truth;
// SaaS failures are logged and surfaced via cf fields, never block payment.
async function ensureSaaSHostname(doc) {
  // In-zone subdomains need no SaaS object: Universal *.apex certificate +
  // Worker route already cover them once the CNAME exists.
  if (isInZoneCustomDomain(doc.domain)) return null;
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

async function getLink(s, code) {
  if (typeof code !== "string" || !code) return null;
  return s.get(`link/${code}`, { type: "json" });
}

async function needLink(s, code) {
  const link = await getLink(s, code);
  if (!link) {
    const e = new Error("Link not found. It may have been deleted.");
    e.statusCode = 404;
    e.code = "not-found";
    throw e;
  }
  return link;
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

async function domainInfo(doc) {
  const route = routingTarget();
  return {
    domain: doc.domain,
    id: doc.domain,
    status: doc.status,
    paymentStatus: doc.paymentStatus,
    isVerified: doc.isVerified,
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
      isInZone: isInZoneCustomDomain(doc.domain),
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

async function deleteClickKeys(s, code) {
  for (const b of await listAll(s, `clicks/${code}/`)) {
    await s.delete(b.key);
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
      if (await getLink(s, customSlug)) {
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
        if (!(await getLink(s, c))) code = c;
      }
      if (!code) {
        const e = new Error("Could not allocate a short code, try again.");
        e.statusCode = 503;
        e.code = "unavailable";
        throw e;
      }
    }

    // Custom domains must be active before they can mint links.
    // System host is always allowed; everything else must be an active
    // domain owned by this session (Cloudflare SaaS provisions TLS).
    if (host !== systemShortHost()) {
      const doc = await s.get(`domain/${host}`, { type: "json" });
      const usable =
        doc && doc.sessionId === sessionId && doc.status === "active";
      if (!usable) {
        const e = new Error("permission-denied");
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
    await s.setJSON(`link/${code}`, link);
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

  async migrateLegacyLinks(s, p) {
    if (!validSessionId(p.sessionId)) return fail(400, "invalid-argument", "Invalid session.");
    if (!(await getSession(s, p.sessionId))) {
      await s.setJSON(`sessions/${p.sessionId}`, { createdAt: Date.now() });
    }
    const items = Array.isArray(p.links) ? p.links : [];
    for (const { code, deleteToken } of items.slice(0, 500)) {
      const l = await getLink(s, code);
      if (l && l.deleteToken === deleteToken) {
        l.sessionId = p.sessionId;
        await s.setJSON(`link/${code}`, l);
      }
    }
    return ok({});
  },

  async deleteUrl(s, p) {
    const link = await needLink(s, p.shortCode);
    needToken(link, p.deleteToken);
    await s.delete(`link/${link.code}`);
    await deleteClickKeys(s, link.code);
    return ok({});
  },

  async updateLinkLabel(s, p) {
    const link = await needLink(s, p.shortCode);
    needToken(link, p.deleteToken);
    link.label = String(p.label || "").slice(0, 60);
    await s.setJSON(`link/${link.code}`, link);
    return ok({});
  },

  // ----- stats -----

  async getClickStats(s, p) {
    const link = await needLink(s, p.shortCode);
    needToken(link, p.deleteToken);
    const clicks = [];
    for (const b of await listAll(s, `clicks/${link.code}/`)) {
      const c = await s.get(b.key, { type: "json" });
      if (c) clicks.push(c);
    }
    clicks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return ok({ clickCount: link.clickCount || 0, clicks });
  },

  async deleteAllClicks(s, p) {
    const link = await needLink(s, p.shortCode);
    needToken(link, p.deleteToken);
    await deleteClickKeys(s, link.code);
    link.clickCount = 0;
    await s.setJSON(`link/${link.code}`, link);
    return ok({});
  },

  async deleteClickEntry(s, p) {
    const link = await needLink(s, p.shortCode);
    needToken(link, p.deleteToken);
    await s.delete(`clicks/${link.code}/${p.clickId}`);
    link.clickCount = Math.max(0, (link.clickCount || 1) - 1);
    await s.setJSON(`link/${link.code}`, link);
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
      await s.setJSON(`link/${l.code}`, l);
    }
    return ok({ success: true, count: links.length });
  },

  // ----- custom domains -----

  async getUserDomains(s, p) {
    await needSession(s, p.sessionId);
    const out = [];
    for (const b of await listAll(s, "domain/")) {
      const d = await s.get(b.key, { type: "json" });
      if (d && d.sessionId === p.sessionId) out.push(await domainInfo(d));
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
        return fail(409, "already-exists", "This domain is already managed by another session.");
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
      cfHostnameStatus: null,
      cfSslStatus: null,
    }));
    doc.dnsVerification = {
      cnameValid: !!live.cname,
      txtVerified: !!live.txt,
      sslVerified: !!live.ssl,
    };
    if (live.cfHostnameStatus) doc.cfHostnameStatus = live.cfHostnameStatus;
    if (live.cfSslStatus) doc.cfSslStatus = live.cfSslStatus;
    // Sticky ownership: once proven, stays proven (matches frontend).
    if (live.cname && live.txt) doc.isVerified = true;
    // If verified + paid, ensure the SaaS custom hostname exists so TLS provisions.
    if (doc.isVerified && doc.paymentStatus === "paid") {
      await ensureSaaSHostname(doc);
      // Re-read live SaaS status after ensure (it may have just been created -> pending).
      const cf = cfConfig() ? await cfGetCustomHostname(doc.domain) : null;
      if (cf) {
        doc.cfHostnameId = cf.id || doc.cfHostnameId || null;
        doc.cfHostnameStatus = cf.status || null;
        doc.cfSslStatus = cf.ssl?.status || null;
        doc.dnsVerification.sslVerified = cf.ssl?.status === "active" ? true : doc.dnsVerification.sslVerified;
      }
      // Active requires ownership + payment. TLS (cfSslStatus active) is reported
      // separately so the UI can show "Propagating" without blocking link creation
      // once DNS + payment are done. Links serve as soon as CNAME resolves (HTTP
      // validation completes in minutes); strict TLS gating would strand paid users.
      doc.status = "active";
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    return ok({
      success: true,
      isVerified: doc.isVerified,
      checks: { cname: !!live.cname, txt: !!live.txt, ssl: !!doc.dnsVerification.sslVerified },
      cfHostnameStatus: doc.cfHostnameStatus || live.cfHostnameStatus || null,
      cfSslStatus: doc.cfSslStatus || live.cfSslStatus || null,
      status: doc.status,
      paymentStatus: doc.paymentStatus,
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

  async generatePaymentAddress(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    const dns = doc.dnsVerification || {};
    // Exact substring the frontend matches on — keep stable.
    if (!(dns.cnameValid && dns.txtVerified)) {
      return fail(412, "failed-precondition", "DNS verification required before payment.");
    }
    const now = Date.now();
    if (!p.forceRefresh && doc.quote && doc.quote.address && new Date(doc.quote.expiresAt).getTime() > now) {
      return ok({
        amount: doc.quote.amount,
        address: doc.quote.address,
        expiresAt: doc.quote.expiresAt,
        ...(doc.quote.discountPercent ? { discountPercent: doc.quote.discountPercent, originalAmount: doc.quote.originalAmount } : {}),
      });
    }
    const price = await btcUsdPrice().catch((e) => {
      throw Object.assign(new Error(e.message), { statusCode: 503, code: "unavailable" });
    });
    const pct = doc.discount ? doc.discount.percent : 0;
    const q = quoteFor(pct, price);
    let address = doc.quote && doc.quote.address && !p.forceRefresh ? doc.quote.address : null;
    if (!address) {
      const idx = await nextWalletIndex(s);
      try {
        address = await deriveAddress(idx);
      } catch (e) {
        return fail(e.statusCode || 412, e.code || "failed-precondition", e.message);
      }
      doc.quote = { ...q, address, index: idx };
    } else {
      doc.quote = { ...q, address, index: doc.quote.index };
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    return ok({ amount: doc.quote.amount, address, expiresAt: doc.quote.expiresAt, ...(q.discountPercent ? { discountPercent: q.discountPercent, originalAmount: q.originalAmount } : {}) });
  },

  async checkDomainDiscount(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    if (doc.discount && doc.discount.percent > 0) {
      return ok({
        hasDiscount: true,
        discountCode: doc.discount.code,
        discountPercent: doc.discount.percent,
        amount: doc.quote ? doc.quote.amount : undefined,
        originalAmount: doc.quote ? doc.quote.originalAmount : undefined,
      });
    }
    return ok({ hasDiscount: false });
  },

  async applyDiscountCode(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    const code = String(p.code || "").trim().toUpperCase();
    const pct = discountCodes()[code];
    if (!code || !pct) return fail(400, "invalid-argument", "Invalid or expired discount code.");
    doc.discount = { code, percent: pct };
    if (pct >= 100) {
      doc.paymentStatus = "paid";
      doc.quote = null;
      if (doc.isVerified) {
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
      });
    }
    // Regenerate quote at the discounted price.
    const price = await btcUsdPrice().catch((e) => {
      throw Object.assign(new Error(e.message), { statusCode: 503, code: "unavailable" });
    });
    const q = quoteFor(pct, price);
    let address = doc.quote && doc.quote.address ? doc.quote.address : null;
    if (!address) {
      const idx = await nextWalletIndex(s);
      try {
        address = await deriveAddress(idx);
      } catch (e) {
        return fail(e.statusCode || 412, e.code || "failed-precondition", e.message);
      }
      doc.quote = { ...q, address, index: idx };
    } else {
      doc.quote = { ...q, address, index: doc.quote.index };
    }
    await s.setJSON(`domain/${doc.domain}`, doc);
    return ok({
      discounted: true,
      amount: doc.quote.amount,
      address,
      expiresAt: doc.quote.expiresAt,
      discountPercent: pct,
      originalAmount: q.originalAmount,
    });
  },

  async removeDiscountCode(s, p) {
    const doc = await needOwnedDomain(s, p.domain, p.sessionId);
    doc.discount = null;
    await s.setJSON(`domain/${doc.domain}`, doc);
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
