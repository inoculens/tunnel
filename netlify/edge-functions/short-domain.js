/**
 * Short-domain router (single-site setup + Cloudflare SaaS custom domains).
 *
 * Traffic:
 *   tunnel.inoculens.com          → app (pass through, never rewritten)
 *   s.inoculens.com/              → 301 to https://tunnel.inoculens.com/
 *   s.inoculens.com/<code>        → rewrite to resolve (click log + instant 302, no interstitial)
 *   <custom-domain>/              → 301 to https://tunnel.inoculens.com/
 *   <custom-domain>/<code>        → rewrite to resolve (same as s.*)
 *
 * Custom domains reach the resolver through Cloudflare SaaS (custom CNAME
 * -> customers.inoculens.com -> Worker tunnel-custom-host, which proxies to
 * https://s.inoculens.com/<code>). Any non-app hostname hitting this site
 * directly is likewise treated as a short-link host below.
 *
 * Slugs repeat across root domains, so the resolver needs the serving host.
 * The SaaS Worker MUST forward the original custom host (X-Forwarded-Host
 * header, else ?h=) when proxying — otherwise proxied custom-domain links
 * arrive as s.inoculens.com and miss their scoped slug.
 *
 * Code and host are passed via X-Tunnel-Code / X-Tunnel-Host request headers
 * (not query params). This prevents the platform from grafting internal query
 * params onto the resolve function's outgoing Location header — which would
 * corrupt redirect targets containing a # fragment.
 *
 * This edge function is the sole "/" handler for short domains.
 */
const APP_HOSTS = new Set(["tunnel.inoculens.com"]);

export default async (request, context) => {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  const host = url.hostname.toLowerCase();
  // App host serves the site normally.
  if (APP_HOSTS.has(host)) return;
  // SaaS infrastructure hosts should never serve short links directly.
  if (host === "customers.inoculens.com" || host === "proxy-fallback.inoculens.com") {
    return Response.redirect("https://tunnel.inoculens.com/", 302);
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return Response.redirect("https://tunnel.inoculens.com/", 301);
  }

  const first = url.pathname.split("/").filter(Boolean)[0] || "";

  // Static assets, app pages, and files are never short codes.
  if (
    !first ||
    first.includes(".") ||
    first === "assets" ||
    first === "visuals" ||
    first === ".netlify" ||
    ["about", "pricing", "terms", "sitemap.xml", "robots.txt"].includes(first)
  ) {
    return;
  }

  // Identity for the resolver travels via headers, not query (see header).
  // Code comes from the path (authoritative for short links). Host prefers a
  // validated SaaS-forwarded host (?h= / X-Forwarded-Host from the Worker —
  // custom-domain traffic arrives here as s.inoculens.com), else arrival.
  // Strict checks keep header values byte-safe (headers.set throws on CRLF).
  const fwdH = url.searchParams.get("h")
    || request.headers.get("x-forwarded-host")
    || request.headers.get("x-original-host")
    || "";
  const fwdHost = fwdH.split(",")[0].trim().toLowerCase();
  const effHost = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(fwdHost) && fwdHost.length <= 253
    ? fwdHost
    : host;

  // Header path only for byte-safe ASCII slugs (all real slugs match). Anything
  // else can never equal a stored code, so it takes the legacy query rewrite
  // and lands on the branded 404 (whose destination never carries grafts).
  if (/^[A-Za-z0-9_-]{1,30}$/.test(first)) {
    request.headers.set("x-tunnel-code", first);
    request.headers.set("x-tunnel-host", effHost);
    return context.rewrite("/.netlify/functions/resolve");
  }
  // Visitor query params (?utm_source etc.) are intentionally not forwarded:
  // the resolve function never used them, and the redirect lands on
  // link.original exactly as stored.
  return context.rewrite(
    `/.netlify/functions/resolve?c=${encodeURIComponent(first)}&h=${encodeURIComponent(effHost)}`
  );
};

export const config = { path: "/*" };
