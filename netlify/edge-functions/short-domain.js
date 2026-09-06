/**
 * Short-domain router for s.inoculens.com (single-site setup).
 *
 * Both tunnel.inoculens.com (app) and s.inoculens.com (short links) point at
 * this ONE Netlify site and share the same Blobs store. This edge function
 * dispatches short-domain traffic before static serving:
 *
 *   s.inoculens.com/            → 301 to https://tunnel.inoculens.com/
 *   s.inoculens.com/<code>      → rewrite to the resolve function
 *                                 (redirector + click logging + app interstitial)
 *   everything else, or any other hostname → pass through untouched
 *   (assets, app pages, API, main-domain traffic).
 *
 * The index.html root-redirect script is kept as a belt-and-braces fallback
 * for "/" on the short domain.
 */
export default async (request, context) => {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.hostname !== "s.inoculens.com") return;

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
  return context.rewrite(
    `/.netlify/functions/resolve?c=${encodeURIComponent(first)}${extra}`
  );
};

export const config = { path: "/*" };
