/**
 * Short-link resolver: GET /.netlify/functions/resolve?c=<code>
 * Logs the click (truncated IP), bumps the counter, then issues an immediate
 * 302 to the original URL — for EVERY link, including social/deep links.
 *
 * Deliberately no interstitial page: the end user must land straight on the
 * content. Native-app opening is left to the OS (iOS Universal Links /
 * Android App Links): when the app is installed the OS takes the user there
 * directly; when it isn't, the browser simply loads the page. That is the
 * fallback — no Tunnel-branded stopover in between, ever.
 * Unknown/expired codes → 302 to the branded /404 page (keeps ?c= and ?h=
 * for display, so the page shows the short domain actually visited —
 * s.inoculens.com or the user's custom domain — never tunnel.inoculens.com).
 *
 * Wire-up: netlify/edge-functions/short-domain.js rewrites short-host paths
 * to this function (GET /.netlify/functions/resolve?c=<code>).
 */
import { store, newClickId, clientIp, trustedRawIp, systemShortHost, coverageValid, cleanDomain, linkKey, clicksPrefix, freshGet, getWithRetry, shouldStoreClickDetail, bumpDayCount } from "./lib/util.js";

const HOME = process.env.HOME_URL || "https://tunnel.inoculens.com/";

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

  // Slugs repeat across root domains, so the serving host is part of the
  // identity. The edge router passes it as ?h=; SaaS Worker proxies must
  // forward the original host (X-Forwarded-Host) or the lookup 404s.
  // Direct hits fall back to the request Host header.
  const headers = event.headers || {};
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) lowered[String(k).toLowerCase()] = v;
  const fwd = (lowered["x-forwarded-host"] || lowered["x-original-host"] || "").toString().split(",")[0].trim();
  const rawHost = (qs.h || fwd || lowered.host || "").toString().split(",")[0].trim().split(":")[0];
  const host = cleanDomain(rawHost);
  if (!host) {
    return { statusCode: 302, headers: { Location: HOME, "Cache-Control": "no-store" } };
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
  // Always 302. Same-IP loops still redirect but only bump the daily counter
  // past the per-minute detail budget (distinct IPs each get full budget, so
  // viral + dumb repeats are fully stored).
  try {
    const rawIp = trustedRawIp(event);
    const storeDetail = await shouldStoreClickDetail(s, host, link.code, rawIp);
    if (storeDetail) {
      const id = newClickId();
      await s.setJSON(`${clicksPrefix(host, link.code)}${id}`, {
        id,
        timestamp: Date.now(),
        ip: clientIp(event),
      });
    } else {
      await s.setJSON(`${clicksPrefix(host, link.code)}flood-${Date.now().toString(36)}`, {
        id: `flood-${Date.now().toString(36)}`,
        timestamp: Date.now(),
        ip: clientIp(event),
        flood: true,
      }).catch(() => {});
    }
    link.clickCount = (link.clickCount || 0) + 1;
    await s.setJSON(linkKey(host, link.code), link);
    await bumpDayCount(s, host, link.code, 1);
  } catch (e) {
    console.error("click log failed:", e);
  }

  // Seamless handoff: straight to the content. The OS opens the native app
  // when it is installed (universal/app links); otherwise the browser loads
  // the page. No interstitial, no Tunnel UI in between. (Legacy ?direct=1
  // links in the wild keep working — everything is direct now.)
  return {
    statusCode: 302,
    headers: { Location: link.original, "Cache-Control": "no-store" },
  };
}
