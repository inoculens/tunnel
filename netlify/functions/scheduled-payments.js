/**
 * Scheduled payment watcher (hourly). Finds domains with an outstanding
 * Bitcoin quote and checks the address balance via mempool.space. When
 * received sats >= quoted sats, marks the domain paid (and active if DNS
 * ownership is already verified).
 *
 * Netlify runs this automatically thanks to the `config.schedule` export.
 * No cron service needed. Uses only the public mempool.space API.
 */
import { store, listAll, cfConfig, cfEnsureCustomHostname } from "./lib/util.js";

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
      if (!d || d.paymentStatus === "paid") continue;
      // Candidates: current quote (if unexpired) + retired quotes. Retired
      // addresses were displayed to this session, so late payments to them
      // must still credit the domain — amounts locked at display time.
      const candidates = [];
      if (d.quote?.address && d.quote?.amount && new Date(d.quote.expiresAt).getTime() >= Date.now()) {
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
          d.paymentStatus = "paid";
          if (d.isVerified) d.status = "active";
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
