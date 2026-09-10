/**
 * Scheduled payment watcher (hourly). Finds domains with an outstanding
 * Bitcoin quote and checks the address balance via mempool.space. When
 * received sats >= quoted sats, marks the domain paid (and active if DNS
 * ownership is already verified).
 *
 * Netlify runs this automatically thanks to the `config.schedule` export.
 * No cron service needed. Uses only the public mempool.space API.
 */
import { store, listAll, cfConfig, cfEnsureCustomHostname, coverageValid, COVERAGE_YEAR_MS } from "./lib/util.js";

export const config = { schedule: "@hourly" };

function toSats(btcAmount) {
  return Math.round(Number(btcAmount) * 1e8);
}

async function addressBalanceSats(address) {
  const res = await fetch(`https://mempool.space/api/address/${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`mempool.space ${res.status}`);
  const data = await res.json();
  const stats = data?.chain_stats || {};
  return (Number(stats.funded_txo_sum) || 0) - (Number(stats.spent_txo_sum) || 0);
}

export async function handler(event) {
  // Note: scheduled invocations carry no HTTP Lambda event, so Blobs access
  // here requires NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN (or NETLIFY_TOKEN) env.
  // Regular request functions bind via connectLambda(event) instead.
  const s = store(event);
  let checked = 0;
  let activated = 0;
  try {
    for (const b of await listAll(s, "domain/")) {
      const d = await s.get(b.key, { type: "json" });
      if (!d) continue;
      // Coverage sweep (hourly): lapsed domains drop back to pending and
      // shed dead discounts, so minting/serving gates stay truthful even if
      // nobody opens the domain manager. Lifetime coverage never lapses.
      let swept = false;
      if (d.discount?.expiresAt && new Date(d.discount.expiresAt).getTime() <= Date.now()) {
        d.discount = null;
        swept = true;
      }
      if (!coverageValid(d) && d.status === "active") {
        d.status = "pending_verification";
        swept = true;
      }
      if (swept) await s.setJSON(`domain/${d.domain}`, d);
      // Balance check candidates: unpaid domains always; paid domains only
      // when a renewal is actually outstanding — coverage lapsed plus a
      // fresh, unconsumed quote issued after the last payment. (A consumed
      // quote's address was already credited; re-checking it would instantly
      // "re-pay" every renewal.)
      const unpaid = d.paymentStatus !== "paid";
      const lastPaidAt = d.lastPaymentAt ? new Date(d.lastPaymentAt).getTime() : 0;
      const renewalQuote = d.quote?.address && d.quote?.amount && !d.quote?.paidAt
        && (d.quote.createdAt ? new Date(d.quote.createdAt).getTime() : 0) > lastPaidAt;
      const renewalDue = d.paymentStatus === "paid" && !coverageValid(d) && renewalQuote;
      if (!unpaid && !renewalDue) continue;
      // Candidates: the current quote address ALWAYS (even expired — the user
      // saw it and may pay late) + retired quotes. Retired addresses were
      // displayed to this session, so late payments to them must still credit
      // the domain — amounts locked at display time.
      const candidates = [];
      if (d.quote?.address && d.quote?.amount) {
        candidates.push({ address: d.quote.address, amount: d.quote.amount, current: true });
      }
      for (const h of Array.isArray(d.quoteHistory) ? d.quoteHistory : []) {
        if (h?.address && h?.amount) candidates.push({ address: h.address, amount: h.amount, current: false });
      }
      if (!candidates.length) continue;
      checked++;
      try {
        let paidBy = null;
        for (const c of candidates) {
          const bal = await addressBalanceSats(c.address);
          if (bal >= toSats(c.amount)) {
            paidBy = c;
            break;
          }
        }
        if (paidBy) {
          const now = Date.now();
          d.paymentStatus = "paid";
          // Coverage: a payment buys a year, stacking onto any time left so
          // early renewals never lose days. While a discount code is still
          // valid it caps coverage at the code's expiry (code expiry doubles
          // as domain expiry); a code that already lapsed before this payment
          // doesn't void it — the address shown was a good-faith quote.
          const currentExp = coverageValid(d) ? new Date(d.coverageExpiresAt).getTime() : now;
          let exp = Math.max(now, currentExp) + COVERAGE_YEAR_MS;
          if (d.discount?.expiresAt) {
            const cap = new Date(d.discount.expiresAt).getTime();
            if (Number.isFinite(cap) && cap > now) exp = Math.min(exp, cap);
          }
          // Lifetime coverage is never downgraded by a later payment.
          if (d.coverageLifetime !== true) {
            d.coverageExpiresAt = new Date(exp).toISOString();
            d.coverageLifetime = false;
          }
          d.lastPaymentAt = new Date(now).toISOString();
          if (d.isVerified && coverageValid(d)) d.status = "active";
          d.paidAddress = paidBy.address;
          d.paidAmount = paidBy.amount;
          if (d.quote) d.quote.paidAt = new Date().toISOString();
          // Provision Cloudflare SaaS hostname so TLS issues immediately after payment.
          if (cfConfig() && d.isVerified) {
            try {
              const cf = await cfEnsureCustomHostname(d.domain);
              if (cf) {
                d.cfHostnameId = cf.id || null;
                d.cfHostnameStatus = cf.status || null;
                d.cfSslStatus = cf.ssl?.status || null;
              }
            } catch (e) {
              console.error(`SaaS ensure failed for ${d.domain}:`, e?.message || e);
            }
          }
          await s.setJSON(`domain/${d.domain}`, d);
          activated++;
        }
      } catch (e) {
        console.error(`balance check failed for ${d.domain}:`, e);
      }
    }
  } catch (e) {
    console.error("payment watcher failed:", e);
    return { statusCode: 500, body: "watcher error" };
  }
  console.log(`payment watcher: checked=${checked} activated=${activated}`);
  return { statusCode: 200, body: `checked=${checked} activated=${activated}` };
}
