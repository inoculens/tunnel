/**
 * Short-domain router (single-site setup + Cloudflare SaaS custom domains).
 *
 * Traffic:
 *   tunnel.inoculens.com          → app (pass through, never rewritten)
 *   s.inoculens.com/              → 301 to https://tunnel.inoculens.com/
 *   s.inoculens.com/<code>        → rewrite to resolve (redirect + clicks + interstitial)
 *   <custom-domain>/              → 301 to https://tunnel.inoculens.com/
 *   <custom-domain>/<code>        → rewrite to resolve (same as s.*)
 *
 * Custom domains reach the resolver through Cloudflare SaaS (custom CNAME
 * -> customers.inoculens.com -> Worker tunnel-custom-host, which proxies to
 * https://s.inoculens.com/<code>). Any non-app hostname hitting this site
 * directly is likewise treated as a short-link host below.
 *
 * Slugs repeat across root domains, so the resolver needs the serving host
 * (?h=, set below). The SaaS Worker MUST forward the original custom host
 * (X-Forwarded-Host header, else ?h=) when proxying — otherwise proxied
 * custom-domain links arrive as s.inoculens.com and miss their scoped slug.
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

  const extra = url.search ? `&${url.search.slice(1)}` : "";
  // Forward the serving host explicitly: slugs are scoped per root domain,
  // so the resolver must know WHICH domain's <code> this is (proxied
  // custom-domain traffic may otherwise arrive as s.inoculens.com).
  return context.rewrite(
    `/.netlify/functions/resolve?c=${encodeURIComponent(first)}&h=${encodeURIComponent(host)}${extra}`
  );
};

export const config = { path: "/*" };
