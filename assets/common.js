/**
 * INOCULENS Tunnel - Common JavaScript logic
 * Unified navigation and utility functions
 */

// Mobile Menu Logic
function toggleMobileMenu(open) {
  const drawer = document.getElementById('mobileDrawer');
  const overlay = document.getElementById('drawerOverlay');
  if (!drawer || !overlay) return;
  if (open) {
    drawer.classList.add('active');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  } else {
    drawer.classList.remove('active');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }
}

// --- Analytics consent (GDPR) ---
// Google Analytics / gtag loads ONLY after the visitor accepts. Choice is
// stored in localStorage ('tunnel_consent' = 'granted' | 'denied').
// Each page head contains a consent-default-denied gtag stub; this module
// injects the loader + config on accept (or on load if already granted).
// Scoped to the app host only: short-link/redirect origins (s.*,
// custom domains, infra hosts) never load analytics, even with consent set.
(function () {
  var GA_ID = 'G-40PHLHE0JN';
  var CONSENT_KEY = 'tunnel_consent';

  function appHostAllowed() {
    try {
      var h = window.location.hostname || '';
      return h === 'tunnel.inoculens.com' ||
        h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
    } catch (e) { return false; }
  }

  function storageGet(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return null; }
  }
  function storageSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) {}
  }

  function loadGtag() {
    if (!appHostAllowed()) return;
    if (window.__tunnelGtagLoaded) return;
    window.__tunnelGtagLoaded = true;
    try {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
      document.head.appendChild(s);
      window.gtag('js', new Date());
      window.gtag('config', GA_ID);
    } catch (e) { /* analytics must never break the page */ }
  }

  function setConsent(granted) {
    storageSet(CONSENT_KEY, granted ? 'granted' : 'denied');
    try {
      window.gtag = window.gtag || function () { (window.dataLayer = window.dataLayer || []).push(arguments); };
      window.gtag('consent', 'update', {
        ad_storage: granted ? 'granted' : 'denied',
        analytics_storage: granted ? 'granted' : 'denied'
      });
    } catch (e) {}
    if (granted) loadGtag();
    var banner = document.getElementById('consentBanner');
    if (banner) banner.remove();
  }

  function showBanner() {
    if (document.getElementById('consentBanner')) return;
    var banner = document.createElement('div');
    banner.id = 'consentBanner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Analytics consent');
    banner.innerHTML =
      '<span class="consent-text">We use Google Analytics to understand usage and improve Tunnel. Allow analytics cookies?</span>' +
      '<span class="consent-actions">' +
      '<button type="button" class="consent-btn consent-accept">Accept</button>' +
      '<button type="button" class="consent-btn consent-decline">Decline</button>' +
      '</span>';
    document.body.appendChild(banner);
    var accept = banner.querySelector('.consent-accept');
    var decline = banner.querySelector('.consent-decline');
    if (accept) accept.addEventListener('click', function () { setConsent(true); });
    if (decline) decline.addEventListener('click', function () { setConsent(false); });
  }

  window.tunnelSetConsent = setConsent;

  function initConsent() {
    // Off the app host: no banner, no loader, no stored-choice reads that
    // could fire anything — redirect origins stay fully untracked.
    if (!appHostAllowed()) return;
    var choice = storageGet(CONSENT_KEY);
    if (choice === 'granted') {
      loadGtag();
    } else if (choice !== 'denied') {
      showBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsent);
  } else {
    initConsent();
  }
})();
