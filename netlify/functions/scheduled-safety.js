/**
 * Scheduled safety re-scan (hourly). Re-checks recent/popular links against
 * Safe Browsing (24h Blobs cache) + local blocklist. Flags late-compromised
 * targets as quarantined so resolve.js 404s them without any redirect-time
 * API latency. Quarantine is sticky until an admin clears it (no flapping).
 *
 * Like scheduled-payments, this has no HTTP event and needs NETLIFY_SITE_ID
 * + NETLIFY_BLOBS_TOKEN (or NETLIFY_TOKEN) for Blobs access.
 */
import { store, listAll, freshGet, mapWithConcurrency, checkUrlSafety, linkKey } from "./lib/util.js";

export const config = { schedule: "@hourly" };

const MAX_LINKS_PER_RUN = 300;
const RECENT_MS = 7 * 86400000;

export async function handler(event) {
  const s = store(event);
  let scanned = 0;
  let quarantined = 0;
  try {
    const blobs = await listAll(s, "link/");
    // Bound the run: prefer recently created links (late compromise window)
    // plus already-quarantined (skip — sticky). Fetch bodies in batches.
    const docs = await mapWithConcurrency(blobs.slice(0, 2000), 12, (b) =>
      freshGet(s, b.key, { type: "json" }).catch(() => null)
    );
    const now = Date.now();
    const candidates = docs
      .filter((l) => l && l.original && !l.quarantined)
      .filter((l) => {
        const age = now - (Number(l.createdAt) || 0);
        return age >= 0 && age < RECENT_MS;
      })
      .sort((a, b) => (b.clickCount || 0) - (a.clickCount || 0))
      .slice(0, MAX_LINKS_PER_RUN);
    for (const link of candidates) {
      scanned++;
      try {
        const verdict = await checkUrlSafety(s, String(link.original));
        if (verdict && verdict.safe === false) {
          link.quarantined = true;
          link.quarantineReason = verdict.reason || "UNSAFE";
          link.quarantineAt = new Date().toISOString();
          await s.setJSON(linkKey(link.domain || "unknown", link.code), link);
          quarantined++;
        }
      } catch (e) {
        console.error(`safety rescan failed for ${link.code}:`, e?.message || e);
      }
    }
    // Root routing targets get the same screening: an unsafe apexTarget is
    // cleared so bare-domain visitors land on the app home instead of malware.
    // Bounded like the link scan; failures fail open (next hour retries).
    try {
      const domainBlobs = await listAll(s, "domain/");
      const domainDocs = await mapWithConcurrency(domainBlobs.slice(0, 500), 12, (b) =>
        freshGet(s, b.key, { type: "json" }).catch(() => null)
      );
      for (const d of domainDocs) {
        try {
          if (!d || typeof d.apexTarget !== "string" || !d.apexTarget) continue;
          const verdict = await checkUrlSafety(s, String(d.apexTarget));
          if (verdict && verdict.safe === false) {
            console.error(`safety rescan clearing unsafe apexTarget on ${d.domain}: ${verdict.reason}`);
            d.apexTarget = null;
            d.apexUpdatedAt = new Date().toISOString();
            await s.setJSON(`domain/${d.domain}`, d);
          }
        } catch (e) {
          console.error(`safety apex rescan failed for ${d && d.domain}:`, e?.message || e);
        }
      }
    } catch (e) {
      console.error("safety apex rescan failed:", e?.message || e);
    }
  } catch (e) {
    console.error("safety watcher failed:", e);
    return { statusCode: 500, body: "safety watcher error" };
  }
  console.log(`safety watcher: scanned=${scanned} quarantined=${quarantined}`);
  return { statusCode: 200, body: `scanned=${scanned} quarantined=${quarantined}` };
}
