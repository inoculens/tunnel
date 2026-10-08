#!/usr/bin/env node
/**
 * Submit Tunnel URLs to IndexNow (Bing, Yandex, Naver, Seznam, etc.).
 * Google / Brave / DuckDuckGo do NOT use IndexNow — they rely on
 * sitemap.xml + normal crawling (already configured via robots.txt).
 *
 * Usage:
 *   node scripts/indexnow-submit.mjs
 *   node scripts/indexnow-submit.mjs https://tunnel.inoculens.com/about
 *
 * Reads urls from sitemap.xml by default. Requires the key file to be
 * live at https://tunnel.inoculens.com/<key>.txt before submitting,
 * otherwise the API returns 403.
 */
import { readFileSync } from "node:fs";

const HOST = "tunnel.inoculens.com";
const KEY = "970d849437874e50b415bd509c68ec33";
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const ENDPOINT = "https://api.indexnow.org/IndexNow";

function urlsFromSitemap() {
  const xml = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

const argUrls = process.argv.slice(2).filter((a) => a.startsWith("http"));
const urlList = argUrls.length ? argUrls : urlsFromSitemap();

const body = JSON.stringify({
  host: HOST,
  key: KEY,
  keyLocation: KEY_LOCATION,
  urlList,
});

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body,
});
const text = await res.text().catch(() => "");
console.log(`IndexNow ${res.status} for ${urlList.length} URL(s)`);
if (text) console.log(text.slice(0, 500));
if (!res.ok) process.exitCode = 1;
