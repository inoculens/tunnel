/**
 * Scheduled payment watcher (hourly). Finds domains with an outstanding
 * Bitcoin quote and checks the address balance via mempool.space. When
 * received sats >= quoted sats, marks the domain paid (and active if DNS
 * ownership is already verified).
 *
 * Netlify runs this automatically thanks to the `config.schedule` export.
 * No cron service needed. Uses only the public mempool.space API.
 */
import { store } from "./lib/util.js";

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

export async function handler() {
  const s = store();
  let checked = 0;
  let activated = 0;
  let cursor;
  try {
    do {
      const page = await s.list({ prefix: "domain/", cursor });
      for (const b of page.blobs || []) {
        const d = await s.get(b.key, { type: "json" });
        if (!d || d.paymentStatus === "paid" || !d.quote?.address || !d.quote?.amount) continue;
        if (new Date(d.quote.expiresAt).getTime() < Date.now()) continue;
        checked++;
        try {
          const bal = await addressBalanceSats(d.quote.address);
          if (bal >= toSats(d.quote.amount)) {
            d.paymentStatus = "paid";
            if (d.isVerified) d.status = "active";
            d.quote.paidAt = new Date().toISOString();
            await s.setJSON(`domain/${d.domain}`, d);
            activated++;
          }
        } catch (e) {
          console.error(`balance check failed for ${d.domain}:`, e);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  } catch (e) {
    console.error("payment watcher failed:", e);
    return { statusCode: 500, body: "watcher error" };
  }
  console.log(`payment watcher: checked=${checked} activated=${activated}`);
  return { statusCode: 200, body: `checked=${checked} activated=${activated}` };
}
