/* INOCULENS Tunnel app logic (split from index.html, APP_VERSION 20260914).
   Classic script, loaded with defer (DOM parsed first, order preserved).
   Bump ?v= in index.html when editing this file. */
      (function() {
        const texts = [
          'FREE deeplinking for YouTube, Instagram and more',
          'FREE & UNLIMITED stats for your links',
          'Add your own custom domain'
        ];
        let currentIndex = 0;
        const marqueeText = document.getElementById('marqueeText');
        const marqueeBox = marqueeText ? marqueeText.parentElement : null;
        const isMobile = window.matchMedia('(max-width: 500px)').matches;
        const animDuration = isMobile ? 600 : 800;
        const holdDuration = 3000;
        // Horizontal chrome around the text (padding + border), measured
        // once so the eased width can be computed in exact pixels.
        const marqueePadX = (marqueeBox && !isMobile)
          ? marqueeBox.offsetWidth - marqueeText.offsetWidth
          : 0;

        function marqueeTargetWidth() {
          if (!marqueeBox) return 0;
          const full = marqueeText.scrollWidth + marqueePadX;
          const cap = marqueeBox.parentElement ? marqueeBox.parentElement.clientWidth : full;
          return Math.max(0, Math.min(full, cap));
        }

        function raceIn() {
          // Freeze the pill at its current width, swap the text, then ease
          // to the new width in pixels (CSS cannot ease to fit-content).
          if (!isMobile && marqueeBox) {
            marqueeBox.style.transition = 'none';
            marqueeBox.style.width = marqueeBox.offsetWidth + 'px';
          }
          marqueeText.textContent = texts[currentIndex];
          marqueeText.className = 'marquee-text racing-in';

          if (!isMobile && marqueeBox) {
            const target = marqueeTargetWidth();
            if (Math.abs(target - marqueeBox.offsetWidth) > 1) {
              void marqueeBox.offsetWidth; // reflow so the change eases
              marqueeBox.style.transition = '';
              marqueeBox.style.width = target + 'px';
              marqueeBox.addEventListener('transitionend', function release(e) {
                if (e.propertyName !== 'width') return;
                marqueeBox.removeEventListener('transitionend', release);
                marqueeBox.style.width = '';
              });
            } else {
              marqueeBox.style.transition = '';
              marqueeBox.style.width = '';
            }
          }

          // After race in completes, hold
          setTimeout(function() {
            marqueeText.className = 'marquee-text holding';

            // After hold duration, race out
            setTimeout(raceOut, holdDuration);
          }, animDuration);
        }

        function raceOut() {
          marqueeText.className = 'marquee-text racing-out';
          
          // After race out completes, move to next text
          setTimeout(function() {
            currentIndex = (currentIndex + 1) % texts.length;
            raceIn();
          }, animDuration);
        }

        // Start the animation
        raceIn();
      })();
      // --- GLOBAL STATE ---
      var isSearchActive = false;

      // Utility function for toast notifications.
      // Single fixed stack (bottom-right): concurrent toasts pile upward
      // instead of painting over each other. Equal lifetimes keep FIFO
      // dismiss order; the stack caps at 5, oldest dropped first.
      function toastStack() {
        let stack = document.getElementById('toastStack');
        if (!stack) {
          stack = document.createElement('div');
          stack.id = 'toastStack';
          stack.style.cssText = `
            position: fixed; bottom: 24px; right: 24px; z-index: 100000 !important;
            display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
            max-width: min(360px, calc(100vw - 48px)); pointer-events: none;
          `;
          // Container itself never sits above modals content-wise; toasts are
          // appended here so they can't hide behind the modal overlay.
          document.body.appendChild(stack);
        }
        return stack;
      }
      function showToast(message, type = 'info') {
        const stack = toastStack();
        while (stack.children.length >= 5) stack.firstChild.remove();
        const toast = document.createElement('div');
        toast.style.cssText = `
          padding: 14px 28px; max-width: 100%;
          border-radius: 12px; color: white;
          font-family: sans-serif; font-weight: 500;
          background: ${type === 'error' ? '#f04141' : '#2ba640'};
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4); animation: slideIn 0.3s ease-out;
        `;
        toast.textContent = message;
        stack.appendChild(toast);
        setTimeout(() => {
          toast.style.opacity = '0';
          toast.style.transition = 'opacity 0.5s';
          setTimeout(() => toast.remove(), 500);
        }, 3000);
      }

      // Backend client: same-origin Netlify Functions (/.netlify/functions/api).
      // `functions.httpsCallable` mirrors the action-dispatch call shape.
      // No API keys or credentials live in the frontend: authorization is
      // enforced server-side (session IDs + per-link deleteTokens).
      const API_URL = '/.netlify/functions/api';

      async function apiCall(action, data) {
        let res;
        try {
          res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...(data || {}) })
          });
        } catch (networkErr) {
          const err = new Error('Cannot reach the INOCULENS backend. Check your connection and reload.');
          err.code = 'unavailable';
          throw err;
        }
        let body = null;
        try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
        if (!res.ok) {
          const info = (body && body.error) || {};
          const err = new Error(info.message || `Request failed (${res.status}).`);
          err.code = info.code || `http-${res.status}`;
          throw err;
        }
        return { data: body };
      }

      // Shim with the same call signature the app was built against.
      const functions = {
        httpsCallable: (name) => (data) => apiCall(name, data)
      };
      // Public SaaS config (CNAME target etc.) — backend-driven so a future
      // Cloudflare account move never needs a frontend redeploy for DNS text.
      // Defaults match the INOCULENS account; backend wins when reachable.
      let publicConfig = { routingTarget: 'customers.inoculens.com', systemHost: 's.inoculens.com' };
      (async () => {
        try {
          const res = await apiCall('getPublicConfig', {});
          if (res?.data?.routingTarget) {
            publicConfig = res.data;
            const el = document.getElementById('cnameRecordHost');
            if (el) el.textContent = res.data.routingTarget;
          }
        } catch (e) { /* static defaults stand */ }
      })();
      // Same-origin backend: available unless the network itself fails
      // (individual apiCall failures are caught by each caller).
      let backendReady = true;

      // Friendly guard for any backend call made while offline/uninitialized.
      function requireBackend() {
        if (!backendReady || !functions) {
          showCustomModal({
            title: "Backend Unavailable",
            message: "Cannot reach the INOCULENS backend. Check your connection (or ad-blocker) and reload."
          });
          return false;
        }
        return true;
      }

      // Turnstile (Cloudflare) — risk-based on mint-family calls only, never
      // on link redirects. Backend returns TURNSTILE_REQUIRED only for fast
      // loops / near-quota sessions; this solves one widget and retries once
      // with the token. Missing sitekey = clear error, try again later.
      function ensureTurnstileScript() {
        if (window.turnstile) return Promise.resolve(true);
        return new Promise((resolve) => {
          try {
            const s = document.createElement('script');
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
            s.async = true;
            s.onload = () => resolve(!!window.turnstile);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
            setTimeout(() => resolve(!!window.turnstile), 5000);
          } catch (e) { resolve(false); }
        });
      }
      function showTurnstileChallenge() {
        const sitekey = publicConfig.turnstileSiteKey;
        if (!sitekey) return Promise.resolve(null);
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:60000;display:flex;align-items:center;justify-content:center;padding:20px;overscroll-behavior:contain;';
          overlay.innerHTML = '<div class="modal-card" style="max-width:360px;text-align:center;">'
            + '<div class="modal-title">Quick human check</div>'
            + '<div class="modal-message">Unusual pace detected — solve once to continue.</div>'
            + '<div id="turnstileBox" style="display:flex;justify-content:center;margin-bottom:16px;"></div>'
            + '<button class="modal-btn modal-btn-cancel" id="turnstileCancel" style="width:100%;">Cancel</button></div>';
          const done = (token) => {
            try { overlay.remove(); } catch (e) {}
            unlockScroll();
            resolve(token || null);
          };
          document.body.appendChild(overlay);
          lockScroll();
          overlay.querySelector('#turnstileCancel').onclick = () => done(null);
          ensureTurnstileScript().then((ok) => {
            if (!ok || !window.turnstile) { done(null); return; }
            try {
              window.turnstile.render('#turnstileBox', {
                sitekey,
                callback: (t) => done(t),
                'expired-callback': () => done(null),
                'error-callback': () => done(null),
              });
            } catch (e) { done(null); }
          });
        });
      }

      const SESSION_KEY = 'tunnel_session_id';
      const SESSION_ID_LENGTH = 10; // Authoritative length for all session ID validation

      // Memory cache for links. Parsed defensively: corrupt localStorage must
      // never throw at top level (that would abort boot and strand the loader).
      function loadLocalHistory() {
        try {
          const raw = localStorage.getItem('tunnel_history');
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          console.warn('Corrupt tunnel_history, resetting:', e);
          try { localStorage.removeItem('tunnel_history'); } catch (_) {}
          return [];
        }
      }
      let currentLinks = loadLocalHistory();
      // Own-device creations awaiting server confirmation. Merge keeps
      // these even when a fresh server list omits them (edge-list lag);
      // everything else missing server-side is server truth (deleted
      // elsewhere) and drops on the spot, so refreshes always show the
      // latest state. Persisted for reloads inside the lag window;
      // pruned on server echo, local delete, or age-out.
      const JUST_CREATED_MS = 10 * 60 * 1000;
      let justCreated = new Map();
      function loadJustCreated() {
        const loaded = new Map();
        try {
          const rawJC = localStorage.getItem('tunnel_just_created');
          if (rawJC) {
            const parsedJC = JSON.parse(rawJC);
            if (parsedJC && typeof parsedJC === 'object') {
              const nowJC = Date.now();
              for (const [jk, jts] of Object.entries(parsedJC)) {
                const jt = Number(jts);
                if (typeof jk === 'string' && jk && Number.isFinite(jt) && nowJC - jt >= 0 && nowJC - jt < JUST_CREATED_MS) loaded.set(jk, jt);
              }
            }
          }
        } catch (e) {}
        justCreated = loaded;
      }
      loadJustCreated();
      function saveJustCreated() {
        try {
          const objJC = {};
          for (const [jk, jts] of justCreated) objJC[jk] = jts;
          localStorage.setItem('tunnel_just_created', JSON.stringify(objJC));
        } catch (e) {}
      }
      function justCreatedKey(item) {
        try { return itemKey(item); } catch (e) { return ''; }
      }
      function trackJustCreated(item) {
        const k = justCreatedKey(item);
        if (!k) return;
        justCreated.set(k, Date.now());
        saveJustCreated();
      }
      function untrackJustCreated(itemOrKey) {
        const k = typeof itemOrKey === 'string' ? itemOrKey : justCreatedKey(itemOrKey);
        if (k && justCreated.delete(k)) saveJustCreated();
      }
      function untrackJustCreatedDomain(domain) {
        const d = String(domain || '').toLowerCase();
        if (!d) return;
        let changedJC = false;
        for (const k of [...justCreated.keys()]) {
          if (String(k).split('/')[0].toLowerCase() === d && justCreated.delete(k)) changedJC = true;
        }
        if (changedJC) saveJustCreated();
      }
      // Per-operation locks (a shared flag blocked unrelated actions, e.g. a
      // stats purge blocking link deletion). Keys: 'link', 'links', 'stats', 'entry'.
      const opLocks = new Set();
      function acquireOp(key) {
        if (opLocks.has(key)) return false;
        opLocks.add(key);
        return true;
      }
      function releaseOp(key) {
        opLocks.delete(key);
      }


      // Track expanded mobile dropdowns (in-memory only, resets on page refresh)
      let expandedLinks = new Set();

      // Pagination state
      let currentPage = 1;
      const ITEMS_PER_PAGE = 10;

      // The list currently rendered (after search/domain filter). Pagination
      // operates on THIS array, not on currentLinks (which may be longer).
      let lastRenderedLinks = [];

      // Visibility timers
      let resultTimeout = null;
      let errorTimeout = null;

      // Initial search visibility check
      // Will be updated when renderHistory or renderEmptyState is called

      // Clear inputs on refresh
      document.getElementById('urlInput').value = '';
      document.getElementById('slugInput').value = '';

      // Utility to escape HTML and prevent XSS
      function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        const p = document.createElement('p');
        p.textContent = String(str);
        return p.innerHTML;
      }

      // Attribute-context escaping: escapeHTML does NOT escape quotes, so it
      // is unsafe inside "..." attributes. Use this for title="..." etc.
      function escapeAttr(str) {
        return escapeHTML(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      // Escape a string for use as a JS string literal inside an inline
      // onclick="..." attribute. MUST emit single-quoted literals: the value
      // is interpolated into a double-quoted HTML attribute, so the double
      // quotes from JSON.stringify would terminate the attribute early and
      // every generated button (Short / Original / Full Stats / Delete /
      // labels / domain manager) would throw `SyntaxError` on click.
      // JSON.stringify handles backslashes/newlines; the replaces keep the
      // HTML parser from terminating/decoding early.
      function escapeJS(str) {
        const json = JSON.stringify(String(str === null || str === undefined ? '' : str));
        const inner = json.slice(1, -1).replace(/'/g, "\\'");
        return ("'" + inner + "'")
          .replace(/\\"/g, '\\u0022')
          .replace(/"/g, '\\u0022')
          .replace(/&/g, '\\u0026')
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e')
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029');
      }

      // Only allow http(s) URLs in generated links. Rejects javascript:, data:,
      // etc. that would execute script on click even when HTML-escaped.
      function safeHref(url, fallback) {
        try {
          const u = new URL(String(url), window.location.href);
          if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
        } catch (e) {}
        return fallback || '#';
      }

      // Canonical lookup: links are identified by (root domain, slug) —
      // the same slug may exist on several domains, so code alone is
      // never enough. itemDomain falls back to parsing item.short so
      // cached entries without .domain still resolve. Indexes shift under
      // search/filter/pagination, so lookups are by identity, never index.
      function hostOf(shortUrl) {
        try { return new URL(String(shortUrl)).hostname.toLowerCase(); } catch (e) { return ''; }
      }
      function itemDomain(item) {
        return (item && item.domain) || (item && hostOf(item.short)) || '';
      }
      function itemKey(item) {
        return itemDomain(item) + '/' + (item ? item.code : '');
      }
      function findLinkIndex(code, domain) {
        if (!code) return -1;
        if (!domain) return currentLinks.findIndex(l => l && l.code === code);
        return currentLinks.findIndex(l => l && l.code === code && itemDomain(l) === domain);
      }

      // Persist the in-memory list so a reload during the Blobs edge-cache
      // lag window still shows just-created links (server list catches up
      // within seconds; see fetchAndRenderSession merge below).
      function saveLocalHistory() {
        try { localStorage.setItem('tunnel_history', JSON.stringify(currentLinks)); } catch (e) {}
      }

      // Merge server truth with own-device creations awaiting confirmation.
      // Server wins on identity conflicts (same domain/code). A local item
      // missing server-side is kept ONLY if this device created it moments
      // ago and the server hasn't echoed it back yet (edge-list lag);
      // anything else missing is server truth — deleted elsewhere — and
      // drops on the spot, so refresh shows the latest state. Confirmed
      // and over-age just-created keys are pruned here. Items from other
      // sessions (stale cache after a session switch) are dropped.
      function mergeServerLinks(serverLinks, sid) {
        const server = Array.isArray(serverLinks) ? serverLinks : [];
        const seen = new Set();
        for (const it of server) {
          try { seen.add(itemKey(it)); } catch (e) {}
        }
        const now = Date.now();
        let prunedJC = false;
        for (const [jk, jts] of [...justCreated.entries()]) {
          if (seen.has(jk) || now - jts < 0 || now - jts >= JUST_CREATED_MS) {
            justCreated.delete(jk);
            prunedJC = true;
          }
        }
        if (prunedJC) saveJustCreated();
        const localOnly = [];
        for (const it of (Array.isArray(currentLinks) ? currentLinks : [])) {
          if (!it) continue;
          if (sid && it.sessionId && it.sessionId !== sid) continue;
          let k = '';
          try { k = itemKey(it); } catch (e) { continue; }
          if (seen.has(k)) continue;
          if (justCreated.has(k)) localOnly.push(it);
          // Else: missing server-side and not awaiting confirmation here —
          // deleted on another device (or otherwise gone server-side).
        }
        return localOnly.concat(server);
      }

      function isSessionNotFoundError(e) {
        const msg = String((e && e.message) || '');
        const code = String((e && e.code) || '');
        return code === 'not-found' || /unknown or missing session/i.test(msg);
      }

      // Backend-provided money values must look like BTC amounts before they
      // are rendered as HTML. Anything else falls back to plain text.
      function isBtcAmount(v) {
        return typeof v === 'string' && /^\d+(\.\d{1,8})?$/.test(v);
      }
      function setQuoteAmount(el, amount, originalAmount) {
        if (!el) return;
        const amt = String(amount);
        if (!isBtcAmount(amt)) {
          el.textContent = 'Invalid amount received';
          return;
        }
        el.dataset.copyValue = amt;
        if (originalAmount !== undefined && originalAmount !== null &&
            isBtcAmount(String(originalAmount))) {
          el.innerHTML = `<span style="text-decoration: line-through; color: var(--text-muted); font-size: 0.9rem;">${escapeHTML(String(originalAmount))} BTC</span> <span style="color: #6fcf7f;">${escapeHTML(amt)} BTC</span>`;
        } else {
          el.textContent = `${amt} BTC`;
        }
      }
      function setDiscountBanner(el, pct) {
        if (!el) return;
        const n = Number(pct);
        if (!Number.isFinite(n) || n <= 0 || n >= 100) {
          el.style.display = 'none';
          return;
        }
        el.innerHTML = `🎉 Discount applied! You save ${n}%`;
        el.style.display = 'block';
        el.style.background = 'rgba(43,166,64,0.12)';
        el.style.borderColor = '#6fcf7f';
        el.style.color = '#6fcf7f';
      }

      // --- SESSION MANAGEMENT ---

      let lastManualSessionAttempt = 0; // Track last manual session entry attempt
      const SESSION_RATE_LIMIT_MS = 2000; // 2 seconds between attempts

      async function checkSessionExistsInDb(sessionId) {
        try {
          const checkFn = functions.httpsCallable('checkSessionExists');
          const res = await checkFn({ sessionId });
          return res.data.exists;
        } catch (error) {
          console.error('Error checking session existence:', error);
          return false; // Default to not exists on error
        }
      }

      async function createSessionInDb(sessionId) {
        try {
          const createFn = functions.httpsCallable('createSession');
          await createFn({ sessionId });
        } catch (error) {
          console.error('Error creating session in database:', error);
        }
      }

      // Cryptographically strong random int in [0, max) with rejection
      // sampling (no modulo bias). Refuses insecure-context fallback:
      // sessions are passwords, weak entropy is worse than failing.
      function randInt(max) {
        try {
          if (window.crypto && window.crypto.getRandomValues) {
            const range = 256 - (256 % max);
            while (true) {
              const buf = new Uint8Array(1);
              window.crypto.getRandomValues(buf);
              if (buf[0] < range) return buf[0] % max;
            }
          }
        } catch (e) {}
        throw new Error('Secure random unavailable — use HTTPS.');
      }

      // Sessions are exactly 10 alphanumerics without "1" and without
      // specials. Admin keys are exactly 10 chars,
      // always contain "1", specials "@#$" allowed (never valid as session).
      const SESSION_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ023456789';
      const SESSION_REGEX_STRICT = /^[A-Za-z023456789]{10}$/;
      const ADMIN_REGEX_STRICT = /^[A-Za-z0-9\-_!@#$]{10}$/;
      function validAdminKeyFrontend(v) {
        return typeof v === 'string' && ADMIN_REGEX_STRICT.test(v) && v.includes('1');
      }

      async function generateSessionId() {
        let result = '';
        let attempts = 0;
        const maxAttempts = 10; // Bounded: each attempt is a billed backend call

        while (attempts < maxAttempts) {
          result = '';
          for (let i = 0; i < SESSION_ID_LENGTH; i++) {
            result += SESSION_CHARS.charAt(randInt(SESSION_CHARS.length));
          }

          // Check if this session ID already exists in the sessions collection
          const exists = await checkSessionExistsInDb(result);
          if (!exists) {
            // Return the session ID WITHOUT creating it in the database
            // Session will be created only after a successful URL shortening
            return result;
          }

          attempts++;
        }

        // Fallback: same strict alphabet, time-mixed (no "1", no specials).
        let suffix = Date.now().toString(36).replace(/[^a-z0-9]/gi, '').replace(/1/g, 'x').replace(/[^A-Za-z023456789]/g, 'x');
        let out = '';
        for (let i = 0; i < SESSION_ID_LENGTH; i++) {
          out += (i < suffix.length && suffix[i] && SESSION_CHARS.includes(suffix[i]) && randInt(2) === 0)
            ? suffix[i]
            : SESSION_CHARS.charAt(randInt(SESSION_CHARS.length));
        }
        // Return WITHOUT creating in database - session will be created after successful shortening
        return out;
      }

      function getSessionId() {
        // Storage can throw when blocked (private mode, disabled cookies).
          // Synchronous strict check only (no network): malformed stored IDs
          // (hand-edited IDs with "1"/specials) are purged immediately so
        // boot skips a wasted backend round-trip — faster on slow connections.
        try {
          const v = localStorage.getItem(SESSION_KEY);
          if (!v) return null;
          if (!SESSION_REGEX_STRICT.test(v) || v.length !== SESSION_ID_LENGTH || v.includes('1')) {
            try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
            return null;
          }
          return v;
        } catch (e) { return null; }
      }

      function setSessionId(id) {
        try { localStorage.setItem(SESSION_KEY, id); } catch (e) {}
        updateSessionUI();
      }

      function updateSessionUI() {
        const sid = getSessionId();
        const controls = document.getElementById('sessionControls');
        const title = document.getElementById('sessionIdTitle');
        const flex = document.getElementById('sessionFlexContainer');
        const display = document.getElementById('displaySessionId');
        const toggle = document.getElementById('sessionIdToggle');
        const buttonsRow = document.getElementById('sessionButtonsRow');

        // controls is always block in HTML now, but let's be safe
        controls.style.display = 'block';

        if (sid) {
          // Return to original left-aligned layout
          controls.classList.remove('centered-state');
          controls.style.textAlign = 'left';
          if (title) title.style.textAlign = 'left';
          if (flex) {
            flex.style.flexDirection = 'row';
            flex.style.justifyContent = 'flex-start';
            flex.style.flexWrap = 'wrap';
          }

          display.style.display = 'inline-flex';
          toggle.style.display = 'inline-flex';
          display.textContent = '**********';
          if (toggle) toggle.classList.remove('visible');

          // Reset inline styles that might have been applied in "no session" state
          buttonsRow.style.width = 'auto';
          buttonsRow.style.justifyContent = 'flex-start';
          // The Admin button only renders while the admin key is unlocked in
          // this browser (see merge-box unlock). There is no other entry point.
          // Hidden feature: normal users never see it; knowledge without the
          // key yields 403s only (backend needAdmin is the sole gate).
          const promoBtn = (typeof hasPromoAccess === 'function' && hasPromoAccess())
            ? '<button class="session-item btn-session btn-session-merge" onclick="openPromoAdmin()">Admin</button>'
            : '';
          buttonsRow.innerHTML = `
          <button class="session-item btn-session btn-copy-small" onclick="copySessionId()">Copy</button>
          <button class="session-item btn-session btn-session-merge" onclick="openMergeModal()">Merge</button>
          <button class="session-item btn-session btn-session-fresh" onclick="startFresh()">Start Fresh</button>
          <button class="session-item btn-session btn-session-report" onclick="location.href='/report'">Report an issue</button>
          ${promoBtn}
        `;
        } else {
          // Centered layout for "Load Session" button
          controls.classList.add('centered-state');
          controls.style.textAlign = 'center';
          if (title) title.style.textAlign = 'center';
          if (flex) {
            flex.style.flexDirection = 'column';
            flex.style.justifyContent = 'center';
          }

          display.style.display = 'none';
          toggle.style.display = 'none';

          buttonsRow.style.width = '100%';
          buttonsRow.style.justifyContent = 'center';
          buttonsRow.innerHTML = `
          <button class="session-item btn-session btn-load-session" style="height: auto; padding: 12px 32px;" 
            onclick="promptSessionLoad()">Load Existing Session ID</button>
        `;
        }
      }

      // --- CUSTOM DOMAIN MANAGEMENT ---

      let selectedDomain = "s.inoculens.com/";
      let userCustomDomains = []; // Will be populated from the backend

      // Initial domain state
      const domainSelector = document.getElementById('domainSelector');
      const domainDropdown = document.getElementById('domainDropdown');
      const currentDomainSpan = document.getElementById('currentDomain');

      // Event delegation for dropdown options (handles dynamically added elements)
      if (domainDropdown) {
        domainDropdown.addEventListener('click', (e) => {
          const addNewOption = e.target.closest('#dropdownAddNew') || e.target.closest('.add-new');
          if (addNewOption) {
            e.stopPropagation();
            // Close dropdown first
            domainSelector.classList.remove('active');
            domainDropdown.classList.remove('visible');
            // Then open domain manager
            showDomainManager();
          }
        });
      }

      if (domainSelector) {
        domainSelector.addEventListener('click', async (e) => {
          if (e.target.closest('#openDomainManager')) return;
          // Determine if we are opening the dropdown
          const isOpening = !domainDropdown.classList.contains('visible');
          domainSelector.classList.toggle('active');
          domainDropdown.classList.toggle('visible');
          e.stopPropagation();

          // If opening, show a quick loading placeholder and fetch domains
          if (isOpening) {
            try {
              // Show inline loading option so user sees feedback immediately
              const addNewEl = document.getElementById('dropdownAddNew');
              if (domainDropdown && addNewEl) {
                // Clear existing options but keep the add-new element at the end
                const clonedAdd = addNewEl.cloneNode(true);
                domainDropdown.innerHTML = '';
                const loadingOpt = document.createElement('div');
                loadingOpt.className = 'domain-option';
                loadingOpt.style.justifyContent = 'center';
                loadingOpt.innerHTML = `<span style="color: var(--text-muted);">Loading domains...</span>`;
                domainDropdown.appendChild(loadingOpt);
                domainDropdown.appendChild(clonedAdd);
              }

              // Attempt to load custom domains (no-op if no session)
              await loadUserDomains();
              // Ensure domain options are rendered even when there's no session
              renderDomainOptions();
            } catch (err) {
              console.error('Error loading domains on dropdown open:', err);
            }
          }
        });
      }

      document.addEventListener('click', (e) => {
        // Custom Domain Selector
        if (domainSelector && !domainSelector.contains(e.target)) {
          domainSelector.classList.remove('active');
          if (domainDropdown) {
            domainDropdown.classList.remove('active');
            domainDropdown.classList.remove('visible');
          }
        }
        
        // History Filter
        const historyFilter = document.getElementById('historyDomainFilterContainer');
        if (historyFilter && !historyFilter.contains(e.target)) {
          historyFilter.classList.remove('active');
        }
      });

      async function toggleHistoryFilter(e) {
        if (e) e.stopPropagation();
        const container = document.getElementById('historyDomainFilterContainer');
        if (!container) return;
        const opening = !container.classList.contains('active');
        // Always render first from memory: the dropdown can never open emptier
        // than the visible list, even before the first domains fetch lands.
        try { renderDomainOptions(); } catch (err) {}
        container.classList.toggle('active');
        // Loading parity with the creation dropdown: while the initial load
        // is unsettled, show a sync row, await the shared fetch, re-render.
        if (opening && !window._domainsSettled) {
          try {
            const list = document.getElementById('historyFilterDropdown');
            if (list && !document.getElementById('filterSyncing')) {
              const syncRow = document.createElement('div');
              syncRow.className = 'filter-option';
              syncRow.id = 'filterSyncing';
              syncRow.style.opacity = '0.6';
              syncRow.style.pointerEvents = 'none';
              syncRow.textContent = 'Syncing…';
              list.appendChild(syncRow);
            }
            await ensureDomainsSettled();
            renderDomainOptions();
          } catch (err) {}
        }
      }

      let selectedHistoryDomain = 'all'; // Default filter for history

      // NOTE: filterHistoryByDomain is defined once near the payment polling
      // section (resets pagination, then renders). Do not redefine here.

      function selectHistoryFilter(value, label) {
        const input = document.getElementById('historyDomainFilter');
        const selectedSpan = document.getElementById('historyFilterSelected');
        const container = document.getElementById('historyDomainFilterContainer');
        
        if (input && selectedSpan) {
          input.value = value;
          selectedHistoryDomain = value; // Update the global filter variable
          selectedSpan.textContent = label;
          if (container) container.classList.remove('active');
          
          // Re-populate options to update "selected" class
          renderDomainOptions();
          
          // Trigger the actual filtering
          filterHistoryByDomain();
        }
      }

      function selectDomain(domain) {
        selectedDomain = domain;
        currentDomainSpan.textContent = domain;
        renderDomainOptions();
      }

      function renderDomainOptions() {
        const dropdown = document.getElementById('domainDropdown');
        const historyFilterDropdown = document.getElementById('historyFilterDropdown');
        const historyFilterInput = document.getElementById('historyDomainFilter');
        
        if (!dropdown || !historyFilterDropdown || !historyFilterInput) return;

        // Update creation dropdown
        const existingOptions = dropdown.querySelectorAll('.domain-option:not(.add-new)');
        existingOptions.forEach(opt => opt.remove());

        const systemOpt = document.createElement('div');
        systemOpt.className = `domain-option ${selectedDomain === 's.inoculens.com/' ? 'selected' : ''}`;
        systemOpt.innerHTML = `<div class="domain-actions-group"><span class="domain-status status-active" style="flex: 1; text-align: center;">System</span></div> <span style="flex: 1; white-space: nowrap;">s.inoculens.com/</span>`;
        systemOpt.onclick = () => selectDomain('s.inoculens.com/');
        dropdown.insertBefore(systemOpt, document.getElementById('dropdownAddNew'));


        // Populate history filter dropdown
        // Single source of truth: the selectedHistoryDomain variable. The
        // hidden input + trigger label only mirror it, never drive the UI —
        // so checkmark, label, and actual filtering cannot disagree.
        const currentFilter = selectedHistoryDomain;
        historyFilterInput.value = currentFilter;
        const checkIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

        // Add active domains from user domains to history filter dropdown
        const historyDomains = new Set();
        historyDomains.add('s.inoculens.com/');
        
        // Separate active domains from pending domains for the creation dropdown
        const activeDomains = [];
        const pendingDomains = [];

        userCustomDomains.forEach(d => {
          const dns = d.dnsVerification || {};
          const ownershipVerified = dns.cnameValid && dns.txtVerified;
          const isPermanentlyVerified = d.isVerified === true;

          if (d.status === 'active' && d.paymentStatus === 'paid' && ownershipVerified && isPermanentlyVerified) {
            activeDomains.push(d);
            historyDomains.add(d.domain + '/');
          } else {
            pendingDomains.push(d);
          }
        });
        
        // Also add any other domains found in the history
        currentLinks.forEach(link => {
          try {
            const url = new URL(link.short);
            historyDomains.add(url.hostname + '/');
          } catch (e) {}
        });

        // Clear and rebuild history dropdown
        historyFilterDropdown.innerHTML = `
          <div class="filter-option ${currentFilter === 'all' ? 'selected' : ''}" onclick="selectHistoryFilter('all', 'All domains')">
            <span>All domains</span>
            ${currentFilter === 'all' ? checkIcon : ''}
          </div>
        `;

        // Sort domains alphabetically and add to dropdown
        Array.from(historyDomains).sort().forEach(domainName => {
          const filterOpt = document.createElement('div');
          filterOpt.className = `filter-option ${currentFilter === domainName ? 'selected' : ''}`;
          filterOpt.innerHTML = `
            <span>${escapeHTML(domainName)}</span>
            ${currentFilter === domainName ? checkIcon : ''}
          `;
          filterOpt.onclick = () => selectHistoryFilter(domainName, domainName);
          historyFilterDropdown.appendChild(filterOpt);
        });

        // Add active domains to the creation dropdown
        activeDomains.forEach(domainObj => {
          const domainVal = domainObj.domain + '/';
          const opt = document.createElement('div');
          opt.className = `domain-option ${selectedDomain === domainVal ? 'selected' : ''}`;
          // Coverage ending within the renewal window gets an amber nudge
          // badge (still fully usable + selectable until it actually lapses).
          const soon = coverageExpiringSoon(domainObj);
          opt.innerHTML = `
            <div class="domain-actions-group">
              <button onclick="event.stopPropagation(); showDomainMenu(${escapeJS(domainObj.domain)})"
                style="background: rgba(62, 166, 255, 0.12); border: 1px solid rgba(62, 166, 255, 0.3);
                       color: var(--accent); padding: 2px 6px; border-radius: 999px; font-size: 0.65rem; cursor: pointer;">
                Manage
              </button>
              <span class="domain-status ${soon ? 'status-pending' : 'status-active'}">${soon ? 'Expiring soon' : 'Active'}</span>
            </div>
            <span style="flex: 1; white-space: nowrap;">${escapeHTML(domainObj.domain)}/</span>
          `;
          opt.onclick = () => selectDomain(domainVal);
          dropdown.insertBefore(opt, document.getElementById('dropdownAddNew'));
        });

        // Add pending domains to creation dropdown only
        pendingDomains.forEach(domainObj => {
            let statusText = 'Pending';
            let statusClass = 'status-pending';
            const isPermanentlyVerified = domainObj.isVerified === true;
            // Lapsed coverage on a paid domain: needs a new code or $10 renewal.
            const coverageLapsed = domainObj.paymentStatus === 'paid'
              && domainObj.coverageLifetime !== true && domainObj.coverageValid !== true;

            if (coverageLapsed) {
              statusText = 'Expired';
            } else if (isPermanentlyVerified) {
              statusText = 'Verified';
              statusClass = 'status-active';
            } else if (domainObj.paymentStatus === 'paid') {
              statusText = 'Action Needed';
            }

            const opt = document.createElement('div');
            opt.className = 'domain-option';
            opt.innerHTML = `
              <div class="domain-actions-group">
                <button onclick="event.stopPropagation(); showDomainMenu(${escapeJS(domainObj.domain)})"
                  style="background: rgba(62, 166, 255, 0.12); border: 1px solid rgba(62, 166, 255, 0.3);
                         color: var(--accent); padding: 2px 6px; border-radius: 999px; font-size: 0.65rem; cursor: pointer;">
                  Manage
                </button>
                <span class="domain-status ${statusClass}">${statusText}</span>
              </div>
              <span style="flex: 1; white-space: nowrap;">${escapeHTML(domainObj.domain)}/</span>
            `;
            opt.onclick = () => showDomainMenu(domainObj.domain);
            dropdown.insertBefore(opt, document.getElementById('dropdownAddNew'));
          });
      }

      const domainManagerOverlay = document.getElementById('domainManagerOverlay');
      let currentStep = 1;
      let pendingDomain = '';
      // Apex->www branch state (apex-only; plain subdomains never set these).
      // _apexFlow=true means the user originally typed an apex (example.com)
      // and we canonicalized to www.example.com. _apexName is the bare apex.
      window._apexFlow = false;
      window._apexName = '';
      const APEX_REDIRECT_IPV4 = '65.21.184.101';
      const APEX_REDIRECT_IPV6 = '2a01:4f9:c012:a304::1';
      function wwwForApexInput(raw) {
        const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
        if (!d || d.startsWith('www.')) return null;
        return `www.${d}`;
      }

      async function showDomainManager(targetDomain = '') {
        if (!requireBackend()) return;
        // Adding a domain always asks first when there is no session yet:
        // unlike one-click link shortening, it starts billing/verification.
        if (!getSessionId()) {
          const confirmed = await showCustomModal({
            title: "Create a New Session?",
            message: "You don't have an active session yet. Proceeding will generate a new 10-character Session ID and store your history in our database.<br><br>Do you want to continue?",
            showCancel: true,
            confirmText: "Continue",
            cancelText: "Exit"
          });

          if (!confirmed) return;

          try {
            // Inform the user that a session is being created
            showLoadingModal({
              title: "🔄 Creating Session",
              message: "Your session ID is being created, please wait"
            });

            const sid = await generateSessionId();
            await createSessionInDb(sid);
            setSessionId(sid);

          } catch (err) {
            console.error('Failed to create session for domain manager:', err);
            closeLoadingModal();
            showCustomModal({ title: 'Error', message: 'Failed to create a session. Please try again.' });
            return;
          } finally {
            closeLoadingModal();
          }
        }
        showStep('loading'); // Reset to loading BEFORE showing the overlay
        domainManagerOverlay.style.display = 'flex';
        lockScroll();
        window.addEventListener('keydown', handleDomainManagerEsc);

        // Reset inputs
        const input = document.getElementById('newDomainInput');
        if (input) input.value = '';
        const apexHint = document.getElementById('apexHint');
        if (apexHint) apexHint.style.display = 'none';
        const paymentInst = document.getElementById('paymentInstructions');
        if (paymentInst) paymentInst.style.display = 'none';
        // Reset apex-only branch state (plain flow never sets it).
        window._apexFlow = false;
        window._apexName = '';
        const apexCard0 = document.getElementById('apexRedirectCard');
        if (apexCard0) apexCard0.style.display = 'none';

        // Load domains first before allowing any actions
        loadUserDomains().then(() => {
          if (targetDomain) {
            manageDomain(targetDomain);
          } else {
            showStep(1);
          }
        });
      }

      function closeDomainManager() {
        stopPaymentPolling();
        clearCheckCooldown();
        domainManagerOverlay.style.display = 'none';
        unlockScroll();
        window.removeEventListener('keydown', handleDomainManagerEsc);
        pendingDomain = '';
        window._apexFlow = false;
        window._apexName = '';
        showStep('loading');
      }

      function handleDomainManagerEsc(e) {
        if (e.key === 'Escape') {
          const customModal = document.getElementById('modalOverlay');
          // Only close if no other modals are on top
          if (!customModal || customModal.style.display !== 'flex') {
            closeDomainManager();
          }
        }
      }

      function showStep(step) {
        currentStep = step;

        // Handle both number and string step names
        const stepName = step === 1 ? '1' : step === 2 ? '2' : step === 3 ? 'Payment' : step === 'payment' ? 'Payment' : step === 'verification' ? 'Verification' : step === 'manual' || step === 'Manual' ? 'Manual' : step === 'loading' ? 'Loading' : step;

        const steps = ['addDomainStep1', 'addDomainStep2', 'addDomainStepVerification', 'addDomainStepPayment', 'domainManagerLoading'];
        steps.forEach(id => {
          const el = document.getElementById(id);
          if (el) {
            const isThisStep =
              (step === 1 && id === 'addDomainStep1') ||
              (step === 2 && id === 'addDomainStep2') ||
              (step === 3 && id === 'addDomainStepPayment') ||
              (step === 'payment' && id === 'addDomainStepPayment') ||
              (step === 'verification' && id === 'addDomainStepVerification') ||
              (step === 'loading' && id === 'domainManagerLoading');
            el.style.display = isThisStep ? 'block' : 'none';
          }
        });

        // FIX STEP 2: When entering verification screen (step 2), check current domain status
        // This fixes the "badges disappear on refresh" issue by syncing from database
        if (step === 2 && pendingDomain) {
          window.currentDomain = pendingDomain; // Ensure context is synced
          checkCurrentDomainStatus();
        }

        // Load verification instructions when entering verification step
        if (step === 'verification' && pendingDomain) {
          loadVerificationInfo(pendingDomain);
        }

        // Payment screen loads atomically: discount + quote fetch in parallel,
        // then reveal everything in one paint (see loadPaymentScreen).
        if (step === 3 || step === 'payment') {
          loadPaymentScreen();
          return;
        }
      }

      // CHECK CURRENT DOMAIN STATUS: Call backend to get current domain state
      // This fixes the "badges disappear on refresh" issue
      async function checkCurrentDomainStatus() {
        if (!pendingDomain) {
          return;
        }

        const sessionId = getSessionId();
        if (!sessionId) {
          return;
        }

        try {
          const getInfoFn = functions.httpsCallable('getDomainVerificationInfo');
          const res = await getInfoFn({ domain: pendingDomain, sessionId: sessionId });
          const data = res.data || {};

          // Pass the result to syncVerificationUI to update badges
          syncVerificationUI({
            domain: data.domain || pendingDomain,
            isVerified: data.isVerified,
            dnsVerification: data.dnsVerification || {},
            status: data.status,
            isApexFlow: data.isApexFlow,
            apex: data.apex,
            apexInstructions: data.apexInstructions,
            paymentStatus: data.paymentStatus,
            coverageValid: data.coverageValid,
            coverageLifetime: data.coverageLifetime,
            coverageExpiresAt: data.coverageExpiresAt
          });
        } catch (err) {
          console.error('checkCurrentDomainStatus error:', err);
        }
      }

      // Payment screen loads atomically (single paint, no staggered reveals).
      // Discount state + quote are independent reads: fetch in parallel, then
      // reveal instructions + discount + details together. The token drops
      // late responses when the user already moved to another domain.
      async function loadPaymentScreen() {
        if (!pendingDomain || !getSessionId()) return;
        const myDomain = pendingDomain;
        const myToken = ++paymentScreenToken;
        // Snapshot BEFORE reset: resetPaymentScreen() unchecks the box, so a
        // just-made tick must be captured here or it can never reach the request.
        const consentFlag = withdrawalConsentChecked();
        resetPaymentScreen();
        if (consentFlag) {
          const consentBox = document.getElementById('withdrawalConsent');
          if (consentBox) consentBox.checked = true;
        }
        ensureWithdrawalConsentListener();
        const stepLoading = document.getElementById('paymentStepLoading');
        const instructions = document.getElementById('paymentInstructions');
        const discountSection = document.getElementById('discountCodeSection');
        if (stepLoading) stepLoading.style.display = 'block';
        if (instructions) instructions.style.display = 'none';
        if (discountSection) discountSection.style.display = 'none';
        const [discountRes, quoteRes] = await Promise.allSettled([
          fetchDiscountState(),
          fetchQuote(false, consentFlag),
        ]);
        if (pendingDomain !== myDomain || myToken !== paymentScreenToken) return;
        paintDiscountState(discountRes.status === 'fulfilled' ? discountRes.value : null);
        if (quoteRes.status === 'fulfilled') {
          paintQuoteSuccess(quoteRes.value);
        } else {
          paintQuoteError(quoteRes.reason);
        }
        if (pendingDomain !== myDomain || myToken !== paymentScreenToken) return;
        if (stepLoading) stepLoading.style.display = 'none';
        if (instructions) instructions.style.display = 'block';
        if (discountSection) discountSection.style.display = 'block';
      }

      // Full reset: success paths paint inline styles that must not leak
      // into the next domain's screen (green Apply, dimmed Back, stale
      // loader HTML, previous quote values, old status banners).
      function resetPaymentScreen() {
        const discountInput = document.getElementById('discountCodeInput');
        const applyBtn = document.getElementById('applyDiscountBtn');
        const removeBtn = document.getElementById('removeDiscountBtn');
        const messageEl = document.getElementById('discountCodeMessage');
        const bannerEl = document.getElementById('discountAppliedBanner');
        const quoteAmountEl = document.getElementById('quoteAmount');
        const quoteAddressEl = document.getElementById('quoteAddress');
        const quoteExpiryEl = document.getElementById('quoteExpiry');
        const statusBanner = document.getElementById('paymentStatusBanner');
        const backBtn = document.getElementById('paymentBackBtn');
        if (discountInput) {
          discountInput.value = '';
          discountInput.disabled = false;
        }
        if (applyBtn) {
          applyBtn.style.display = 'block';
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply';
          applyBtn.style.background = '';
        }
        if (removeBtn) {
          removeBtn.style.display = 'none';
          removeBtn.disabled = false;
          removeBtn.textContent = 'Remove';
        }
        const consentBox = document.getElementById('withdrawalConsent');
        const consentNote = document.getElementById('withdrawalConsentNote');
        const consentWrap = document.getElementById('withdrawalConsentBox');
        if (consentBox) { consentBox.checked = false; consentBox.disabled = false; }
        if (consentNote) consentNote.style.display = 'none';
        if (consentWrap) consentWrap.style.borderColor = '';
        if (backBtn) {
          backBtn.disabled = false;
          backBtn.style.opacity = '';
          backBtn.style.cursor = '';
        }
        if (messageEl) {
          messageEl.textContent = '';
          messageEl.style.display = 'none';
        }
        if (bannerEl) {
          bannerEl.textContent = '';
          bannerEl.style.display = 'none';
          bannerEl.style.background = '';
          bannerEl.style.borderColor = '';
          bannerEl.style.color = '';
        }
        if (quoteAmountEl) {
          quoteAmountEl.textContent = '';
          quoteAmountEl.removeAttribute('data-copy-value');
        }
        if (quoteAddressEl) quoteAddressEl.textContent = '';
        if (quoteExpiryEl) quoteExpiryEl.textContent = '';
        if (statusBanner) {
          statusBanner.textContent = '';
          statusBanner.style.display = 'none';
        }
      }

      // Discount state read (no DOM): used by the atomic loader.
      async function fetchDiscountState() {
        if (!pendingDomain || !getSessionId()) return null;
        try {
          const checkFn = functions.httpsCallable('checkDomainDiscount');
          const res = await checkFn({
            domain: pendingDomain,
            sessionId: getSessionId()
          });
          return res.data || null;
        } catch (err) {
          return null;
        }
      }

      // Discount state paint (no amounts: the quote paint owns pricing).
      function paintDiscountState(data) {
        if (!data || !data.hasDiscount) return;
        const discountInput = document.getElementById('discountCodeInput');
        const applyBtn = document.getElementById('applyDiscountBtn');
        const removeBtn = document.getElementById('removeDiscountBtn');
        const bannerEl = document.getElementById('discountAppliedBanner');
        if (discountInput) {
          discountInput.value = data.discountCode || '';
          discountInput.disabled = true;
        }
        if (applyBtn) {
          applyBtn.style.display = 'none';
        }
        if (removeBtn) {
          removeBtn.style.display = 'block';
        }
        setDiscountBanner(bannerEl, data.discountPercent);
        if (data.withdrawalConsent === true) paintWithdrawalConsent(true);
      }

      // EU withdrawal consent (Terms 3.3): checkbox state helpers.
      function withdrawalConsentChecked() {
        const box = document.getElementById('withdrawalConsent');
        return !!box && box.checked === true;
      }
      function paintWithdrawalConsent(recorded) {
        const box = document.getElementById('withdrawalConsent');
        const note = document.getElementById('withdrawalConsentNote');
        const wrap = document.getElementById('withdrawalConsentBox');
        if (box) {
          if (recorded === true) { box.checked = true; box.disabled = true; }
          else if (recorded === false) { box.checked = false; box.disabled = false; }
        }
        if (note) note.style.display = 'none';
        if (wrap) wrap.style.borderColor = '';
      }
      function flagWithdrawalConsent() {
        const note = document.getElementById('withdrawalConsentNote');
        const wrap = document.getElementById('withdrawalConsentBox');
        if (note) note.style.display = 'block';
        if (wrap) wrap.style.borderColor = '#f5a623';
      }
      function isWithdrawalConsentError(e) {
        return !!e && typeof e.message === 'string' && e.message.indexOf('WITHDRAWAL_CONSENT') !== -1;
      }
      // One-shot wiring (guarded): ticking the box reloads the quote so
      // consent takes effect without hunting for a button.
      function ensureWithdrawalConsentListener() {
        if (window._withdrawalListen) return;
        window._withdrawalListen = true;
        const box = document.getElementById('withdrawalConsent');
        if (box) box.addEventListener('change', () => {
          const details = document.getElementById('paymentDetails');
          if (box.checked && details && details.style.display === 'none') loadPaymentScreen();
        });
      }

      // Discount snapshot for the coverage box: refresh from the backend
      // and repaint. Fire-and-forget with a domain guard; safe to call
      // from any domain-data sync point.
      async function refreshDiscountWindowState() {
        const d = window.currentDomain || pendingDomain;
        if (!d || !getSessionId()) return;
        try {
          const checkFn = functions.httpsCallable('checkDomainDiscount');
          const res = await checkFn({ domain: d, sessionId: getSessionId() });
          if ((window.currentDomain || pendingDomain) !== d) return;
          const data = res.data || null;
          window.domainDiscount = (data && data.hasDiscount)
            ? { hasDiscount: true, percent: data.discountPercent || 0, code: data.discountCode || '' }
            : null;
        } catch (err) {
          return;
        }
        if ((window.currentDomain || pendingDomain) !== d) return;
        renderCoverageStatus();
      }

      // Apex (naked) domains can't serve short links — DNS forbids CNAME at
      // the apex. Client-side mirror of the backend psl check (common
      // two-level suffixes); the backend remains authoritative.
      const APEX_DOUBLE_SUFFIX = new Set(['co.uk','org.uk','me.uk','net.uk','ac.uk','sch.uk','gov.uk','co.jp','ne.jp','or.jp','com.au','net.au','org.au','co.nz','net.nz','org.nz','co.za','com.br','com.mx','com.ar','com.co','co.in','co.id','com.sg','com.hk','com.tw','co.kr','or.kr','ne.kr','com.ph','co.il']);
      function isProbablyApex(raw) {
        const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
        if (!d || d.indexOf('.') === -1) return false;
        const parts = d.split('.');
        if (parts.length <= 2) return true;
        if (parts.length === 3 && APEX_DOUBLE_SUFFIX.has(parts.slice(1).join('.'))) return true;
        return false;
      }
      function apexHintHTML(d) {
        return `ℹ️ <strong>${escapeHTML(d)}</strong> is a naked (apex) domain — short links will live on <strong>www.${escapeHTML(d)}</strong> (same $10/yr covers it), and the apex will forward there free (path-preserving, e.g. ${escapeHTML(d)}/abc → www.${escapeHTML(d)}/abc).`;
      }
      function refreshApexHint() {
        const input = document.getElementById('newDomainInput');
        const hint = document.getElementById('apexHint');
        if (!input || !hint) return false;
        const v = input.value.trim().replace(/^https?:\/\//, '').split('/')[0];
        if (v && isProbablyApex(v)) {
          hint.innerHTML = apexHintHTML(v);
          hint.style.display = 'block';
          return true;
        }
        hint.style.display = 'none';
        return false;
      }
      // NOTE: no live 'input' listener here on purpose — partial input like
      // "s." looks apex-like until the user finishes typing, so the hint
      // appears only after Next is pressed (proceedToAddDomain validates).
      async function proceedToAddDomain() {
        const input = document.getElementById('newDomainInput').value.trim();
        const btn = document.getElementById('addDomainProceedBtn');
        if (!input || btn.classList.contains('loading')) return;

        let rawDomain = input.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

        // Apex-only branch: apex input canonicalizes to www (e.g. example.com
        // -> www.example.com). Non-apex inputs fall through untouched.
        window._apexFlow = false;
        window._apexName = '';
        if (isProbablyApex(rawDomain)) {
          const canonical = wwwForApexInput(rawDomain);
          if (canonical) {
            window._apexFlow = true;
            window._apexName = rawDomain;
            pendingDomain = canonical;
            refreshApexHint();
          } else {
            pendingDomain = rawDomain;
          }
        } else {
          pendingDomain = rawDomain;
        }

        try {
          btn.classList.add('loading');
          btn.disabled = true;

          // First check if user has any domains (this populates userCustomDomains)
          await loadUserDomains();

          // Check if this domain already exists in user's account
          const domainExists = userCustomDomains.some(d =>
            d.domain === pendingDomain || d.id === pendingDomain
          );

          if (domainExists) {
            // Apex re-entry: www already owned (added before the apex branch
            // existed). Open its verification so the free apex redirect card
            // appears (backend stamps the flags on load). Plain duplicates
            // keep the exact old message.
            if (window._apexFlow && window._apexName) {
              btn.classList.remove('loading');
              btn.disabled = false;
              showCustomModal({
                title: "Already Added",
                message: `Short links live on <strong>${escapeHTML(pendingDomain)}</strong> (already in your account) — opening its setup so you can add the free apex redirect for <strong>${escapeHTML(window._apexName)}</strong>.`
              });
              try { await manageDomain(pendingDomain); } catch (e) {}
              return;
            }
            showCustomModal({
              title: "Domain Already Added",
              message: `The domain <strong>${escapeHTML(pendingDomain)}</strong> is already in your account.`
            });
            btn.classList.remove('loading');
            btn.disabled = false;
            return;
          }

          // Claim the domain: own domains idempotent; names held by other
          // sessions become inert pending claims (no transfer until DNS proof
          // via verifyClaimedDomainDns, which also merges links+stats).
          const addFn = functions.httpsCallable('addCustomDomain');
          const tsToken0 = window._tsToken || undefined;
          window._tsToken = undefined;
          const addRes = await addFn({ domain: pendingDomain, type: 'managed', sessionId: getSessionId(), ...(window._apexFlow && window._apexName ? { apexSource: window._apexName } : {}), ...(tsToken0 ? { turnstileToken: tsToken0 } : {}) });
          // Adopt backend apex flags (authoritative): apex inputs normalize to
          // www server-side too, so direct/reopened flows stay consistent.
          if (addRes.data) {
            if (addRes.data.isApexFlow === true) window._apexFlow = true;
            if (addRes.data.apex) window._apexName = addRes.data.apex;
            if (addRes.data.domain) pendingDomain = addRes.data.domain;
          }
          if (addRes.data && addRes.data.pendingClaim) {
            btn.classList.remove('loading');
            btn.disabled = false;
            showPendingClaimModal(addRes.data);
            return;
          }

          // Reload domains so we have latest data
          await loadUserDomains();

          // Show pricing screen for all users (new and existing)
          document.getElementById('pricingScreenForNewUsers').style.display = 'block';
          // Fetch and display BTC price estimate
          updatePricingScreenBTC();
          showStep(2);
        } catch (err) {
          console.error('Error in proceedToAddDomain:', err);
          if ((err.message === 'TURNSTILE_REQUIRED') && !window._tsRetried) {
            window._tsRetried = true;
            btn.classList.remove('loading');
            btn.disabled = false;
            const token = await showTurnstileChallenge();
            window._tsRetried = false;
            if (token) { window._tsToken = token; await proceedToAddDomain(); }
            return;
          }
          showCustomModal({ title: "Error", message: escapeHTML(err.message || 'Something went wrong') });
        } finally {
          btn.classList.remove('loading');
          btn.disabled = false;
        }
      }

      async function confirmPricingAndProceed() {
        const btn = document.getElementById('confirmPricingBtn');
        if (!btn || btn.classList.contains('loading')) return;

        // Domain was already added in proceedToAddDomain step
        // Just proceed to verification step directly
        try {
          btn.classList.add('loading');
          btn.disabled = true;
          btn.textContent = 'Loading...';

          // Show verification step (domain already created in step 1)
          // Get the domain info from backend using addCustomDomain (which returns the info)
          const addFn = functions.httpsCallable('addCustomDomain');
          const tsToken1 = window._tsToken || undefined;
          window._tsToken = undefined;
          const res = await addFn({ sessionId: getSessionId(), domain: pendingDomain, ...(window._apexFlow && window._apexName ? { apexSource: window._apexName } : {}), ...(tsToken1 ? { turnstileToken: tsToken1 } : {}) });
          const data = res.data || {};
          if (data.pendingClaim) {
            btn.classList.remove('loading');
            btn.disabled = false;
            btn.textContent = 'Continue';
            showPendingClaimModal(data);
            return;
          }
          if (data.isApexFlow === true) window._apexFlow = true;
          if (data.apex) window._apexName = data.apex;
          if (data.domain) pendingDomain = data.domain;

          // Set up the verification UI with the returned data
          setVerificationUI({
            domain: data.domain || pendingDomain,
            verificationToken: data.dnsVerificationToken || data.verificationToken,
            sslVerification: data.sslVerification,
            status: data.status,
            isVerified: data.isVerified,
            dnsVerification: data.dnsVerification,
            isApexFlow: data.isApexFlow,
            apex: data.apex,
            apexInstructions: data.apexInstructions
          });

          showStep('verification');
        } catch (err) {
          showCustomModal({ title: "Error", message: escapeHTML(err.message || 'Something went wrong') });
        } finally {
          btn.classList.remove('loading');
          btn.disabled = false;
          btn.textContent = 'Continue';
        }
      }

      // Secure reclaim UI: pending claim needs DNS proof before transfer.
      // On success links+stats move as if created here (clicks/ keyed by host).
      function showPendingClaimModal(data) {
        const txt = (data.instructions && data.instructions.txt) || data.pendingToken || '';
        const cname = (data.instructions && data.instructions.cnameTarget) || 'customers.inoculens.com';
        const claimCnameName = String(pendingDomain || '');
        const claimTxtHost = `verification.${String(pendingDomain || '')}`;
        const copySvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-muted);"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        const copyBtnStyle = 'background: rgba(255,255,255,0.1); border: none; padding: 8px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 30px; height: 30px;';
        const copyRow = (id, value) => `<div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px;"><div id="${id}" style="font-family: monospace; font-size: 0.8rem; color: var(--text); background: #000; padding: 8px; border-radius: 4px; flex: 1; word-break: break-all;">${escapeHTML(value)}</div><button class="copy-btn" onclick="copyTextFromElement('${id}')" title="Copy" style="${copyBtnStyle}">${copySvg}</button></div>`;
        showCustomModal({
          title: "Domain held by another session",
          message: `This name is attached to a different session. To reclaim it (plus its links + stats), prove DNS control:`
            + `<div style="margin: 16px 0; display: flex; flex-direction: column; gap: 8px; text-align: left;">`
            + `<div style="padding: 10px 12px; background: rgba(0, 0, 0, 0.32); border-radius: 8px; border: 1px solid var(--border); display: flex; flex-direction: column;">`
            + `<label style="font-size: 0.8rem; font-weight: 600; color: var(--text); margin-bottom: 8px;">CNAME Record (Routing)</label>`
            + `<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">Record name:</div>${copyRow('claimCnameName', claimCnameName)}`
            + `<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">Points to:</div>${copyRow('claimCnameTarget', cname)}`
            + `</div>`
            + `<div style="padding: 10px 12px; background: rgba(0, 0, 0, 0.32); border-radius: 8px; border: 1px solid var(--border); display: flex; flex-direction: column;">`
            + `<label style="font-size: 0.8rem; font-weight: 600; color: var(--text); margin-bottom: 8px;">TXT Record (Ownership)</label>`
            + `<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">Name/Host:</div>${copyRow('claimTxtHost', claimTxtHost)}`
            + `<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">Value:</div>${copyRow('claimTxtValue', txt)}`
            + `</div></div>`
            + `<div style="font-size: 0.8rem; color: var(--text-muted); text-align: center;">Old owner keeps full rights until you verify. <strong>s.inoculens.com</strong> links never move.<br>DNS changes can take a few minutes.</div>`,
          showCancel: true,
          confirmText: "Verify Claim",
          cancelText: "Cancel"
        }).then(async (ok) => {
          if (ok) verifyPendingClaim();
        });
      }
      async function verifyPendingClaim() {
        if (!pendingDomain || !getSessionId()) return;
        showLoadingModal({ title: "Verifying Claim", message: "Checking DNS + moving history..." });
        try {
          const fn = functions.httpsCallable('verifyClaimedDomainDns');
          const tsToken2 = window._tsToken || undefined;
          window._tsToken = undefined;
          const res = await fn({ domain: pendingDomain, sessionId: getSessionId(), ...(tsToken2 ? { turnstileToken: tsToken2 } : {}) });
          closeLoadingModal();
          if (res.data && res.data.success) {
            await loadUserDomains();
            await fetchAndRenderSession(getSessionId());
            showCustomModal({ title: "Reclaimed", message: `Domain <strong>${escapeHTML(pendingDomain)}</strong> + its links moved here.` });
          } else {
            showCustomModal({ title: "Not yet", message: "DNS proof not found yet (CNAME + TXT). Wait for propagation and try Verify Claim again." });
          }
        } catch (e) {
          closeLoadingModal();
          if ((e.message === 'TURNSTILE_REQUIRED') && !window._tsRetried) {
            window._tsRetried = true;
            const token = await showTurnstileChallenge();
            window._tsRetried = false;
            if (token) { window._tsToken = token; await verifyPendingClaim(); }
            return;
          }
          showCustomModal({ title: "Error", message: escapeHTML(e.message || 'Verify failed') });
        }
      }

      // Per-field verification functions
      let currentDomain = null;
      let currentSessionId = null;

      let verificationState = { cname: null, txt: null }; // Track per-field verification state
      let paymentScreenToken = 0; // Drops late payment-screen paints after a domain switch

      function setVerificationUI(domainDoc) {
        // Show loading state for the continue button immediately
        updateContinueButton(true);

        // domainDoc: { domain, verificationToken, cloudflareValidationRecords, status, dnsVerification, isVerified }
        const domainName = domainDoc.domain || pendingDomain;
        window.currentDomain = domainName;
        currentDomain = domainName;
        currentSessionId = getSessionId();

        // Store the isVerified state globally for use in updateContinueButton
        window.domainIsVerified = domainDoc.isVerified === true;
        window.domainIsActive = domainDoc.status === 'active' || domainDoc.paymentStatus === 'paid';
        window.domainPaymentStatus = domainDoc.paymentStatus || null;
        window.domainCoverage = {
          valid: domainDoc.coverageValid === true,
          lifetime: domainDoc.coverageLifetime === true,
          expiresAt: domainDoc.coverageExpiresAt || null
        };

        // Ownership TXT
        const txtToken = domainDoc.verificationToken || domainDoc.dnsVerificationToken || '';
        const txtHost = (domainDoc.instructions && domainDoc.instructions.txtHost) || `verification.${domainName}`;
        const txtTokenEl = document.getElementById('txtToken');
        const txtHostEl = document.getElementById('txtRecordHost');
        if (txtTokenEl) txtTokenEl.textContent = txtToken;
        if (txtHostEl) txtHostEl.textContent = txtHost;

        // CNAME target (SaaS) — backend-driven, never hardcoded.
        // INOCULENS account: customers.inoculens.com (proxied SaaS target).
        const cnameTarget = (domainDoc.instructions && (domainDoc.instructions.cnameTarget || domainDoc.instructions.routingTarget)) || 'customers.inoculens.com';
        const cnameHostEl = document.getElementById('cnameRecordHost');
        if (cnameHostEl) cnameHostEl.textContent = cnameTarget;
        // Record name the user must create (source side of the CNAME).
        const recordName = (domainDoc.instructions && domainDoc.instructions.recordName) || domainName;
        const recordNameEl = document.getElementById('cnameRecordName');
        if (recordNameEl) recordNameEl.textContent = recordName;
        // Grandfathered apex docs (domain/<apex> created before the apex->www
        // branch): keep the explanatory note. New apex inputs canonicalize to
        // www and never create apex docs, so this only fires for legacy rows.
        const apexNote = document.getElementById('apexNote');
        const isApexDoc = domainDoc.instructions && domainDoc.instructions.isApex;
        if (apexNote) {
          if (isApexDoc) {
            apexNote.innerHTML = `⚠️ <strong>${escapeHTML(domainName)}</strong> is a naked (apex) domain from an older setup. Delete it and re-add <strong>${escapeHTML(domainName)}</strong> above — it will set up <strong>www.${escapeHTML(domainName)}</strong> plus a free apex redirect automatically.`;
            apexNote.style.display = 'block';
          } else {
            apexNote.style.display = 'none';
          }
        }

        // Apex->www branch (additive, advisory-only): show the apex redirect
        // card only when this flow started from an apex input. Plain subdomain
        // flows keep it hidden and behave exactly as before.
        const apexFlow = domainDoc.isApexFlow === true || window._apexFlow === true;
        const apexHost = domainDoc.apex || (apexFlow ? (window._apexName || null) : null);
        if (domainDoc.isApexFlow === true) window._apexFlow = true;
        if (domainDoc.apex) window._apexName = domainDoc.apex;
        const apexCard = document.getElementById('apexRedirectCard');
        if (apexCard) {
          if (apexFlow && apexHost) {
            apexCard.style.display = 'flex';
            const apexNameEl = document.getElementById('apexDomainName');
            if (apexNameEl) apexNameEl.textContent = apexHost;
            const aEl = document.getElementById('apexAValue');
            const aaaaEl = document.getElementById('apexAaaaValue');
            const ai = domainDoc.apexInstructions || {};
            if (aEl) aEl.textContent = ai.a || APEX_REDIRECT_IPV4;
            if (aaaaEl) aaaaEl.textContent = ai.aaaa || APEX_REDIRECT_IPV6;
            updateApexStatusUI(null);
          } else {
            apexCard.style.display = 'none';
          }
        }


        // Initialize status from database (persistent state)
        const dns = domainDoc.dnsVerification || {};
        verificationState = {
          cname: dns.cnameValid || false,
          txt: dns.txtVerified || false,
          // false = definitively unroutable (no edge address); null = ok/unknown.
          routable: (dns.routable === false) ? false : null
        };

        // Initialize button labels
        const cnameBtn = document.getElementById('verifyCnameBtn');
        const txtBtn = document.getElementById('verifyTxtBtn');
        if (cnameBtn) cnameBtn.textContent = 'Verify CNAME';
        if (txtBtn) txtBtn.textContent = 'Verify TXT';

        // Update UI status using persistent values
        updateStatusUI('cname', verificationState.cname);
        updateStatusUI('txt', verificationState.txt);
        updateRoutingUI(verificationState.routable);

        const isPermanentlyVerified = domainDoc.isVerified === true;
        const isActive = domainDoc.status === 'active' || domainDoc.paymentStatus === 'paid';

        // STICKY VERIFICATION: If permanently verified AND domain is active/paid, show special UI state
        // (suppressed while the routing check says the domain cannot serve —
        // see the updateRoutingUI invariant: verified XOR error, never both).
        if (isPermanentlyVerified && isActive && verificationState.routable !== false) {


          // Also update the verificationStatus element for permanent verification
          var verificationStatus = document.getElementById('verificationStatus');
          if (verificationStatus) {
            verificationStatus.innerHTML = '<div style="background: rgba(43, 166, 64, 0.12); border: 1px solid rgba(43, 166, 64, 0.4); color: #6fcf7f; padding: 10px; border-radius: 8px; text-align: center;"><b>Domain Ownership Verified</b></div>';
            verificationStatus.style.display = 'block';
          }
        }


        updateContinueButton();

        // Update continue button state
        updateContinueButton();
        refreshDiscountWindowState();
      }

      // PERSISTENT UI SYNC: Manually sync verification UI based on database state
      // This ensures badges turn green immediately if previously verified
      function syncVerificationUI(domainData) {
        if (!domainData) return;

        // Show loading state for the continue button immediately
        updateContinueButton(true);

        const isVerified = domainData.isVerified === true;
        const isActive = domainData.status === 'active' || domainData.paymentStatus === 'paid';
        const dns = domainData.dnsVerification || {};


        // Store globally for other functions to use
        window.domainIsVerified = isVerified;
        window.domainIsActive = isActive;
        window.domainPaymentStatus = domainData.paymentStatus || null;
        window.domainCoverage = {
          valid: domainData.coverageValid === true,
          lifetime: domainData.coverageLifetime === true,
          expiresAt: domainData.coverageExpiresAt || null
        };

        // Update badges - badges now always show current DNS state
        updateStatusUI('cname', !!dns.cnameValid);
        updateStatusUI('txt', !!dns.txtVerified);
        updateRoutingUI((dns.routable === false) ? false : null);

        // Apex card visibility (additive): only for apex->www flows.
        if (domainData.isApexFlow === true) window._apexFlow = true;
        if (domainData.apex) window._apexName = domainData.apex;
        const apexCardS = document.getElementById('apexRedirectCard');
        if (apexCardS) {
          const showApex = window._apexFlow === true && !!(domainData.apex || window._apexName);
          apexCardS.style.display = showApex ? 'flex' : 'none';
          if (showApex) {
            const nEl = document.getElementById('apexDomainName');
            if (nEl) nEl.textContent = domainData.apex || window._apexName || '';
            const aiS = domainData.apexInstructions || {};
            const aElS = document.getElementById('apexAValue');
            const aaaaElS = document.getElementById('apexAaaaValue');
            if (aElS && aiS.a) aElS.textContent = aiS.a;
            if (aaaaElS && aiS.aaaa) aaaaElS.textContent = aiS.aaaa;
          }
        }

        // Show/hide verification status in modal - only show when both verified AND active/paid
        // (and never alongside the routing error — updateRoutingUI invariant).
        if (isVerified && isActive && verificationState.routable !== false) {
          // Update verification status element
          var verificationStatus = document.getElementById('verificationStatus');
          if (verificationStatus) {
            verificationStatus.innerHTML = '<div style="background: rgba(43, 166, 64, 0.12); border: 1px solid rgba(43, 166, 64, 0.4); color: #6fcf7f; padding: 10px; border-radius: 8px; text-align: center;"><b>Domain Ownership Verified</b></div>';
            verificationStatus.style.display = 'block';
          }
        }

        // Update continue button state
        updateContinueButton();
        refreshDiscountWindowState();
      }


      function updateStatusUI(field, ok) {
        // Badges should ALWAYS show reality, even for verified domains.
        // The "Continue" button handles the sticky logic.

        // Update verificationState
        if (field === 'cname') verificationState.cname = ok;
        else if (field === 'txt') verificationState.txt = ok;

        const map = {
          cname: { status: 'cnameStatus', btn: 'verifyCnameBtn', label: 'Verify CNAME' },
          txt: { status: 'txtStatus', btn: 'verifyTxtBtn', label: 'Verify TXT' }
        };

        const config = map[field];
        if (!config) return;

        const statusEl = document.getElementById(config.status);
        const btnEl = document.getElementById(config.btn);

        if (statusEl) {
          if (ok === true) {
            statusEl.className = 'domain-status status-active';
            statusEl.textContent = 'Verified';
            if (btnEl) btnEl.textContent = 'Re-verify entry';
          } else if (ok === false) {
            statusEl.className = 'domain-status status-pending';
            // CNAME/TXT require user action, so failures show 'Failed'.
            statusEl.textContent = 'Failed';
          } else {
            statusEl.className = 'domain-status status-pending';
            statusEl.textContent = 'Pending';
          }
        }

        // Restore button label if failed
        if (btnEl && ok === false) {
          btnEl.textContent = config.label;
        }

        // Enable continue only if all required checks are true
        updateContinueButton();
      }

      function updateRoutingUI(routable) {
        // false = definitive: no usable edge address, domain cannot serve.
        // true/null/undefined = resolvable or unknown (fail-open: lookup
        // hiccups and domains not yet checked never block).
        verificationState.routable = (routable === false) ? false : null;
        const note = document.getElementById('routingNote');
        if (note) note.style.display = (routable === false) ? 'block' : 'none';
        // Invariant: the "Ownership Verified" banner and the routing error
        // are mutually exclusive — a domain that cannot serve is never
        // presented as verified, even if an older check passed.
        const vs = document.getElementById('verificationStatus');
        if (vs) {
          if (routable === false) {
            vs.style.display = 'none';
          } else if (window.domainIsVerified && window.domainIsActive) {
            vs.style.display = 'block';
          }
        }
        updateContinueButton();
      }

      function updateContinueButton(isLoading = false, loadingText = 'Loading...') {
        const cnameOk = verificationState.cname === true;
        const txtOk = verificationState.txt === true;
        const routableOk = verificationState.routable !== false;

        const continueBtn = document.getElementById('continueToPaymentBtn');
        const spinner = document.getElementById('continueBtnSpinner');
        const btnText = document.getElementById('continueBtnText');
        
        if (continueBtn && btnText) {
          if (isLoading) {
            continueBtn.disabled = true;
            if (spinner) spinner.style.display = 'inline-block';
            if (btnText) btnText.textContent = loadingText;
            continueBtn.style.opacity = '0.7';
            const covLoading = document.getElementById('coverageStatus');
            if (covLoading) covLoading.style.display = 'none';
            return;
          }

          // Hide spinner once loading is over
          if (spinner) spinner.style.display = 'none';

          // Payment requires ownership (CNAME routing + TXT) AND resolvability:
          // a domain with no usable edge address cannot serve links, so it
          // must not take payment. SSL provisions automatically via Cloudflare
          // SaaS HTTP validation after the CNAME is live — it must NOT block
          // payment (takes minutes in background).
          const isPermanentlyVerified = window.domainIsVerified === true;
          // Coverage gates activity too: a stale 'active' flag with lapsed
          // coverage must behave as expired (renewable), never as done.
          const coverageOk = !window.domainCoverage || window.domainCoverage.lifetime === true || window.domainCoverage.valid === true;
          const isDomainActive = window.domainIsActive === true && coverageOk;
          const readyForPayment = ((cnameOk && txtOk) || isPermanentlyVerified) && routableOk;
          const allChecksPass = readyForPayment;

          if (isDomainActive) {
            continueBtn.disabled = false; // Allow closing
            btnText.textContent = 'Finish & Close';
            continueBtn.classList.add('status-active');
            continueBtn.style.opacity = '1';
            continueBtn.onclick = () => {
              showToast('Domain is active and ready!', 'success');
              closeDomainManager();
            };
          } else {
            continueBtn.disabled = !(allChecksPass || isPermanentlyVerified);
            // Lapsed but previously paid: this is a renewal, label it so.
            const needsRenewal = window.domainCoverage && window.domainCoverage.valid !== true
              && window.domainCoverage.lifetime !== true && window.domainPaymentStatus === 'paid';
            btnText.textContent = needsRenewal ? 'Renew — $10/year' : 'Continue to Payment';
            continueBtn.style.opacity = continueBtn.disabled ? '0.5' : '1';
            continueBtn.classList.remove('status-active');
            continueBtn.onclick = () => continueToPaymentFromVerification();
          }
          renderCoverageStatus();
        }
      }

      // Coverage line under the verification banners: lifetime, covered
      // until <date>, expiring soon, expired (renew), or not covered yet.
      // Driven by window.domainCoverage, set from every domain-data sync point.
      // "Soon" (renewal nudge window) is 30 days before expiry.
      const COVERAGE_EXPIRY_SOON_MS = 30 * 86400000;
      function coverageExpiringSoon(d) {
        if (!d || d.coverageLifetime === true || d.coverageValid !== true || !d.coverageExpiresAt) return false;
        const t = new Date(d.coverageExpiresAt).getTime();
        return Number.isFinite(t) && t - Date.now() < COVERAGE_EXPIRY_SOON_MS;
      }
      function renderCoverageStatus() {
        const el = document.getElementById('coverageStatus');
        if (!el) return;
        const cov = window.domainCoverage;
        if (!cov) { el.style.display = 'none'; el.innerHTML = ''; return; }
        const box = (inner) => `<div style="background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border); padding: 10px; border-radius: 8px; text-align: center; font-size: 0.85rem; color: var(--text-muted);">${inner}</div>`;
        if (cov.lifetime === true) {
          el.innerHTML = box('Lifetime coverage — no renewal needed.');
        } else if (cov.valid === true && cov.expiresAt) {
          let when = '';
          try { when = new Date(cov.expiresAt).toLocaleDateString(); } catch (e) { when = ''; }
          if (coverageExpiringSoon(cov)) {
            el.innerHTML = box(`Coverage ends on <b style="color: #f5a623;">${escapeHTML(when)}</b> — renew anytime, remaining time carries over.`);
          } else {
            el.innerHTML = box(`Covered until <b style="color: var(--text);">${escapeHTML(when)}</b>.`);
          }
        } else if (window.domainDiscount && window.domainDiscount.hasDiscount) {
          const pct = Number(window.domainDiscount.percent) || 0;
          el.innerHTML = box(`<b>${pct}% promo code applied</b> — complete the remaining payment to activate.`);
        } else if (window.domainPaymentStatus === 'paid') {
          el.innerHTML = box('<b style="color: #f28b82;">Coverage expired</b> — renew below to reactivate your links.');
        } else if (window.domainIsVerified === true) {
          el.innerHTML = box('Domain verified — one step left: activate coverage with payment or a promo code.');
        } else {
          el.innerHTML = box('Verify ownership, then activate coverage with payment or a promo code.');
        }
        el.style.display = 'block';
      }

      // Update ACME record status (for per-record verification)

      // Helper: update all verification statuses from backend response
      function updateAllChecksFromResponse(data) {
        const checks = data.checks || {};

        // Sync global flags from authoritative backend response
        window.domainIsVerified = data.isVerified === true;
        window.domainIsActive = (data.status === 'active' || data.paymentStatus === 'paid');
        window.domainPaymentStatus = data.paymentStatus || null;
        window.domainCoverage = {
          valid: data.coverageValid === true,
          lifetime: data.coverageLifetime === true,
          expiresAt: data.coverageExpiresAt || null
        };

        // Update main status rows - badges always show reality now
        updateStatusUI('cname', !!checks.cname);
        updateStatusUI('txt', !!checks.txt);
        // Routing: null/undefined = unknown (fail-open), false = unservable.
        if (checks.routable === false) {
          updateRoutingUI(false);
          showToast('Domain does not resolve to Tunnel edge — fix the CNAME target or wait for propagation, then Re-verify.', 'error');
        } else {
          updateRoutingUI(null);
        }

        updateContinueButton();
        refreshDiscountWindowState();
      }

      async function verifyCnameOnly() {
        if (!currentDomain || !getSessionId()) {
          showToast('Selection error: please re-open the domain manager.', 'error');
          console.error('verifyCnameOnly: Context missing', { currentDomain, sessionId: getSessionId() });
          return;
        }
        const btn = document.getElementById('verifyCnameBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }

        try {
          const verifyFn = functions.httpsCallable('verifyCustomDomainDns');
          const res = await verifyFn({ domain: currentDomain, sessionId: getSessionId(), field: 'cname', force: true });

          updateAllChecksFromResponse(res.data);

          if (res.data?.checks?.routable === false) {
            console.warn('CNAME Verification: UNROUTABLE (no edge address)');
            showToast('CNAME points at Tunnel, but the domain resolves nowhere usable — browsers cannot reach it. Fix the target or wait for propagation.', 'error');
          } else if (res.data?.checks?.cname) {
            showToast('CNAME verified!', 'success');
          } else {
            console.warn('CNAME Verification: FAILED (Check DNS)');
            showToast('CNAME verification failed. Check your DNS records.', 'error');
          }
        } catch (e) {
          console.error('verifyCnameOnly Exception:', e);
          updateStatusUI('cname', false, true);
          showToast('Error verifying CNAME: ' + (e.message || 'Unknown error'), 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      }

      async function verifyTxtOnly() {
        if (!currentDomain || !getSessionId()) {
          showToast('Selection error: please re-open the domain manager.', 'error');
          console.error('verifyTxtOnly: Context missing', { currentDomain, sessionId: getSessionId() });
          return;
        }
        const btn = document.getElementById('verifyTxtBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }

        try {
          const verifyFn = functions.httpsCallable('verifyCustomDomainDns');
          const res = await verifyFn({ domain: currentDomain, sessionId: getSessionId(), field: 'txt', force: true });

          updateAllChecksFromResponse(res.data);

          if (res.data?.checks?.txt) {
            showToast('Ownership TXT verified!', 'success');
          } else {
            console.warn('TXT Verification: FAILED (Check DNS)');
            showToast('TXT verification failed. Check your DNS records.', 'error');
          }
        } catch (e) {
          console.error('verifyTxtOnly Exception:', e);
          updateStatusUI('txt', false, true);
          showToast('Error verifying TXT: ' + (e.message || 'Unknown error'), 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      }

      // Apex redirect badge (advisory only — never gates payment).
      // null = not yet checked (Pending), true = redirect live (Verified),
      // false = records missing/mismatched (Action needed).
      function updateApexStatusUI(ok) {
        const statusEl = document.getElementById('apexStatus');
        const btnEl = document.getElementById('verifyApexBtn');
        if (!statusEl) return;
        if (ok === true) {
          statusEl.className = 'domain-status status-active';
          statusEl.textContent = 'Verified';
          if (btnEl) btnEl.textContent = 'Re-verify entry';
        } else if (ok === false) {
          statusEl.className = 'domain-status status-pending';
          statusEl.textContent = 'Action needed';
          if (btnEl) btnEl.textContent = 'Verify Apex';
        } else {
          statusEl.className = 'domain-status status-pending';
          statusEl.textContent = 'Pending';
          if (btnEl) btnEl.textContent = 'Verify Apex';
        }
      }

      async function verifyApexOnly() {
        const apex = window._apexName || null;
        const www = currentDomain || pendingDomain;
        if (!apex || !www || !getSessionId()) {
          showToast('Apex context missing: please re-open the domain manager.', 'error');
          return;
        }
        const btn = document.getElementById('verifyApexBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }
        try {
          const fn = functions.httpsCallable('verifyApexRedirect');
          const res = await fn({ domain: www, apex, sessionId: getSessionId() });
          const ok = res.data && res.data.ok === true;
          updateApexStatusUI(ok);
          if (ok) {
            showToast('Apex redirect verified! example.com links will forward to www.', 'success');
          } else {
            showToast('Apex redirect not detected yet. Check the A/AAAA at @ (DNS-only) and retry.', 'error');
          }
        } catch (e) {
          console.error('verifyApexOnly Exception:', e);
          updateApexStatusUI(false);
          showToast('Error verifying apex: ' + (e.message || 'Unknown error'), 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      }



      async function continueToPaymentFromVerification() {
        if (!currentDomain) return showToast("No domain selected.", "error");

        // Prevent multiple clicks - add loading state
        const continueBtn = document.getElementById('continueToPaymentBtn');
        if (continueBtn) {
          updateContinueButton(true, 'Checking...');
        }

        try {
          const checkFn = functions.httpsCallable('getDomainVerificationInfo');
          const res = await checkFn({ sessionId: getSessionId(), domain: currentDomain });
          const data = res.data;

          // Trust the backend's verification state (prioritize sticky isVerified flag)
          const isVerified = data.isVerified === true || (data.dnsVerification?.cnameValid && data.dnsVerification?.txtVerified);

          if (isVerified) {
            // SUCCESS: Check if payment is already done or domain is active.
            // Coverage counts: a stale 'active' with lapsed coverage must
            // still reach the payment step to renew.
            const coverageOk = data.coverageLifetime === true || data.coverageValid === true;
            if (data.status === 'active' && coverageOk) {
              showToast('Domain is already active and verified!', 'success');
              closeDomainManager();
              return;
            }

            showStep('payment'); // Go to Payment screen
          } else {
            showToast("Verification records not yet detected. Please click the 'Verify' buttons first.", "error");
            // Re-enable button on failure
            updateContinueButton();
          }
        } catch (err) {
          console.error("Payment transition error:", err);
          // Show more details in the error message for debugging
          const errorMsg = err.message || (err.data && err.data.message) || 'Unknown error';
          showToast("Check failed: " + errorMsg + ". Please ensure your DNS is set and try again.", "error");
          // Re-enable button on error
          updateContinueButton();
        }
      }

      async function updatePricingScreenBTC() {
        const btcEstimateEl = document.getElementById('btcPriceEstimate');
        if (!btcEstimateEl) return;

        try {
          // Call the backend to get BTC price
          const getBtcPriceFn = functions.httpsCallable('getBtcPrice');
          const result = await getBtcPriceFn({});
          const btcPrice = result.data.price;

          if (btcPrice) {
            const btcAmount = 10 / btcPrice;

            // 8 decimals shows the exact value (banners use validated helpers)
            btcEstimateEl.textContent = `That is roughly ${btcAmount.toFixed(8)} BTC`;
          } else {
            btcEstimateEl.innerHTML = 'BTC estimate could not be calculated.';
          }
        } catch (err) {
          console.error('Failed to fetch BTC price:', err);
          btcEstimateEl.innerHTML = 'BTC estimate could not be calculated.';
        }
      }

      function copyTextFromElement(id) {
        const el = document.getElementById(id);
        if (!el) return;

        // Check if there's a data attribute with the exact value to copy (for amounts)
        let cleanText = el.dataset.copyValue || '';

        // If no data-copy-value, fall back to innerText/textContent
        if (!cleanText) {
          const text = el.innerText || el.textContent;
          // If it contains a space (like amount + currency), just copy the value
          cleanText = text.includes(' ') ? text.split(' ')[0] : text;
        }

        // Single shared clipboard path (incl. non-secure-context fallback).
        writeClipboardText(cleanText).then(() => {
          animateSuccess(el);
        }).catch(err => {
          console.error("Clipboard copy failed", err);
          showToast('Copy failed — select the text manually.', 'error');
        });
      }

      function animateSuccess(el) {
        const originalBg = el.style.background;
        const originalColor = el.style.color;
        el.style.background = 'rgba(34, 197, 94, 0.2)';
        el.style.color = '#6fcf7f';
        setTimeout(() => {
          el.style.background = originalBg;
          el.style.color = originalColor;
        }, 500);
      }

      async function loadUserDomains() {
        const sid = getSessionId();
        if (!sid) return;

        // Same edge-lag window as links: a domain added seconds ago can 404
        // once before it becomes visible. Retry transient session misses
        // quietly (short waits) before bothering the user with a toast.
        const getDomainsFn = functions.httpsCallable('getUserDomains');
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await getDomainsFn({ sessionId: sid });
            userCustomDomains = response.data.domains || [];
            window._domainsSettled = true;
            renderDomainOptions();
            return;
          } catch (err) {
            lastErr = err;
            console.warn(`loadUserDomains attempt ${attempt + 1}/3 failed:`, (err && err.message) || err);
            if (!isSessionNotFoundError(err) || attempt === 2) break;
            await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 700));
          }
        }
        console.error("Error loading domains:", lastErr);
        // Render from cache anyway so dropdowns are never left empty;
        // _domainsSettled stays false so a later open retries the fetch.
        try { renderDomainOptions(); } catch (e) {}
        // Also show a toast notification
        if (typeof showToast === 'function') {
          showToast('Failed to load custom domains. Please refresh.', 'error');
        }
      }

      // Shared in-flight domains fetch: rapid history-filter toggles while
      // the initial load is unsettled await one fetch instead of stacking.
      let domainsFetchInFlight = null;
      async function ensureDomainsSettled() {
        if (window._domainsSettled) return;
        if (!domainsFetchInFlight) {
          domainsFetchInFlight = loadUserDomains().finally(() => { domainsFetchInFlight = null; });
        }
        try { await domainsFetchInFlight; } catch (e) {}
      }

      // Manage a specific domain
      async function manageDomain(domain) {
        pendingDomain = domain;
        currentDomain = domain;
        // Reassert apex branch when reopening a www doc created via apex input.
        // Plain subdomain docs carry no apex flags — card stays hidden.
        // Keep flags when managing the flagged www canonical (apex re-entry);
        // clear them when switching to any other domain so plain flows stay exact.
        try {
          const flaggedWww = window._apexName ? wwwForApexInput(window._apexName) : null;
          if (!window._apexFlow || flaggedWww !== String(domain || '').toLowerCase()) {
            window._apexFlow = false;
            window._apexName = '';
          }
        } catch (e) { window._apexFlow = false; window._apexName = ''; }

        // Defensive: everything below paints into domainManagerOverlay, so
        // make sure it is visible (the showDomainManager entry flow normally
        // guarantees this). Skipped when already visible — never double-locks.
        try {
          const mgrOverlay = document.getElementById('domainManagerOverlay');
          if (mgrOverlay && mgrOverlay.style.display !== 'flex') {
            mgrOverlay.style.display = 'flex';
            lockScroll();
            window.addEventListener('keydown', handleDomainManagerEsc);
          }
        } catch (e) {}

        // Show loading immediately to prevent "Continue to Payment" flicker
        updateContinueButton(true);

        // Fetch latest domain info and set up verification UI
        try {
          const addFn = functions.httpsCallable('addCustomDomain');
          const res = await addFn({ sessionId: getSessionId(), domain: domain, ...(window._apexFlow && window._apexName ? { apexSource: window._apexName } : {}) });
          const data = res.data || {};
          if (data.isApexFlow === true) window._apexFlow = true;
          if (data.apex) window._apexName = data.apex;
          if (data.domain) { pendingDomain = data.domain; currentDomain = data.domain; }

          setVerificationUI({
            domain: data.domain || domain,
            dnsVerificationToken: data.dnsVerificationToken,
            sslVerification: data.sslVerification,
            status: data.status,
            isVerified: data.isVerified || false, // Pass sticky verification status
            dnsVerification: data.dnsVerification,
            isApexFlow: data.isApexFlow,
            apex: data.apex,
            apexInstructions: data.apexInstructions
          });
        } catch (err) {
          console.error('Error loading domain info:', err);
        }

        showStep('verification');
      }

      // ----- Domain manage menu + APEX (root) routing -----
      // The per-domain Manage pills open this menu first. Configure DNS
      // lands on the long-standing verification screen; APEX routing
      // (paid-and-ready domains only) gets its own screen below. Future
      // per-domain management options dock in this menu.
      async function showDomainMenu(domain) {
        const d = String(domain || '').trim();
        if (!d || !getSessionId()) return;
        let info = null;
        try {
          showLoadingModal({ title: "Loading", message: "Fetching domain status..." });
          const fn = functions.httpsCallable('getDomainVerificationInfo');
          const res = await fn({ domain: d, sessionId: getSessionId() });
          info = res.data || null;
        } catch (e) {
          closeLoadingModal();
          showCustomModal({ title: "Error", message: escapeHTML(e.message || 'Could not load domain status.') });
          return;
        }
        closeLoadingModal();
        if (!info) {
          showCustomModal({ title: "Error", message: "Could not load domain status." });
          return;
        }
        const ready = info.status === 'active' && info.coverageValid === true;
        const apexRow = ready
          ? `<button class="modal-btn modal-btn-ok" style="width: 100%; margin-top: 12px;" onclick="domainMenuPick('apex', ${escapeJS(d)})">Configure APEX routing</button>`
          : `<div style="margin-top: 12px; padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); font-size: 0.8rem; color: var(--text-muted); text-align: center;">APEX routing unlocks once the domain is paid and active.</div>`;
        showCustomModal({
          title: d,
          message: `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; margin-bottom: 4px;">What would you like to manage?</div>
            <button class="modal-btn modal-btn-cancel" style="width: 100%; margin-top: 12px;" onclick="domainMenuPick('dns', ${escapeJS(d)})">Configure DNS</button>
            ${apexRow}`,
          showCancel: false,
          confirmText: "Close"
        });
      }

      function domainMenuPick(which, domain) {
        try { document.getElementById('modalOkBtn').click(); } catch (e) {}
        const d = String(domain || '').trim();
        if (!d) return;
        if (which === 'apex') openApexScreen(d);
        // DNS goes through the full manager entry flow (overlay show, session
        // check, input reset, domain load) — calling manageDomain() directly
        // would paint into a hidden overlay and look completely dead.
        else showDomainManager(d);
      }

      function setApexBusy(busy) {
        for (const id of ['apexSaveBtn', 'apexClearBtn', 'apexTargetInput']) {
          const el = document.getElementById(id);
          if (el) el.disabled = !!busy;
        }
      }

      function closeApexScreen() {
        if (!window._apexOpen) return;
        window._apexOpen = false;
        const overlay = document.getElementById('apexOverlay');
        if (overlay) overlay.style.display = 'none';
        unlockScroll();
        window.removeEventListener('keydown', handleApexEsc);
        window._apexDomain = '';
      }

      function handleApexEsc(e) {
        if (!e || e.key !== 'Escape') return;
        const modal = document.getElementById('modalOverlay');
        if (modal && modal.style.display === 'flex') return;
        closeApexScreen();
      }

      async function openApexScreen(domain) {
        const d = String(domain || '').trim();
        if (!d || !getSessionId()) return;
        window._apexDomain = d;
        const overlay = document.getElementById('apexOverlay');
        const locked = document.getElementById('apexDomainLocked');
        const input = document.getElementById('apexTargetInput');
        const errBox = document.getElementById('apexError');
        const curBox = document.getElementById('apexCurrent');
        if (locked) locked.textContent = d;
        if (input) { input.value = ''; input.disabled = true; }
        if (errBox) errBox.style.display = 'none';
        if (curBox) curBox.style.display = 'none';
        setApexBusy(true);
        if (overlay) overlay.style.display = 'flex';
        window._apexOpen = true;
        lockScroll();
        window.addEventListener('keydown', handleApexEsc);
        try {
          const fn = functions.httpsCallable('getDomainVerificationInfo');
          const res = await fn({ domain: d, sessionId: getSessionId() });
          const info = res.data || {};
          if (window._apexDomain !== d) return;
          if (!(info.status === 'active' && info.coverageValid === true)) {
            closeApexScreen();
            showCustomModal({ title: "Not available", message: "APEX routing unlocks once the domain is paid and active." });
            return;
          }
          const current = typeof info.apexTarget === 'string' ? info.apexTarget : '';
          if (input) { input.value = current; input.disabled = false; }
          if (curBox && current) {
            curBox.innerHTML = `Currently routing root visitors to:<br><span style="word-break: break-all; color: var(--text);">${escapeHTML(current)}</span>`;
            curBox.style.display = 'block';
          }
        } catch (e) {
          if (window._apexDomain !== d) return;
          if (errBox) { errBox.textContent = e.message || 'Could not load APEX settings.'; errBox.style.display = 'block'; }
        } finally {
          if (window._apexDomain === d) setApexBusy(false);
        }
      }

      async function saveApexTarget() {
        const d = window._apexDomain || '';
        const input = document.getElementById('apexTargetInput');
        const errBox = document.getElementById('apexError');
        const target = input ? input.value.trim() : '';
        if (errBox) errBox.style.display = 'none';
        if (!d || !getSessionId()) return;
        if (!target) {
          if (errBox) { errBox.textContent = 'Enter a destination address, or use Remove to go back to the default landing page.'; errBox.style.display = 'block'; }
          return;
        }
        if (!/^https?:\/\//i.test(target)) {
          if (errBox) { errBox.textContent = 'Destination must start with http:// or https://'; errBox.style.display = 'block'; }
          return;
        }
        setApexBusy(true);
        try {
          const fn = functions.httpsCallable('setApexTarget');
          const res = await fn({ domain: d, sessionId: getSessionId(), target });
          if (window._apexDomain !== d) return;
          const saved = (res.data && res.data.apexTarget) || target;
          closeApexScreen();
          showCustomModal({ title: "Saved", message: `Visitors to <strong>${escapeHTML(d)}</strong> will now land on:<br><span style="word-break: break-all;">${escapeHTML(saved)}</span>` });
          try { await loadUserDomains(); } catch (e) {}
        } catch (e) {
          if (window._apexDomain !== d) return;
          if (errBox) { errBox.textContent = e.message || 'Could not save.'; errBox.style.display = 'block'; }
        } finally {
          if (window._apexDomain === d) setApexBusy(false);
        }
      }

      async function clearApexTarget() {
        const d = window._apexDomain || '';
        if (!d || !getSessionId()) return;
        const ok = await showCustomModal({
          title: "Remove APEX routing?",
          message: `Visitors to <strong>${escapeHTML(d)}</strong> will land on INOCULENS Tunnel again.`,
          showCancel: true, danger: true, confirmText: "Remove", cancelText: "Keep"
        });
        if (!ok || window._apexDomain !== d) return;
        setApexBusy(true);
        try {
          const fn = functions.httpsCallable('setApexTarget');
          await fn({ domain: d, sessionId: getSessionId(), target: null });
          if (window._apexDomain !== d) return;
          const input = document.getElementById('apexTargetInput');
          if (input) input.value = '';
          const curBox = document.getElementById('apexCurrent');
          if (curBox) curBox.style.display = 'none';
          showToast('APEX routing removed — root lands on INOCULENS Tunnel again.', 'success');
        } catch (e) {
          if (window._apexDomain !== d) return;
          const errBox = document.getElementById('apexError');
          if (errBox) { errBox.textContent = e.message || 'Could not remove.'; errBox.style.display = 'block'; }
        } finally {
          if (window._apexDomain === d) setApexBusy(false);
        }
      }

      // Delete a domain (called from verification screen)
      async function deleteDomain() {
        const domainToDelete = pendingDomain;
        if (!domainToDelete) {
          showCustomModal({ title: "Error", message: "No domain selected for deletion." });
          return;
        }

        const btn = document.getElementById('deleteDomainBtn');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Deleting...';
        }

        try {
          // First, get info about the domain to check if it has activity
          const getInfoFn = functions.httpsCallable('getDomainVerificationInfo');
          const infoResult = await getInfoFn({ domain: domainToDelete, sessionId: getSessionId() });
          const domainData = infoResult.data || {};
          
          const isVerified = domainData.isVerified === true;
          const paymentStatus = domainData.paymentStatus;
          const isPaid = paymentStatus === 'paid';

          // Show warning if domain was verified or paid
          if (isVerified || isPaid) {
            // Show confirmation dialog with warning
            const confirmed = await showCustomModal({
              title: "Delete Domain?",
              message: `Are you sure you want to delete <strong>${escapeHTML(domainToDelete)}</strong>?` +
                `<div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 8px; padding: 12px; margin: 8px 0; color: #f28b82;">` +
                `⚠️ <strong>Warning:</strong> This domain is ${isPaid ? 'paid and active' : 'verified'}. All links using this domain will be permanently deleted.</div>` +
                `<div>If you want to use this domain again later, you'll need to pay again.</div>`,
              confirmText: "Delete Forever",
              danger: true,
              showCancel: true
            });

            if (!confirmed) {
              if (btn) {
                btn.disabled = false;
                btn.textContent = 'Delete Domain';
              }
              return;
            }
          }

          // Proceed with deletion
          const deleteFn = functions.httpsCallable('deleteCustomDomain');
          const result = await deleteFn({ domain: domainToDelete, sessionId: getSessionId() });
          const data = result.data || {};

          // Close the domain manager modal
          closeDomainManager();

          untrackJustCreatedDomain(domainToDelete);
          // Reload domains
          await loadUserDomains();

          // Show success message
          let message = `Domain "${domainToDelete}" has been deleted.`;
          if (data.deletedUrls && data.deletedUrls > 0) {
            message += ` ${data.deletedUrls} associated link(s) were also deleted.`;
          }
          showToast(message, "success");

        } catch (err) {
          showCustomModal({ title: "Error", message: escapeHTML(err.message || 'Something went wrong') });
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Delete Domain';
          }
        }
      }

      // Load verification info for a domain
      async function loadVerificationInfo(domain) {
        try {
          const getInfoFn = functions.httpsCallable('getDomainVerificationInfo');
          const result = await getInfoFn({ domain, sessionId: getSessionId() });
          const data = result.data || {};

          // Use setVerificationUI for consistent updates
          setVerificationUI({
            domain: data.domain || domain,
            dnsVerificationToken: (data.instructions && data.instructions.txt) || data.dnsVerificationToken,
            sslVerification: data.sslVerification || (data.cloudflareValidationRecords && { records: data.cloudflareValidationRecords }),
            status: data.status,
            dnsVerification: data.dnsVerification,
            isVerified: data.isVerified,
            isApexFlow: data.isApexFlow,
            apex: data.apex,
            apexInstructions: data.apexInstructions
          });

        } catch (err) {
          console.error("Error loading verification info:", err);
        }
      }

      // Quote read (no DOM): shared by the atomic loader and refreshes.
      // consentOverride lets callers pass a pre-reset snapshot; otherwise the
      // live checkbox state is read (safe on paths without a reset, e.g. refresh).
      async function fetchQuote(forceRefresh = false, consentOverride = null) {
        const flag = consentOverride === null ? withdrawalConsentChecked() : consentOverride;
        const genFn = functions.httpsCallable('generatePaymentAddress');
        const res = await genFn({
          domain: pendingDomain,
          sessionId: getSessionId(),
          forceRefresh: forceRefresh,
          withdrawalConsent: flag
        });
        return res.data;
      }

      function paintQuoteSuccess(data) {
        const loadingState = document.getElementById('paymentLoadingState');
        const paymentDetails = document.getElementById('paymentDetails');
        const quoteAmountEl = document.getElementById('quoteAmount');
        const quoteAddressEl = document.getElementById('quoteAddress');
        const quoteExpiryEl = document.getElementById('quoteExpiry');
        if (loadingState) loadingState.style.display = 'none';
        if (paymentDetails) paymentDetails.style.display = 'block';
        if (data.withdrawalConsent === true) paintWithdrawalConsent(true);
        if (data.discountPercent && data.originalAmount) {
          setQuoteAmount(quoteAmountEl, data.amount, data.originalAmount);
        } else {
          setQuoteAmount(quoteAmountEl, data.amount);
        }
        if (quoteAddressEl) quoteAddressEl.textContent = data.address;
        if (data.expiresAt && quoteExpiryEl) {
          const expiryDate = new Date(data.expiresAt);
          quoteExpiryEl.innerHTML = `⚠️ This quote expires on <strong>${expiryDate.toLocaleDateString()} ${expiryDate.toLocaleTimeString()}</strong> (1 week from generation).`;
        }
        clearCheckCooldown();
        startPaymentPolling(pendingDomain);
      }

      function paintQuoteError(err) {
        const loadingState = document.getElementById('paymentLoadingState');
        const paymentDetails = document.getElementById('paymentDetails');
        if (paymentDetails) paymentDetails.style.display = 'none';
        if (!loadingState) return;
        if (isWithdrawalConsentError(err)) {
          loadingState.style.display = 'block';
          loadingState.innerHTML = '<span style="color: var(--text-muted);">Tick the consent box below to load your payment address.</span>';
          flagWithdrawalConsent();
          return;
        }
        loadingState.style.display = 'block';
        if (err && err.code === 'failed-precondition' && err.message && err.message.includes('DNS verification')) {
          loadingState.innerHTML = '<span style="color: #f5a623;">DNS verification required before payment.</span>';
          showCustomModal({
            title: "Verification Required",
            message: "Please verify your domain ownership and DNS configuration before proceeding to payment.",
            confirmText: "Go to Verification",
            showCancel: true,
            cancelText: "Cancel"
          }).then((ok) => { if (ok) showStep('verification'); });
        } else {
          const detail = (err && err.message) ? `: ${err.message}` : '';
          loadingState.innerHTML = `<span style="color: #f04141;">Failed to generate payment address${escapeHTML(detail)}. Go back and try again later.</span>`;
          showCustomModal({ title: "Error", message: `Failed to generate payment address${escapeHTML(detail)}. Go back and try again later.` });
        }
      }

      // Refresh path (discount removed): screen is already revealed,
      // so paint directly with a stale-domain guard.
      async function updateQuote(forceRefresh = false) {
        const myDomain = pendingDomain;
        const myToken = paymentScreenToken;
        const instructions = document.getElementById('paymentInstructions');
        const loadingState = document.getElementById('paymentLoadingState');
        const paymentDetails = document.getElementById('paymentDetails');
        if (instructions) instructions.style.display = 'block';
        if (loadingState) {
          loadingState.style.display = 'block';
          loadingState.innerHTML = '<div class="loading-spinner" style="margin: 0 auto 12px;"></div>Generating your Bitcoin address...';
        }
        if (paymentDetails) paymentDetails.style.display = 'none';
        try {
          const data = await fetchQuote(forceRefresh, withdrawalConsentChecked());
          if (pendingDomain !== myDomain || myToken !== paymentScreenToken) return;
          paintQuoteSuccess(data);
        } catch (err) {
          console.error(err);
          if (pendingDomain !== myDomain || myToken !== paymentScreenToken) return;
          paintQuoteError(err);
        }
      }

      // Instant on-demand check (no admin token): same balance logic as the
      // hourly watcher but scoped to this domain. Hourly covers closed-tab.
      // Shared guard with the auto-poller below so manual + auto never fire
      // together (the backend allows ~2 checks/min per domain).
      async function checkPaymentNow(isAuto = false) {
        const btn = document.getElementById('checkPayBtn');
        const banner = document.getElementById('paymentStatusBanner');
        if (!pendingDomain || !getSessionId()) return false;
        if (window._checkingNow) return false;
        if (!isAuto && Date.now() < checkCooldownUntil) return false;
        window._checkingNow = true;
        const myDomain = pendingDomain;
        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
          if (banner && !isAuto) { banner.style.display = 'block'; banner.textContent = 'Checking blockchain…'; }
          const fn = functions.httpsCallable('checkPaymentNow');
          const res = await fn({ domain: pendingDomain, sessionId: getSessionId() });
          if (pendingDomain !== myDomain) return false;
          if (res.data && res.data.paid) {
            if (banner) {
              banner.style.display = 'block';
              banner.style.background = 'rgba(43,166,64,0.12)';
              banner.style.borderColor = '#6fcf7f';
              banner.style.color = '#6fcf7f';
              banner.textContent = '✅ Payment confirmed! Your domain is now active.';
            }
            await loadUserDomains();
            const confirmedFor = pendingDomain;
            setTimeout(() => {
              if (pendingDomain && pendingDomain !== confirmedFor) return;
              closeDomainManager();
            }, 2000);
            return true;
          } else {
            if (banner) {
              banner.style.display = 'block';
              banner.style.background = 'rgba(255,255,255,0.05)';
              banner.style.borderColor = 'var(--border)';
              banner.style.color = '#aaaaaa';
              const d = res.data || {};
              if (d.partial && d.partial.received && d.partial.required) {
                banner.textContent = `Partial payment detected (${escapeHTML(d.partial.received)} of ${escapeHTML(d.partial.required)} BTC confirmed). Send the exact remainder to the same address — then wait for 1 confirmation.`;
              } else if (d.seenUnconfirmed) {
                banner.textContent = 'Payment seen in the network — waiting for its first blockchain confirmation, then this activates automatically. Keep this tab open.';
              } else if (!isAuto) {
                banner.textContent = 'Not yet seen on-chain. Keep this tab open and try again in a minute.';
              }
            }
            return false;
          }
        } catch (e) {
          console.error('checkPaymentNow:', e);
          // 429 (auto + manual colliding, or fast double-click) is routine —
          // stay quiet and let the next cycle handle it.
          const rateLimited = e && (e.code === 'resource-exhausted' || /wait 30s/i.test(e.message || ''));
          if (!isAuto && rateLimited) {
            if (banner && banner.textContent === 'Checking blockchain…') banner.textContent = '⏳ Waiting for payment confirmation...';
            setCheckCooldown(30000);
          } else if (!isAuto) {
            showToast(e.message || 'Check failed', 'error');
          }
          return false;
        } finally {
          window._checkingNow = false;
          if (Date.now() < checkCooldownUntil) {
            setCheckCooldown(checkCooldownUntil - Date.now());
          } else if (btn) { btn.disabled = false; btn.textContent = "I've paid — Check now"; }
        }
      }

      // --- Discount Code Functions ---
      async function applyDiscountCode() {
        const discountInput = document.getElementById('discountCodeInput');
        const applyBtn = document.getElementById('applyDiscountBtn');
        const removeBtn = document.getElementById('removeDiscountBtn');
        const messageEl = document.getElementById('discountCodeMessage');
        const bannerEl = document.getElementById('discountAppliedBanner');
        const backBtn = document.getElementById('paymentBackBtn');
        const code = discountInput.value.trim();
        const myDomain = pendingDomain;

        if (!code) {
          messageEl.textContent = 'Please enter a discount code';
          messageEl.style.color = '#f04141';
          messageEl.style.display = 'block';
          setTimeout(() => {
            if (messageEl.textContent === 'Please enter a discount code') messageEl.style.display = 'none';
          }, 5000);
          return;
        }

        // Disable button and back button during request
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying...';
        if (backBtn) {
          backBtn.disabled = true;
          backBtn.style.opacity = '0.5';
          backBtn.style.cursor = 'not-allowed';
        }
        removeBtn.style.display = 'none';
        messageEl.style.display = 'none';
        bannerEl.style.display = 'none';

        try {
          const applyDiscountFn = functions.httpsCallable('applyDiscountCode');
          const res = await applyDiscountFn({
            code: code,
            domain: pendingDomain,
            sessionId: getSessionId(),
            forceRefresh: true,
            withdrawalConsent: withdrawalConsentChecked()
          });
          if (pendingDomain !== myDomain) return;

          if (res.data.isFullDiscount) {
            // Full discount - domain is already activated!
            // Show loading state in payment area
            const paymentDetails = document.getElementById('paymentDetails');
            const loadingState = document.getElementById('paymentLoadingState');

            if (paymentDetails) paymentDetails.style.display = 'none';
            if (loadingState) {
              loadingState.style.display = 'block';
              loadingState.innerHTML = '<div style="text-align: center; padding: 20px 0;"><span style="color: #6fcf7f; font-size: 1.1rem;">🎉 Validating your free domain...</span></div>';
            }

            // Update button to show processing
            applyBtn.textContent = 'Activating...';
            applyBtn.style.background = 'rgba(43, 166, 64, 0.3)';

            bannerEl.innerHTML = `🎉 ${escapeHTML(res.data.message || 'Discount applied')}`;
            bannerEl.style.display = 'block';
            bannerEl.style.background = 'rgba(43,166,64,0.12)';
            bannerEl.style.borderColor = '#6fcf7f';
            bannerEl.style.color = '#6fcf7f';
            window.domainPaymentStatus = 'paid';
            window.domainCoverage = {
              valid: res.data.coverageValid === true,
              lifetime: res.data.coverageLifetime === true,
              expiresAt: res.data.coverageExpiresAt || null
            };
            window.domainDiscount = { hasDiscount: true, percent: 100, code: code };
            renderCoverageStatus();

            // Refresh the domain list and close the modal
            await loadUserDomains();
            const activatedFor = pendingDomain;
            setTimeout(() => {
              if (pendingDomain && pendingDomain !== activatedFor) return;
              closeDomainManager();
              showCustomModal({
                title: '🎉 Domain Activated!',
                message: `Your domain <strong>${escapeHTML(pendingDomain)}</strong> has been added for free! You can now create short links using this domain.`
              });
            }, 1500);
            return;
          }

          if (res.data.discounted) {
            // Show discounted amount
            setDiscountBanner(bannerEl, res.data.discountPercent);

            // Update the displayed amount directly from the response
            const quoteAmountEl = document.getElementById('quoteAmount');
            const quoteAddressEl = document.getElementById('quoteAddress');
            const quoteExpiryEl = document.getElementById('quoteExpiry');

            if (quoteAmountEl) {
              // Store the discounted amount in a data attribute for the copy function
              setQuoteAmount(quoteAmountEl, res.data.amount, res.data.originalAmount);
            }

            if (quoteAddressEl && res.data.address) {
              quoteAddressEl.textContent = res.data.address;
            }

            if (quoteExpiryEl && res.data.expiresAt) {
              const expiryDate = new Date(res.data.expiresAt);
              quoteExpiryEl.innerHTML = `⚠️ This quote expires on <strong>${expiryDate.toLocaleDateString()} ${expiryDate.toLocaleTimeString()}</strong> (1 week from generation).`;
            }

            // Show the Remove button, hide Apply
            discountInput.disabled = true;
            applyBtn.style.display = 'none';
            removeBtn.style.display = 'block';

            // Re-enable back button after successful discount
            if (backBtn) {
              backBtn.disabled = false;
              backBtn.style.opacity = '1';
              backBtn.style.cursor = 'pointer';
            }
            window.domainDiscount = { hasDiscount: true, percent: res.data.discountPercent || 0, code: code };
            window.domainCoverage = {
              valid: res.data.coverageValid === true,
              lifetime: res.data.coverageLifetime === true,
              expiresAt: res.data.coverageExpiresAt || null
            };
            renderCoverageStatus();
          }

        } catch (err) {
          console.error('Discount code error:', err);
          const errorMessage = isWithdrawalConsentError(err)
            ? 'Tick the consent box below first — it is required before any discount can be applied.'
            : (err.message || 'Failed to apply discount code');
          if (isWithdrawalConsentError(err)) flagWithdrawalConsent();
          messageEl.textContent = errorMessage;
          messageEl.style.color = '#f04141';
          messageEl.style.display = 'block';
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply';
          // Re-enable back button
          if (backBtn) {
            backBtn.disabled = false;
            backBtn.style.opacity = '1';
            backBtn.style.cursor = 'pointer';
          }
        }
      }

      // Remove discount code
      async function removeDiscountCode() {
        const discountInput = document.getElementById('discountCodeInput');
        const applyBtn = document.getElementById('applyDiscountBtn');
        const removeBtn = document.getElementById('removeDiscountBtn');
        const messageEl = document.getElementById('discountCodeMessage');
        const bannerEl = document.getElementById('discountAppliedBanner');
        const backBtn = document.getElementById('paymentBackBtn');

        try {
          removeBtn.disabled = true;
          removeBtn.textContent = 'Removing...';
          // Disable back button during removal
          if (backBtn) {
            backBtn.disabled = true;
            backBtn.style.opacity = '0.5';
            backBtn.style.cursor = 'not-allowed';
          }

          const removeDiscountFn = functions.httpsCallable('removeDiscountCode');
          await removeDiscountFn({
            domain: pendingDomain,
            sessionId: getSessionId()
          });

          // Re-enable the input and show Apply button
          discountInput.disabled = false;
          discountInput.value = '';
          applyBtn.style.display = 'block';
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply';
          removeBtn.style.display = 'none';
          messageEl.style.display = 'none';
          bannerEl.style.display = 'none';

          // Re-enable back button
          if (backBtn) {
            backBtn.disabled = false;
            backBtn.style.opacity = '1';
            backBtn.style.cursor = 'pointer';
          }

          // Refresh the quote to get full price again
          await updateQuote(true);
          window.domainDiscount = null;
          checkCurrentDomainStatus();
          refreshDiscountWindowState();

        } catch (err) {
          console.error('Remove discount code error:', err);
          const errorMessage = err.message || 'Failed to remove discount code';
          messageEl.textContent = errorMessage;
          messageEl.style.color = '#f04141';
          messageEl.style.display = 'block';
          removeBtn.disabled = false;
          removeBtn.textContent = 'Remove';
          // Re-enable back button on error
          if (backBtn) {
            backBtn.disabled = false;
            backBtn.style.opacity = '1';
            backBtn.style.cursor = 'pointer';
          }
        }
      }

      // --- Promo Code Admin (owner only, ADMIN_KEY gated) ---
      // Codes live in Blobs (promo/<CODE>), never in git or env. Default
      // maxUses=1: each code is bound to the first domain redeeming it.
      function promoAdminKey() {
        try { return sessionStorage.getItem('tunnel_admin_key') || ''; } catch (e) { return ''; }
      }
      function hasPromoAccess() {
        return validAdminKeyFrontend(promoAdminKey());
      }
      // Shared fresh-session bootstrap for admin-first boot (no session yet):
      // mirrors the domain-manager flow — generate + persist a session, then
      // hand it to the caller. Shows its own loader swaps; caller must NOT
      // hold a loader open across this call (it closes + re-shows).
      async function bootstrapSessionForAdmin() {
        const newSid = await generateSessionId();
        await createSessionInDb(newSid);
        setSessionId(newSid);
        return newSid;
      }
      function promoLock() {
        try { sessionStorage.removeItem('tunnel_admin_key'); } catch (e) {}
        updateSessionUI();
        closePromoAdmin();
        showToast('Admin locked.', 'info');
      }
      function openPromoAdmin() {
        if (!hasPromoAccess()) {
          showToast('Admin locked — unlock via Merge (or the Load box on a fresh device) with admin key.', 'error');
          return;
        }
        const overlay = document.getElementById('promoAdminOverlay');
        if (!overlay) return;
        overlay.style.display = 'flex';
        lockScroll();
        window.addEventListener('keydown', handlePromoAdminEsc);
        promoShowMain();
      }
      // Esc closes the Admin panel like every other dialogue — but yields to
      // anything stacked above it (confirm modal, report detail, link
      // detail, code stats), which have their own Esc handlers and close first.
      function handlePromoAdminEsc(e) {
        if (!e || e.key !== 'Escape') return;
        const modal = document.getElementById('modalOverlay');
        const detail = document.getElementById('feedbackDetailOverlay');
        const linkDetail = document.getElementById('adminLinkDetailOverlay');
        const stats = document.getElementById('promoStatsOverlay');
        if ((modal && modal.style.display === 'flex') ||
            (detail && detail.style.display === 'flex') ||
            (linkDetail && linkDetail.style.display === 'flex') ||
            (stats && stats.style.display === 'flex')) return;
        closePromoAdmin();
      }
      function closePromoAdmin() {
        const detail = document.getElementById('feedbackDetailOverlay');
        if (detail && detail.style.display === 'flex') feedbackCloseDetail();
        const linkDetail = document.getElementById('adminLinkDetailOverlay');
        if (linkDetail && linkDetail.style.display === 'flex') adminCloseLinkDetail();
        const stats = document.getElementById('promoStatsOverlay');
        if (stats && stats.style.display === 'flex') promoCloseStats();
        const overlay = document.getElementById('promoAdminOverlay');
        if (overlay) overlay.style.display = 'none';
        window.removeEventListener('keydown', handlePromoAdminEsc);
        unlockScroll();
      }
      function adminShowTab(tab) {
        const main = document.getElementById('promoMain');
        const view = document.getElementById('promoCodesView');
        const links = document.getElementById('linkMgmtView');
        const feedback = document.getElementById('feedbackView');
        const hint = document.getElementById('promoTabHint');
        const tabP = document.getElementById('adminTabPromo');
        const tabL = document.getElementById('adminTabLinks');
        const tabF = document.getElementById('adminTabFeedback');
        const isLinks = tab === 'links';
        const isFeedback = tab === 'feedback';
        if (main) main.style.display = (!isLinks && !isFeedback) ? 'block' : 'none';
        if (view) view.style.display = 'none';
        if (links) links.style.display = isLinks ? 'block' : 'none';
        if (feedback) feedback.style.display = isFeedback ? 'block' : 'none';
        if (hint) hint.style.display = (!isLinks && !isFeedback) ? 'block' : 'none';
        if (tabP) tabP.className = 'modal-btn ' + ((!isLinks && !isFeedback) ? 'modal-btn-ok' : 'modal-btn-cancel');
        if (tabL) tabL.className = 'modal-btn ' + (isLinks ? 'modal-btn-ok' : 'modal-btn-cancel');
        if (tabF) tabF.className = 'modal-btn ' + (isFeedback ? 'modal-btn-ok' : 'modal-btn-cancel');
        if (isFeedback) feedbackLoad();
        if (isLinks) blockedLoad();
      }
      function promoShowCodes() {
        adminShowTab('promo');
        const main = document.getElementById('promoMain');
        const view = document.getElementById('promoCodesView');
        if (main) main.style.display = 'none';
        if (view) view.style.display = 'block';
        promoLoad();
      }
      function promoShowMain() {
        adminShowTab('promo');
        const main = document.getElementById('promoMain');
        const view = document.getElementById('promoCodesView');
        if (view) view.style.display = 'none';
        if (main) main.style.display = 'block';
      }
      // --- Link Management (admin moderation, detail-modal pattern) ---
      // List rows are minimal (short link + state badges, no actions);
      // clicking a row opens the full link + all actions in a modal.
      // Client-side paging (10/page) over the searched set, same lightweight
      // pager as the Feedback tab. Lookups are by domain+code identity —
      // indexes shift under paging, so never by index.
      function adminTruncUrl(u) {
        const s = String(u || '');
        return s.length > 60 ? s.slice(0, 60) + '…' : s;
      }
      // Shared busy-state for admin action buttons: locks the button and
      // swaps its label while a server call runs, restores after. Prevents
      // aggressive double-clicks from firing an action twice.
      function adminBusy(btn, busy, busyText) {
        if (!btn) return;
        if (busy) {
          if (btn.dataset.origText === undefined) btn.dataset.origText = btn.textContent;
          btn.disabled = true;
          if (busyText) btn.textContent = busyText;
        } else {
          btn.disabled = false;
          if (btn.dataset.origText !== undefined) {
            btn.textContent = btn.dataset.origText;
            delete btn.dataset.origText;
          }
        }
      }
      // Backend link timestamps are epoch-ms numbers (not ISO strings like
      // the other docs) — format both shapes as "YYYY-MM-DD HH:MM".
      function adminFmtTime(t) {
        if (t === null || t === undefined || t === '') return '?';
        try {
          if (typeof t === 'number' && Number.isFinite(t)) {
            return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
          }
          const s = String(t);
          return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
        } catch (_) { return '?'; }
      }
      let adminLinkPage = 1;
      const ADMIN_LINKS_PER_PAGE = 10;
      function adminLinkKey(l) {
        return (l && l.domain ? String(l.domain).toLowerCase() : '') + '/' + (l && l.code ? l.code : '');
      }
      function adminFindLink(domain, code) {
        const all = Array.isArray(window._adminLinks) ? window._adminLinks : [];
        const key = String(domain || '').toLowerCase() + '/' + String(code || '');
        return all.find((l) => adminLinkKey(l) === key) || null;
      }
      function adminLinkBadges(l) {
        const q = l && l.quarantined
          ? '<span class="domain-status status-pending">Quarantined</span>'
          : '<span class="domain-status status-active">Live</span>';
        const b = l && l.originalBlocked
          ? ' <span class="domain-status status-blocked">Blocked</span>'
          : '';
        return q + b;
      }
      async function adminSearchLinks(keepPage = false) {
        const list = document.getElementById('adminLinksList');
        const btn = document.getElementById('adminSearchBtn');
        if (list) list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted);">Loading…</div>';
        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; }
          const fn = functions.httpsCallable('adminSearchLinks');
          const res = await fn({
            adminKey: promoAdminKey(),
            domain: (document.getElementById('adminSearchDomain').value || '').trim(),
            code: (document.getElementById('adminSearchCode').value || '').trim(),
            originalContains: (document.getElementById('adminSearchOrig').value || '').trim(),
            quarantinedOnly: !!document.getElementById('adminSearchQuar').checked,
          });
          window._adminLinks = res.data.links || [];
          window._adminLinksTruncated = res.data.truncated ? `Showing 50 of ${res.data.total} — refine search.` : '';
          if (!keepPage) adminLinkPage = 1;
          renderAdminLinks();
        } catch (e) {
          console.error('adminSearchLinks:', e);
          if (list) list.innerHTML = `<div style="padding:16px; text-align:center; color:var(--danger);">${escapeHTML(e.message || 'Search failed')}</div>`;
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Search'; }
        }
      }
      function renderAdminLinks() {
        const list = document.getElementById('adminLinksList');
        if (!list) return;
        const all = Array.isArray(window._adminLinks) ? window._adminLinks : [];
        if (!all.length) {
          list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted);">No links match.</div>';
          return;
        }
        const totalItems = all.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / ADMIN_LINKS_PER_PAGE));
        if (adminLinkPage > totalPages) adminLinkPage = Math.max(1, totalPages);
        if (adminLinkPage < 1) adminLinkPage = 1;
        const startIndex = (adminLinkPage - 1) * ADMIN_LINKS_PER_PAGE;
        const endIndex = Math.min(startIndex + ADMIN_LINKS_PER_PAGE, totalItems);
        const page = all.slice(startIndex, endIndex);
        let html = page.map((l) => {
          return `<div onclick="adminOpenLink(${escapeJS(l.domain || '')}, ${escapeJS(l.code || '')})" title="Open link details" style="padding:10px 12px; border:1px solid var(--border); border-radius:8px; margin-bottom:8px; cursor:pointer;">
            <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; min-width:0;">
              <div style="font-family:monospace; font-weight:700; overflow-wrap:anywhere; min-width:0;">${escapeHTML(l.domain)}/${escapeHTML(l.code)}</div>
              <div style="display:flex; gap:6px; flex-shrink:0; align-items:center;">${adminLinkBadges(l)}</div>
            </div>
          </div>`;
        }).join('');
        if (window._adminLinksTruncated) {
          html += `<div style="padding:8px; text-align:center; color:var(--text-muted); font-size:0.75rem;">${escapeHTML(window._adminLinksTruncated)}</div>`;
        }
        if (totalPages > 1) {
          html += `
          <div id="adminLinksPagination" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; padding: 12px 2px 2px; border-top: 1px solid var(--border);">
            <div style="font-size: 0.75rem; color: var(--text-faint); font-weight: 500; letter-spacing: 0.02em;">
              ${startIndex + 1}–${endIndex} of ${totalItems} · Page ${adminLinkPage} of ${totalPages}
            </div>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${adminLinkPage === 1 ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${adminLinkPage === 1 ? 'var(--text-muted)' : 'white'}; ${adminLinkPage === 1 ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="adminLinkChangePage(${adminLinkPage - 1})"
                ${adminLinkPage === 1 ? 'disabled' : ''}>
                ← Prev
              </button>
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${adminLinkPage === totalPages ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${adminLinkPage === totalPages ? 'var(--text-muted)' : 'white'}; ${adminLinkPage === totalPages ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="adminLinkChangePage(${adminLinkPage + 1})"
                ${adminLinkPage === totalPages ? 'disabled' : ''}>
                Next →
              </button>
            </div>
          </div>`;
        }
        list.innerHTML = html;
      }
      function adminLinkChangePage(newPage) {
        const all = Array.isArray(window._adminLinks) ? window._adminLinks : [];
        const totalPages = Math.max(1, Math.ceil(all.length / ADMIN_LINKS_PER_PAGE));
        if (newPage < 1 || newPage > totalPages) return;
        adminLinkPage = newPage;
        renderAdminLinks();
        setTimeout(() => {
          const pager = document.getElementById('adminLinksPagination');
          if (pager && typeof pager.scrollIntoView === 'function') {
            try { pager.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
          }
        }, 50);
      }
      function adminOpenLink(domain, code) {
        const l = adminFindLink(domain, code);
        if (!l) { showToast('Link no longer in the list — hit Search.', 'error'); return; }
        window._adminLinkDetail = { domain: l.domain, code: l.code };
        // Always start from a clean state: a previous action may have closed
        // the modal while locked (success path) — without this reset the
        // buttons would stay disabled on every reopen until a page reload.
        setAdminDetailBusy(false);
        const shortEl = document.getElementById('adminLinkDetailShort');
        const origEl = document.getElementById('adminLinkDetailOrig');
        const sessEl = document.getElementById('adminLinkDetailSession');
        const metaEl = document.getElementById('adminLinkDetailMeta');
        const badgesEl = document.getElementById('adminLinkDetailBadges');
        const qBtn = document.getElementById('adminLinkDetailQuarantine');
        const bBtn = document.getElementById('adminLinkDetailBlock');
        if (shortEl) shortEl.textContent = `${l.domain || ''}/${l.code || ''}`;
        if (origEl) { origEl.textContent = l.original || ''; origEl.scrollTop = 0; }
        if (sessEl) sessEl.textContent = l.sessionId || '?';
        if (metaEl) {
          const clicks = Number(l.clickCount) || 0;
          metaEl.textContent = `clicks ${clicks} · created ${adminFmtTime(l.timestamp)}`;
        }
        if (badgesEl) badgesEl.innerHTML = adminLinkBadges(l);
        if (qBtn) qBtn.textContent = l.quarantined ? 'Unquarantine' : 'Quarantine';
        if (bBtn) bBtn.textContent = l.originalBlocked ? 'Unblock URL' : 'Block URL';
        const overlay = document.getElementById('adminLinkDetailOverlay');
        if (overlay) {
          overlay.style.display = 'flex';
          lockScroll();
          window.addEventListener('keydown', handleAdminLinkDetailEsc);
        }
      }
      function handleAdminLinkDetailEsc(e) {
        if (e.key === 'Escape') adminCloseLinkDetail();
      }
      function adminCloseLinkDetail() {
        const overlay = document.getElementById('adminLinkDetailOverlay');
        if (overlay) overlay.style.display = 'none';
        // Defensive: never persist a locked state, however the modal closes.
        try { setAdminDetailBusy(false); } catch (_) {}
        window.removeEventListener('keydown', handleAdminLinkDetailEsc);
        unlockScroll();
      }
      function adminCopyDetailShort(btn) {
        const el = document.getElementById('adminLinkDetailShort');
        if (el) copyText(el.textContent, btn);
      }
      function adminCopyDetailSess(btn) {
        const el = document.getElementById('adminLinkDetailSession');
        if (el) copyText(el.textContent, btn);
      }
      function adminDetailRef() {
        const d = window._adminLinkDetail || {};
        const l = adminFindLink(d.domain, d.code);
        return { d, l };
      }
      // Detail-modal actions: lock all action buttons while the confirm +
      // server round-trip runs; close the modal only on success so a
      // failure leaves the user in place with buttons restored.
      function setAdminDetailBusy(active, activeBtn) {
        const overlay = document.getElementById('adminLinkDetailOverlay');
        if (!overlay) return;
        overlay.querySelectorAll('.btn-small').forEach((b) => adminBusy(b, active));
        if (active && activeBtn) activeBtn.textContent = 'Working…';
      }
      async function adminDetailQuarantine(btn) {
        const { d, l } = adminDetailRef();
        if (!d.domain) return;
        setAdminDetailBusy(true, btn || null);
        const done = await adminQuarantine(d.domain, d.code, !(l && l.quarantined));
        if (done) adminCloseLinkDetail();
        else setAdminDetailBusy(false);
      }
      async function adminDetailBlock(btn) {
        const { d, l } = adminDetailRef();
        if (!d.domain) return;
        setAdminDetailBusy(true, btn || null);
        const done = (l && l.originalBlocked)
          ? await adminUnblockOrig(l.original)
          : await adminBlockOrig(l ? l.original : '');
        if (done) adminCloseLinkDetail();
        else setAdminDetailBusy(false);
      }
      async function adminDetailDelete(btn) {
        const { d } = adminDetailRef();
        if (!d.domain) return;
        setAdminDetailBusy(true, btn || null);
        const done = await adminDeleteLink(d.domain, d.code);
        if (done) adminCloseLinkDetail();
        else setAdminDetailBusy(false);
      }
      async function adminQuarantine(domain, code, q) {
        const ok = await showCustomModal({
          title: q ? "Quarantine Link" : "Unquarantine Link",
          message: `${q ? 'Stop resolving' : 'Restore resolving for'} <strong>${escapeHTML(domain)}/${escapeHTML(code)}</strong>?`,
          showCancel: true, danger: !!q, confirmText: q ? "Quarantine" : "Restore", cancelText: "Cancel"
        });
        if (!ok) return false;
        try {
          const fn = functions.httpsCallable('adminSetQuarantine');
          await fn({ adminKey: promoAdminKey(), domain, shortCode: code, quarantined: q, reason: 'ADMIN' });
          showToast(q ? 'Link quarantined.' : 'Link restored.', 'success');
          await adminSearchLinks(true);
          return true;
        } catch (e) {
          showToast(e.message || 'Failed', 'error');
          return false;
        }
      }
      async function adminDeleteLink(domain, code) {
        const ok = await showCustomModal({
          title: "Delete Link",
          message: `Permanently delete <strong>${escapeHTML(domain)}/${escapeHTML(code)}</strong> for everyone (plus clicks + counters)?`,
          showCancel: true, danger: true, confirmText: "Delete", cancelText: "Keep"
        });
        if (!ok) return false;
        try {
          const fn = functions.httpsCallable('adminDeleteLink');
          await fn({ adminKey: promoAdminKey(), domain, shortCode: code });
          showToast('Link deleted.', 'success');
          await adminSearchLinks(true);
          return true;
        } catch (e) {
          showToast(e.message || 'Delete failed', 'error');
          return false;
        }
      }
      async function adminBlockOrig(original) {
        const orig = String(original || '').trim();
        if (!orig) { showToast('No original URL on this link.', 'error'); return false; }
        const ok = await showCustomModal({
          title: "Block URL",
          message: `Quarantine all links with this exact original and block re-mint?<br><span class="modal-url-box">${escapeHTML(adminTruncUrl(orig))}</span>`,
          showCancel: true, danger: true, confirmText: "Block", cancelText: "Cancel"
        });
        if (!ok) return false;
        try {
          const fn = functions.httpsCallable('adminBlockOriginal');
          const res = await fn({ adminKey: promoAdminKey(), original: orig, reason: 'ADMIN' });
          showToast(`Blocked. Quarantined ${res.data.swept || 0} link(s).`, 'success');
          await adminSearchLinks(true);
          try { blockedLoad(); } catch (_) {}
          return true;
        } catch (e) {
          showToast(e.message || 'Block failed', 'error');
          return false;
        }
      }
      async function adminUnblockOrig(original) {
        const orig = String(original || '').trim();
        if (!orig) { showToast('No original URL on this link.', 'error'); return false; }
        const ok = await showCustomModal({
          title: "Unblock URL",
          message: `Allow minting this original URL again?<br><span class="modal-url-box">${escapeHTML(adminTruncUrl(orig))}</span><br>Already-quarantined links stay quarantined — restore them individually if needed.`,
          showCancel: true, danger: true, confirmText: "Unblock", cancelText: "Cancel"
        });
        if (!ok) return false;
        try {
          const fn = functions.httpsCallable('adminUnblockOriginal');
          await fn({ adminKey: promoAdminKey(), original: orig });
          showToast('URL unblocked — minting allowed again.', 'success');
          await adminSearchLinks(true);
          try { blockedLoad(); } catch (_) {}
          return true;
        } catch (e) {
          showToast(e.message || 'Unblock failed', 'error');
          return false;
        }
      }
      // Blob list reads lag behind writes (eventual consistency): a code
      // created/revoked seconds ago may be missing/stale in the listing.
      // Callers pass the affected code so we re-check once after a delay.
      async function promoLoad(awaitCode, expectAbsent, keepPage = false) {
        const list = document.getElementById('promoCodesList');
        if (list) list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted);">Loading…</div>';
        const vBtn = document.getElementById('promoViewCodesBtn');
        const rBtn = document.getElementById('promoCodesRefreshBtn');
        try {
          adminBusy(vBtn, true);
          adminBusy(rBtn, true, 'Loading…');
          const fn = functions.httpsCallable('adminListDiscountCodes');
          const res = await fn({ adminKey: promoAdminKey() });
          const codes = res.data.codes || [];
          if (!keepPage) promoCodesPage = 1;
          renderPromoCodes(codes);
          if (awaitCode) {
            const present = codes.some((c) => c.code === awaitCode);
            if (present === !expectAbsent) return;
            if (list) list.innerHTML += '<div style="padding:8px; text-align:center; color:var(--text-muted); font-size:0.75rem;">Syncing latest change…</div>';
            setTimeout(async () => {
              try {
                const res2 = await fn({ adminKey: promoAdminKey() });
                renderPromoCodes(res2.data.codes || []);
              } catch (e2) { console.error('promoLoad retry:', e2); }
            }, 2500);
          }
        } catch (e) {
          console.error('promoLoad:', e);
          if (list) list.innerHTML = `<div style="padding:16px; text-align:center; color:var(--danger);">${escapeHTML(e.message || 'Unlock failed')}</div>`;
        } finally {
          adminBusy(vBtn, false);
          adminBusy(rBtn, false);
        }
      }
      // Promo codes list — paged 10/page like every other list. The full
      // array stays cached for Stats lookups; only the page renders.
      let promoCodesPage = 1;
      const PROMO_CODES_PER_PAGE = 10;
      function renderPromoCodes(codes) {
        const list = document.getElementById('promoCodesList');
        // Cache for the dedicated stats screen (avoids a refetch per open).
        const all = Array.isArray(codes) ? codes : [];
        window._promoCodes = all;
        if (!list) return;
        if (!all.length) {
          list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted);">No codes yet — create one below.</div>';
          return;
        }
        const totalItems = all.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / PROMO_CODES_PER_PAGE));
        if (promoCodesPage > totalPages) promoCodesPage = Math.max(1, totalPages);
        if (promoCodesPage < 1) promoCodesPage = 1;
        const startIndex = (promoCodesPage - 1) * PROMO_CODES_PER_PAGE;
        const endIndex = Math.min(startIndex + PROMO_CODES_PER_PAGE, totalItems);
        const page = all.slice(startIndex, endIndex);
        let html = page.map((c) => {
          const used = Number(c.used || 0), max = Number(c.maxUses || 1);
          const exhausted = used >= max;
          return `<div style="padding:10px 12px; border:1px solid var(--border); border-radius:8px; margin-bottom:8px; ${exhausted ? 'opacity:0.6;' : ''}">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
              <div style="display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap;">
                <div style="font-family:monospace; font-weight:700; overflow-wrap:anywhere;">${escapeHTML(c.code)}</div>
                <button class="btn-small btn-copy-small" onclick="copyText(${escapeJS(c.code)}, this)" title="Copy code">Copy</button>
              </div>
              <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
                <button class="btn-small btn-delete-small" onclick="promoRevoke(${escapeJS(c.code)}, this)" title="Revoke future use">Revoke</button>
                <button class="btn-small btn-copy-small" onclick="promoOpenStats(${escapeJS(c.code)})" title="Open redemption stats">Stats (${used})</button>
              </div>
            </div>
            <div style="font-size:0.8rem; margin-top:4px;">${c.percent}% off · <strong>${used}/${max}</strong> used · ${c.expiresAt ? `expires ${escapeHTML(c.expiresAt.slice(0, 10))}` : 'never expires'}${c.note ? ` · ${escapeHTML(c.note)}` : ''}</div>
          </div>`;
        }).join('');
        if (totalPages > 1) {
          html += `
          <div id="promoCodesPagination" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; padding: 12px 2px 2px; border-top: 1px solid var(--border);">
            <div style="font-size: 0.75rem; color: var(--text-faint); font-weight: 500; letter-spacing: 0.02em;">
              ${startIndex + 1}–${endIndex} of ${totalItems} · Page ${promoCodesPage} of ${totalPages}
            </div>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${promoCodesPage === 1 ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${promoCodesPage === 1 ? 'var(--text-muted)' : 'white'}; ${promoCodesPage === 1 ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="promoCodesChangePage(${promoCodesPage - 1})"
                ${promoCodesPage === 1 ? 'disabled' : ''}>
                ← Prev
              </button>
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${promoCodesPage === totalPages ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${promoCodesPage === totalPages ? 'var(--text-muted)' : 'white'}; ${promoCodesPage === totalPages ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="promoCodesChangePage(${promoCodesPage + 1})"
                ${promoCodesPage === totalPages ? 'disabled' : ''}>
                Next →
              </button>
            </div>
          </div>`;
        }
        list.innerHTML = html;
      }
      function promoCodesChangePage(newPage) {
        const all = Array.isArray(window._promoCodes) ? window._promoCodes : [];
        const totalPages = Math.max(1, Math.ceil(all.length / PROMO_CODES_PER_PAGE));
        if (newPage < 1 || newPage > totalPages) return;
        promoCodesPage = newPage;
        renderPromoCodes(all);
        setTimeout(() => {
          const pager = document.getElementById('promoCodesPagination');
          if (pager && typeof pager.scrollIntoView === 'function') {
            try { pager.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
          }
        }, 50);
      }
      // --- Blocked URLs list (orphan-safe unblock) ---
      // Blocks outlive their links by design, so this list — not link
      // search — is the place to review and undo them. Paged 10/page like
      // every other list.
      let blockedPage = 1;
      const BLOCKED_PER_PAGE = 10;
      async function blockedLoad(keepPage = false) {
        const list = document.getElementById('blockedList');
        const btn = document.getElementById('blockedRefreshBtn');
        if (!list) return;
        list.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:0.8rem;">Loading…</div>';
        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
          const fn = functions.httpsCallable('adminListBlocked');
          const res = await fn({ adminKey: promoAdminKey() });
          if (!keepPage) blockedPage = 1;
          renderBlocked(res.data.blocked || []);
        } catch (e) {
          console.error('blockedLoad:', e);
          list.innerHTML = `<div style="padding:12px; text-align:center; color:var(--danger); font-size:0.8rem;">${escapeHTML(e.message || 'Load failed')}</div>`;
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
        }
      }
      function renderBlocked(items) {
        const list = document.getElementById('blockedList');
        if (!list) return;
        const all = Array.isArray(items) ? items : [];
        window._blockedUrls = all;
        if (!all.length) {
          list.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No blocked URLs.</div>';
          return;
        }
        const totalItems = all.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / BLOCKED_PER_PAGE));
        if (blockedPage > totalPages) blockedPage = Math.max(1, totalPages);
        if (blockedPage < 1) blockedPage = 1;
        const startIndex = (blockedPage - 1) * BLOCKED_PER_PAGE;
        const endIndex = Math.min(startIndex + BLOCKED_PER_PAGE, totalItems);
        const page = all.slice(startIndex, endIndex);
        let html = page.map((b) => {
          const label = b.original || b.host || b.hash;
          const when = b.at ? String(b.at).slice(0, 16).replace('T', ' ') : '?';
          const old = !b.original ? ' <span style="color:var(--text-faint);">(host only — blocked before URL tracking)</span>' : '';
          return `<div style="padding:10px 12px; border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
              <div style="min-width:0;">
                <div style="font-size:0.85rem; overflow-wrap:anywhere; font-family:monospace;">${escapeHTML(label)}</div>
                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${escapeHTML(when)}${old}${b.reason ? ` · ${escapeHTML(b.reason)}` : ''}</div>
              </div>
              <button class="btn-small btn-copy-small" style="flex-shrink:0;" onclick="blockedUnblock(${escapeJS(b.hash || '')}, ${escapeJS(label)}, this)" title="Allow minting this URL again">Unblock</button>
            </div>
          </div>`;
        }).join('');
        if (totalPages > 1) {
          html += `
          <div id="blockedPagination" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; padding: 12px 2px 2px; border-top: 1px solid var(--border);">
            <div style="font-size: 0.75rem; color: var(--text-faint); font-weight: 500; letter-spacing: 0.02em;">
              ${startIndex + 1}–${endIndex} of ${totalItems} · Page ${blockedPage} of ${totalPages}
            </div>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${blockedPage === 1 ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${blockedPage === 1 ? 'var(--text-muted)' : 'white'}; ${blockedPage === 1 ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="blockedChangePage(${blockedPage - 1})"
                ${blockedPage === 1 ? 'disabled' : ''}>
                ← Prev
              </button>
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${blockedPage === totalPages ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${blockedPage === totalPages ? 'var(--text-muted)' : 'white'}; ${blockedPage === totalPages ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="blockedChangePage(${blockedPage + 1})"
                ${blockedPage === totalPages ? 'disabled' : ''}>
                Next →
              </button>
            </div>
          </div>`;
        }
        list.innerHTML = html;
      }
      function blockedChangePage(newPage) {
        const all = Array.isArray(window._blockedUrls) ? window._blockedUrls : [];
        const totalPages = Math.max(1, Math.ceil(all.length / BLOCKED_PER_PAGE));
        if (newPage < 1 || newPage > totalPages) return;
        blockedPage = newPage;
        renderBlocked(all);
        setTimeout(() => {
          const pager = document.getElementById('blockedPagination');
          if (pager && typeof pager.scrollIntoView === 'function') {
            try { pager.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
          }
        }, 50);
      }
      async function blockedUnblock(hash, label, btn) {
        const h = String(hash || '').trim();
        if (!h) return;
        const ok = await showCustomModal({
          title: "Unblock URL",
          message: `Allow minting this original URL again?<br><span class="modal-url-box">${escapeHTML(adminTruncUrl(label))}</span>`,
          showCancel: true, danger: true, confirmText: "Unblock", cancelText: "Cancel"
        });
        if (!ok) return;
        const el = (btn instanceof HTMLElement) ? btn : null;
        try {
          adminBusy(el, true, '…');
          const fn = functions.httpsCallable('adminUnblockOriginal');
          await fn({ adminKey: promoAdminKey(), hash: h });
          showToast('URL unblocked — minting allowed again.', 'success');
          blockedLoad(true);
          // Link badges may have changed too (Blocked flag now clears).
          try { await adminSearchLinks(true); } catch (_) {}
        } catch (e) {
          showToast(e.message || 'Unblock failed', 'error');
        } finally {
          adminBusy(el, false);
        }
      }
      // --- Feedback reports (admin moderation) ---
      // Client-side paging (10/page): the backend caps the list at 500 and a
      // Blobs prefix-list is inherently a full scan, so paging lives in the
      // UI — page turns re-render from cache with no refetch.
      let feedbackPage = 1;
      const FEEDBACK_PER_PAGE = 10;
      async function feedbackLoad(keepPage = false) {
        const list = document.getElementById('feedbackList');
        const btn = document.getElementById('feedbackRefreshBtn');
        if (list) list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted);">Loading…</div>';
        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
          const fn = functions.httpsCallable('adminListFeedback');
          const res = await fn({ adminKey: promoAdminKey() });
          if (!keepPage) feedbackPage = 1;
          renderFeedback(res.data.reports || []);
        } catch (e) {
          console.error('feedbackLoad:', e);
          if (list) list.innerHTML = `<div style="padding:16px; text-align:center; color:var(--danger);">${escapeHTML(e.message || 'Load failed')}</div>`;
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
        }
      }
      function renderFeedback(reports) {
        const list = document.getElementById('feedbackList');
        if (!list) return;
        // Cache for the detail modal + pager (avoids a refetch per open/page).
        const all = Array.isArray(reports) ? reports : [];
        window._feedbackReports = all;
        const delAllBtn = document.getElementById('feedbackDeleteAllBtn');
        if (delAllBtn) delAllBtn.disabled = !all.length;
        if (!all.length) {
          list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted);">No reports yet.</div>';
          return;
        }
        const totalItems = all.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / FEEDBACK_PER_PAGE));
        // Clamp: deletes can leave the page past the end.
        if (feedbackPage > totalPages) feedbackPage = Math.max(1, totalPages);
        if (feedbackPage < 1) feedbackPage = 1;
        const startIndex = (feedbackPage - 1) * FEEDBACK_PER_PAGE;
        const endIndex = Math.min(startIndex + FEEDBACK_PER_PAGE, totalItems);
        const page = all.slice(startIndex, endIndex);
        // Admin-only view (gated by ADMIN_KEY): full session ID on purpose,
        // so reports can be matched to links/domains. Click opens the full
        // message in a scrollable detail window.
        let html = page.map((r) => {
          const when = r.createdAt ? String(r.createdAt).slice(0, 16).replace('T', ' ') : '?';
          const msg = String(r.message || '');
          const preview = msg.length > 180 ? msg.slice(0, 180) + '…' : msg;
          return `<div onclick="feedbackOpen(${escapeJS(r.id)})" title="Open full report" style="padding:10px 12px; border:1px solid var(--border); border-radius:8px; margin-bottom:8px; cursor:pointer;">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
              <div style="font-size:0.75rem; color:var(--text-muted); min-width:0;">session <span style="font-family:monospace; color:var(--text); overflow-wrap:anywhere;">${escapeHTML(r.sessionId || '?')}</span> · IP <span style="font-family:monospace; color:var(--text); overflow-wrap:anywhere;">${escapeHTML(feedbackIpLabel(r))}</span>${r.contact ? ` · ✉️ <span style="color:var(--text); overflow-wrap:anywhere;">${escapeHTML(r.contact)}</span>` : ''} · ${escapeHTML(when)}</div>
              <div style="display:flex; gap:6px; flex-shrink:0;" onclick="event.stopPropagation()">
                <button class="btn-small btn-copy-small" onclick="copyText(${escapeJS(r.sessionId || '')}, this)" title="Copy full session ID">Copy ID</button>
                <button class="btn-small btn-delete-small" onclick="feedbackDelete(${escapeJS(r.id)}, this)" title="Delete report">Delete</button>
              </div>
            </div>
            <div style="font-size:0.88rem; margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere;">${escapeHTML(preview)}</div>
          </div>`;
        }).join('');
        // Lightweight pager nav (deliberately NOT a card: no background box,
        // so it can't blend with the report boxes above — just a faint top
        // divider, compact muted counts, and pill buttons). Rendered only
        // past one page.
        if (totalPages > 1) {
          html += `
          <div id="feedbackPagination" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; padding: 12px 2px 2px; border-top: 1px solid var(--border);">
            <div style="font-size: 0.75rem; color: var(--text-faint); font-weight: 500; letter-spacing: 0.02em;">
              ${startIndex + 1}–${endIndex} of ${totalItems} · Page ${feedbackPage} of ${totalPages}
            </div>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${feedbackPage === 1 ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${feedbackPage === 1 ? 'var(--text-muted)' : 'white'}; ${feedbackPage === 1 ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="feedbackChangePage(${feedbackPage - 1})"
                ${feedbackPage === 1 ? 'disabled' : ''}>
                ← Prev
              </button>
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${feedbackPage === totalPages ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${feedbackPage === totalPages ? 'var(--text-muted)' : 'white'}; ${feedbackPage === totalPages ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="feedbackChangePage(${feedbackPage + 1})"
                ${feedbackPage === totalPages ? 'disabled' : ''}>
                Next →
              </button>
            </div>
          </div>`;
        }
        list.innerHTML = html;
      }
      function feedbackChangePage(newPage) {
        const all = Array.isArray(window._feedbackReports) ? window._feedbackReports : [];
        const totalPages = Math.max(1, Math.ceil(all.length / FEEDBACK_PER_PAGE));
        if (newPage < 1 || newPage > totalPages) return;
        feedbackPage = newPage;
        renderFeedback(all);
        // Keep the pager visible inside the scrollable admin modal.
        setTimeout(() => {
          const pager = document.getElementById('feedbackPagination');
          if (pager && typeof pager.scrollIntoView === 'function') {
            try { pager.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
          }
        }, 50);
      }
      function feedbackFindCached(id) {
        const all = Array.isArray(window._feedbackReports) ? window._feedbackReports : [];
        return all.find((r) => r && r.id === id) || null;
      }
      // Plain-text reporter IP.
      function feedbackIpLabel(r) {
        return (r && r.ip) ? String(r.ip) : '?';
      }
      function feedbackOpen(id) {
        const r = feedbackFindCached(id);
        if (!r) { showToast('Report no longer in the list — hit Refresh.', 'error'); return; }
        const overlay = document.getElementById('feedbackDetailOverlay');
        const sessEl = document.getElementById('feedbackDetailSession');
        const whenEl = document.getElementById('feedbackDetailWhen');
        const ipEl = document.getElementById('feedbackDetailIp');
        const contactRow = document.getElementById('feedbackDetailContactRow');
        const contactEl = document.getElementById('feedbackDetailContact');
        const msgEl = document.getElementById('feedbackDetailMessage');
        const delBtn = document.getElementById('feedbackDetailDelete');
        if (sessEl) sessEl.textContent = r.sessionId || '?';
        if (whenEl) whenEl.textContent = r.createdAt ? String(r.createdAt).slice(0, 16).replace('T', ' ') : '?';
        if (ipEl) ipEl.textContent = feedbackIpLabel(r);
        if (contactRow) contactRow.style.display = r.contact ? 'flex' : 'none';
        if (contactEl) contactEl.textContent = r.contact || '';
        if (msgEl) { msgEl.textContent = r.message || ''; msgEl.scrollTop = 0; }
        if (delBtn) delBtn.onclick = () => feedbackDelete(r.id, '#feedbackDetailDelete');
        if (overlay) {
          overlay.style.display = 'flex';
          lockScroll();
          window.addEventListener('keydown', handleFeedbackDetailEsc);
        }
      }
      function handleFeedbackDetailEsc(e) {
        if (e.key === 'Escape') feedbackCloseDetail();
      }
      function feedbackCloseDetail() {
        const overlay = document.getElementById('feedbackDetailOverlay');
        if (overlay) overlay.style.display = 'none';
        window.removeEventListener('keydown', handleFeedbackDetailEsc);
        unlockScroll();
      }
      function feedbackCopyDetailSession(btn) {
        const el = document.getElementById('feedbackDetailSession');
        if (el) copyText(el.textContent, btn);
      }
      function feedbackCopyDetailContact(btn) {
        const el = document.getElementById('feedbackDetailContact');
        if (el) copyText(el.textContent, btn);
      }
      async function feedbackTestMail() {
        const btn = document.getElementById('feedbackTestMailBtn');
        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
          const fn = functions.httpsCallable('adminTestFeedbackMail');
          await fn({ adminKey: promoAdminKey() });
          showToast('Test mail sent — check the notify inbox (and spam).', 'info');
        } catch (e) {
          showCustomModal({ title: 'Test mail failed', message: escapeHTML(e.message || 'Send failed') });
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Send test mail'; }
        }
      }
      async function feedbackDelete(id, btn) {
        const okDel = await showCustomModal({
          title: 'Delete report?',
          message: 'This removes the report from storage. This cannot be undone.',
          showCancel: true,
          danger: true
        });
        if (!okDel) return;
        const el = (btn instanceof HTMLElement) ? btn : (btn ? document.querySelector(btn) : null);
        try {
          adminBusy(el, true, '…');
          const fn = functions.httpsCallable('adminDeleteFeedback');
          await fn({ adminKey: promoAdminKey(), id });
          showToast('Report deleted.', 'info');
          try { feedbackCloseDetail(); } catch (_) {}
          feedbackLoad(true);
        } catch (e) {
          showToast(e.message || 'Delete failed', 'error');
        } finally {
          adminBusy(el, false);
        }
      }
      async function feedbackDeleteAll() {
        const all = Array.isArray(window._feedbackReports) ? window._feedbackReports : [];
        if (!all.length) { showToast('No reports to delete.', 'info'); return; }
        const n = all.length;
        const okDel = await showCustomModal({
          title: 'Delete all reports?',
          message: `This permanently removes <strong>${n} report${n === 1 ? '' : 's'}</strong> from storage. This cannot be undone.<br><br>Copies already sent to your mailbox are kept.`,
          showCancel: true,
          danger: true,
          confirmText: 'Delete All'
        });
        if (!okDel) return;
        const btn = document.getElementById('feedbackDeleteAllBtn');
        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
          const fn = functions.httpsCallable('adminDeleteAllFeedback');
          const res = await fn({ adminKey: promoAdminKey() });
          const deleted = Number(res.data.deleted || 0);
          showToast(`Deleted ${deleted} report${deleted === 1 ? '' : 's'}.`, 'info');
          feedbackPage = 1;
          feedbackLoad();
        } catch (e) {
          showToast(e.message || 'Delete all failed', 'error');
        } finally {
          if (btn) { btn.textContent = 'Delete All'; }
        }
      }
      function promoFindCached(code) {
        const all = Array.isArray(window._promoCodes) ? window._promoCodes : [];
        return all.find((c) => c && c.code === code) || null;
      }
      // Redemptions list — paged 10/page like every other list.
      let promoStatsPage = 1;
      const PROMO_STATS_PER_PAGE = 10;
      function promoOpenStats(code) {
        const c = promoFindCached(code);
        if (!c) { showToast('Code no longer in the list — hit Refresh.', 'error'); return; }
        const overlay = document.getElementById('promoStatsOverlay');
        const codeEl = document.getElementById('promoStatsCode');
        const summaryEl = document.getElementById('promoStatsSummary');
        const countEl = document.getElementById('promoStatsCount');
        const used = Number(c.used || 0), max = Number(c.maxUses || 1);
        const uses = Array.isArray(c.uses) ? c.uses.slice().reverse() : [];
        window._promoStatsUses = uses;
        window._promoStatsUsed = used;
        promoStatsPage = 1;
        if (codeEl) codeEl.textContent = c.code || '';
        if (summaryEl) {
          summaryEl.innerHTML = `${c.percent}% off · <strong>${used}/${max}</strong> used · ${c.expiresAt ? `expires ${escapeHTML(c.expiresAt.slice(0, 10))}` : 'never expires'}${c.note ? ` · ${escapeHTML(c.note)}` : ''}${c.createdAt ? `<div style="margin-top:4px; color:var(--text-muted);">Created ${escapeHTML(String(c.createdAt).slice(0, 10))}</div>` : ''}`;
        }
        if (countEl) {
          const truncated = used > uses.length ? ` · showing latest ${uses.length}` : '';
          countEl.textContent = `Redemptions (${used})${truncated}`;
        }
        renderPromoStatsUses();
        if (overlay) {
          overlay.style.display = 'flex';
          lockScroll();
          window.addEventListener('keydown', handlePromoStatsEsc);
        }
      }
      function renderPromoStatsUses() {
        const listEl = document.getElementById('promoStatsList');
        if (!listEl) return;
        const uses = Array.isArray(window._promoStatsUses) ? window._promoStatsUses : [];
        if (!uses.length) {
          listEl.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">No redemptions yet.</div>';
          return;
        }
        const totalItems = uses.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / PROMO_STATS_PER_PAGE));
        if (promoStatsPage > totalPages) promoStatsPage = Math.max(1, totalPages);
        if (promoStatsPage < 1) promoStatsPage = 1;
        const startIndex = (promoStatsPage - 1) * PROMO_STATS_PER_PAGE;
        const endIndex = Math.min(startIndex + PROMO_STATS_PER_PAGE, totalItems);
        const page = uses.slice(startIndex, endIndex);
        let html = page.map((u, i) =>
          `<div class="click-entry"><div style="min-width:0;"><div class="click-time font-bold" style="overflow-wrap:anywhere;">#${totalItems - (startIndex + i)} · ${escapeHTML(u.domain || '?')}</div><div class="click-ip">session <span style="font-family:monospace;">${escapeHTML(u.sessionId || '?')}</span> · ${escapeHTML((u.at || '').slice(0, 10))}</div></div></div>`
        ).join('');
        if (totalPages > 1) {
          html += `
          <div id="promoStatsPagination" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; padding: 12px 2px 2px; border-top: 1px solid var(--border);">
            <div style="font-size: 0.75rem; color: var(--text-faint); font-weight: 500; letter-spacing: 0.02em;">
              ${startIndex + 1}–${endIndex} of ${totalItems} · Page ${promoStatsPage} of ${totalPages}
            </div>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${promoStatsPage === 1 ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${promoStatsPage === 1 ? 'var(--text-muted)' : 'white'}; ${promoStatsPage === 1 ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="promoStatsChangePage(${promoStatsPage - 1})"
                ${promoStatsPage === 1 ? 'disabled' : ''}>
                ← Prev
              </button>
              <button class="session-item btn-session"
                style="padding: 0 14px; background: ${promoStatsPage === totalPages ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${promoStatsPage === totalPages ? 'var(--text-muted)' : 'white'}; ${promoStatsPage === totalPages ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                onclick="promoStatsChangePage(${promoStatsPage + 1})"
                ${promoStatsPage === totalPages ? 'disabled' : ''}>
                Next →
              </button>
            </div>
          </div>`;
        }
        listEl.innerHTML = html;
        listEl.scrollTop = 0;
      }
      function promoStatsChangePage(newPage) {
        const uses = Array.isArray(window._promoStatsUses) ? window._promoStatsUses : [];
        const totalPages = Math.max(1, Math.ceil(uses.length / PROMO_STATS_PER_PAGE));
        if (newPage < 1 || newPage > totalPages) return;
        promoStatsPage = newPage;
        renderPromoStatsUses();
      }
      function handlePromoStatsEsc(e) {
        if (e.key === 'Escape') promoCloseStats();
      }
      function promoCloseStats() {
        const overlay = document.getElementById('promoStatsOverlay');
        if (overlay) overlay.style.display = 'none';
        window.removeEventListener('keydown', handlePromoStatsEsc);
        unlockScroll();
      }
      async function promoCreate() {
        const codeEl = document.getElementById('promoNewCode');
        const pctEl = document.getElementById('promoNewPercent');
        const maxEl = document.getElementById('promoNewMax');
        const expEl = document.getElementById('promoNewExpiry');
        const noteEl = document.getElementById('promoNewNote');
        const btn = document.getElementById('promoCreateBtn');
        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
          const fn = functions.httpsCallable('adminCreateDiscountCode');
          const neverEl = document.getElementById('promoNeverExpiry');
          const res = await fn({
            adminKey: promoAdminKey(),
            code: (codeEl.value || '').trim(),
            percent: Number(pctEl.value),
            maxUses: maxEl.value === '' ? 1 : Number(maxEl.value),
            expiresAt: (neverEl && neverEl.checked) ? null : ((expEl.value || '').trim() || null),
            note: (noteEl.value || '').trim(),
          });
          showToast(`Code ${res.data.code} created (${res.data.percent}% off).`, 'success');
          codeEl.value = ''; noteEl.value = ''; expEl.value = '';
          if (neverEl) { neverEl.checked = true; expEl.disabled = true; }
          promoShowCodes();
          await promoLoad(res.data.code, false);
        } catch (e) {
          console.error('promoCreate:', e);
          showToast(e.message || 'Create failed', 'error');
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
        }
      }
      async function promoRevoke(code, btn) {
        const ok = await showCustomModal({
          title: "Revoke Code",
          message: `Revoke <strong>${escapeHTML(code)}</strong>? Domains that already used it keep their discount; it just can't be redeemed again.`,
          showCancel: true, danger: true, confirmText: "Revoke", cancelText: "Keep"
        });
        if (!ok) return;
        const el = (btn instanceof HTMLElement) ? btn : null;
        try {
          adminBusy(el, true, '…');
          const fn = functions.httpsCallable('adminDeleteDiscountCode');
          await fn({ adminKey: promoAdminKey(), code });
          showToast(`Code ${code} revoked.`, 'success');
          await promoLoad(code, true, true);
        } catch (e) {
          console.error('promoRevoke:', e);
          showToast(e.message || 'Revoke failed', 'error');
        } finally {
          adminBusy(el, false);
        }
      }

      // --- Payment Status Polling ---
      // Polls the Netlify backend every 10s while payment step is open.
      // Auto-activates UI when payment is detected.
      let _paymentPollInterval = null;
      const PAYMENT_POLL_INTERVAL_MS = 10000; // 10 seconds
      const PAYMENT_POLL_MAX_MS = 2 * 60 * 60 * 1000; // 2 hours max
      let checkCooldownUntil = 0;
      let checkCooldownTimer = null;
      function clearCheckCooldown() {
        checkCooldownUntil = 0;
        if (checkCooldownTimer) { clearInterval(checkCooldownTimer); checkCooldownTimer = null; }
        const btn = document.getElementById('checkPayBtn');
        if (btn) { btn.disabled = false; btn.textContent = "I've paid — Check now"; }
      }
      function setCheckCooldown(ms) {
        checkCooldownUntil = Date.now() + ms;
        if (checkCooldownTimer) clearInterval(checkCooldownTimer);
        const tick = () => {
          const left = Math.ceil((checkCooldownUntil - Date.now()) / 1000);
          const btn = document.getElementById('checkPayBtn');
          if (left <= 0) { clearCheckCooldown(); return; }
          if (btn) { btn.disabled = true; btn.textContent = `Wait ${left}s…`; }
        };
        tick();
        checkCooldownTimer = setInterval(tick, 1000);
      }

      function stopPaymentPolling() {
        if (_paymentPollInterval) {
          clearInterval(_paymentPollInterval);
          _paymentPollInterval = null;
        }
      }

      function startPaymentPolling(domain) {
        stopPaymentPolling(); // clear any existing poll
        if (!domain) return;

        const banner = document.getElementById('paymentStatusBanner');
        if (banner) {
          banner.style.display = 'block';
          banner.textContent = '⏳ Waiting for payment confirmation...';
          banner.style.color = '#aaaaaa';
          banner.style.background = 'rgba(255,255,255,0.05)';
          banner.style.borderColor = 'var(--border)';
        }

        const startTime = Date.now();
        let pollTick = 0;

        _paymentPollInterval = setInterval(async () => {
          // Stop if modal was closed or max time exceeded
          const paymentStep = document.getElementById('addDomainStepPayment');
          const managerVisible = domainManagerOverlay && domainManagerOverlay.style.display === 'flex';
          if (!managerVisible || !paymentStep || paymentStep.style.display === 'none') {
            stopPaymentPolling();
            return;
          }
          if (pendingDomain !== domain) {
            stopPaymentPolling();
            return;
          }
          if (Date.now() - startTime > PAYMENT_POLL_MAX_MS) {
            stopPaymentPolling();
            if (banner) {
              banner.textContent = '⚠️ Polling stopped after 2 hours. Refresh manually or check back later.';
              banner.style.color = '#f5a623';
            }
            return;
          }
          pollTick++;
          // Every ~60s, run the real chain check (activation within ~1–2 min
          // of the first confirmation with the tab open; ~1 call/min stays
          // well under the backend's check budget). The 10s status mirror
          // below picks up the activation on its next tick.
          if (pollTick % 6 === 0 && pendingDomain === domain) {
            try { await checkPaymentNow(true); } catch (e) { /* next cycle */ }
            if (document.getElementById('paymentStatusBanner')?.textContent?.startsWith('✅')) return;
          }

          try {
            // Same-origin backend check: ask getDomainVerificationInfo for the live status.
            const infoFn = functions.httpsCallable('getDomainVerificationInfo');
            const info = await infoFn({ domain, sessionId: getSessionId() });

            if (info.data && info.data.status === 'active') {
              stopPaymentPolling();
              // Show success banner, including what the payment bought.
              if (banner) {
                banner.style.display = 'block';
                banner.style.background = 'rgba(43,166,64,0.12)';
                banner.style.borderColor = '#6fcf7f';
                banner.style.color = '#6fcf7f';
                let coverNote = 'Your domain is now active.';
                if (info.data.coverageLifetime === true) {
                  coverNote = 'Your domain is now active with lifetime coverage.';
                } else if (info.data.coverageExpiresAt) {
                  try {
                    coverNote = `Your domain is now active — covered until ${new Date(info.data.coverageExpiresAt).toLocaleDateString()}.`;
                  } catch (e) { /* date parse fallback below */ }
                }
                banner.textContent = `✅ Payment confirmed! ${coverNote}`;
              }
              // Refresh domain list
              await loadUserDomains();
              // Auto-close modal after short delay
              const closedFor = pendingDomain;
              setTimeout(() => {
                if (pendingDomain && pendingDomain !== closedFor) return;
                closeDomainManager();
              }, 2500);
            }
          } catch (err) {
            console.error('Payment poll error:', err);
          }
        }, PAYMENT_POLL_INTERVAL_MS);
      }

      function filterHistoryByDomain() {
        currentPage = 1;
        renderHistory();
      }

      const openMgrBtn = document.getElementById('openDomainManager');
      if (openMgrBtn) openMgrBtn.onclick = () => showDomainManager();
      const addNewBtn = document.getElementById('dropdownAddNew');
      if (addNewBtn) addNewBtn.onclick = () => showDomainManager();

      async function promptSessionLoad() {
        // Frontend rate limit: SESSION_RATE_LIMIT_MS between manual attempts
        const nowAttempt = Date.now();
        if (nowAttempt - lastManualSessionAttempt < SESSION_RATE_LIMIT_MS) {
          showCustomModal({
            title: "Please Wait",
            message: "You're trying too fast. Please wait a moment before retrying."
          });
          return;
        }
        lastManualSessionAttempt = nowAttempt;
        if (!requireBackend()) return;
        const sid = await showCustomModal({
          title: "Load Session ID",
          message: "Enter your 10-character Session ID to synchronize your history.",
          showCancel: true,
          showInput: true,
          inputPlaceholder: "Enter your session ID...",
          inputType: 'password'
        });

        if (sid && sid.trim()) {
          const val = sid.trim();
          const sessionRegex = /^[A-Za-z023456789]{10}$/;
          if (!sessionRegex.test(val) || val.length !== SESSION_ID_LENGTH || val.includes('1')) {
            // Fresh-instance admin path: the Load box doubles as the admin
            // entry when there is no session yet (Merge is unreachable without
            // one). Valid admin keys auto-create an empty session first —
            // exactly like adding a domain does — then unlock admin on it.
            if (validAdminKeyFrontend(val)) {
              showLoadingModal({ title: "Verifying admin key…", message: "Checking, please wait" });
              let adminOk = false;
              try {
                const adminFn = functions.httpsCallable('adminListDiscountCodes');
                await adminFn({ adminKey: val });
                adminOk = true;
              } catch (e) {
                adminOk = false;
              }
              if (!adminOk) {
                closeLoadingModal();
                showCustomModal({ title: "Not Found", message: "Unknown Session ID." });
                return;
              }
              try {
                closeLoadingModal();
                showLoadingModal({ title: "Creating Session", message: "Creating a new session with admin unlocked, please wait" });
                const newSid = await bootstrapSessionForAdmin();
                try { sessionStorage.setItem('tunnel_admin_key', val); } catch (e) {}
                updateSessionUI();
                await fetchAndRenderSession(newSid, true);
                try { await loadUserDomains(); } catch (e) {}
              } catch (e) {
                console.error('Admin bootstrap failed:', e);
                closeLoadingModal();
                showCustomModal({ title: "Error", message: "Failed to create a session. Please try again." });
                return;
              }
              closeLoadingModal();
              showCustomModal({
                title: "Admin Unlocked",
                message: "A new session was created (no links yet) with admin already unlocked. Use the <strong>Admin</strong> button next to your session controls."
              });
              return;
            }
            showCustomModal({
              title: "Invalid Format",
              message: `Session IDs must be ${SESSION_ID_LENGTH} characters, letters and numbers only (no 1, no specials).`
            });
            return;
          }

          // Show loading modal during validation and fetching
          showLoadingModal({
            title: "🔄 Syncing Session",
            message: "Validating and fetching your history..."
          });

          // Validate and load (retry once: a session created seconds ago in
          // another tab can still read back as missing from the edge cache).
          try {
            const validateFn = functions.httpsCallable('validateSession');
            let exists = false;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const res = await validateFn({ sessionId: val });
                if (res.data.exists) { exists = true; break; }
              } catch (e) {
                console.warn(`validateSession attempt ${attempt + 1}/2 failed:`, (e && e.message) || e);
                if (attempt === 1) throw e;
              }
              if (attempt < 1) await new Promise((r) => setTimeout(r, 500));
            }

            if (!exists) {
              closeLoadingModal();
              showCustomModal({
                title: "Session Not Found",
                message: "No links found for this Session ID. Please check and try again."
              });
              return;
            }

            setSessionId(val);
            await fetchAndRenderSession(val, true);
          } catch (e) {
            console.error(e);
            closeLoadingModal();
            showCustomModal({ title: "Error", message: "Failed to validate session. Please try again later." });
          } finally {
            closeLoadingModal();
          }
        }
      }

      function toggleSessionIdVisibility() {
        const display = document.getElementById('displaySessionId');
        const toggle = document.getElementById('sessionIdToggle');
        const sid = getSessionId();

        if (!sid) return;

        if (toggle.classList.contains('visible')) {
          // Hide the session ID
          display.textContent = '**********';
          toggle.classList.remove('visible');
        } else {
          // Show the session ID
          display.textContent = sid;
          toggle.classList.add('visible');
        }
      }

      function copySessionId() {
        const sid = getSessionId();
        if (sid) copyText(sid, null);
      }

      // Idempotent boot-loader dismissal (also called early by the instant
      // cached paint; the initApp finally-block calls it again as a no-op).
      function dismissBootLoader() {
        window.__tunnelBooted = true;
        const initialLoader = document.getElementById('initialLoadingScreen');
        if (initialLoader) {
          initialLoader.style.opacity = '0';
          initialLoader.style.visibility = 'hidden';
          // Remove the class that prevents scrolling
          document.body.classList.remove('initial-loading');
          setTimeout(() => { try { initialLoader.remove(); } catch (e) {} }, 500);
        } else {
          document.body.classList.remove('initial-loading');
        }
      }

      // Initialize on load
      initApp();

      async function initApp() {
        // Check if there's an existing session - only show "Syncing session..." if there is
        // (uses getSessionId() so malformed stored IDs are purged first, no extra read).
        const syncingText = document.getElementById('syncingSessionText');
        const existingSessionId = getSessionId();
        
        // If no existing session, hide the syncing text
        if (!existingSessionId && syncingText) {
          syncingText.style.display = 'none';
        }
        
        try {
          updateSessionUI();

          // Offline/degraded boot: backend calls below would all fail, so
          // render what we can (empty state) instead of erroring per call.
          if (!backendReady) {
            console.warn('Booting without backend (offline?).');
            renderEmptyState();
            showToast('Backend unreachable — showing cached state. Reload when online.', 'error');
            return;
          }

          let sid = getSessionId();

          if (sid) {
            // Instant paint: render last-known history immediately so the
            // screen feels instant, then revalidate in the background. The
            // boot loader is dismissed as soon as cached content is on
            // screen instead of waiting for the network round-trip.
            const cached = (Array.isArray(currentLinks) ? currentLinks : []).filter(
              (l) => l && (!l.sessionId || l.sessionId === sid)
            );
            if (cached.length) {
              currentLinks = cached;
              try { renderHistory(currentLinks); } catch (e) { console.warn('cached paint failed:', e); }
              dismissBootLoader();
            }
            // Links + domains are independent — fetch in parallel instead of
            // serially. Fire-and-forget: both paint on arrival and handle
            // their own errors, so boot (and the loader dismissal below)
            // never waits on network round-trips.
            // true = initial load, no modal
            fetchAndRenderSession(sid, false, true).catch((e) =>
              console.error('initial session sync failed:', e));
            loadUserDomains().catch((e) =>
              console.error('initial domains sync failed:', e));
          } else {
            renderEmptyState();
          }
        } catch (err) {
          console.error("Critical error during initApp:", err);
        } finally {
          // Hide the initial loading screen smoothly (no-op if the instant
          // paint above already dismissed it).
          dismissBootLoader();
          // Deep link from pricing ("Register Domain"): open the custom
          // domain dialog exactly as if the + button had been pressed —
          // including the new-session dialog when there is no session yet.
          try {
            const params = new URLSearchParams(window.location.search);
            if (params.has('add-domain')) {
              params.delete('add-domain');
              const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
              window.history.replaceState(null, '', clean);
              setTimeout(() => showDomainManager(), 600);
            }
          } catch (e) { /* never block boot */ }
        }
      }

      async function fetchAndRenderSession(sid, isManualLoad = false, isInitialLoad = false) {
        const container = document.getElementById('historyContainer');

        // If not already showing loading modal and not initial load (to avoid clashing with full screen loader)
        if (!window.loadingModalResolve && !isInitialLoad) {
          showLoadingModal({
            title: "🔄 Syncing Session",
            message: "Loading your URL history..."
          });
        }

        // Blobs edge reads lag writes by a few seconds: a session/link created
        // moments ago can 404 or list incompletely on the first attempt even
        // in the SAME browser (backend already retries too). Retry transient
        // "session not found" failures briefly before surfacing an error, so
        // a fresh session never flashes "Failed to sync session" — while
        // genuine failures still surface fast (short waits, few attempts).
        const getLinks = functions.httpsCallable('getLinksBySession');
        let res = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            res = await getLinks({ sessionId: sid });
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            console.warn(`fetchAndRenderSession attempt ${attempt + 1}/3 failed:`, (e && e.message) || e);
            // Only transient "session not found" is worth retrying — other
            // errors (permission, network down) fail fast to avoid hanging
            // the UI behind a spinner for seconds.
            if (!isSessionNotFoundError(e) || attempt === 2) break;
            await new Promise((r) => setTimeout(r, attempt === 0 ? 450 : 800));
          }
        }

        try {
          if (!res) throw lastErr || new Error('Sync failed. Please refresh.');
          // Merge, don't overwrite: keep local optimistic items the edge
          // list hasn't picked up yet (just-created links), server wins on
          // conflicts. Persist so a reload inside the lag window keeps them.
          currentLinks = mergeServerLinks(res.data.links || [], sid);
          saveLocalHistory();

          // If manual load and no links found
          if (isManualLoad && currentLinks.length === 0) {
            closeLoadingModal();
            showCustomModal({
              title: "Session EMPTY",
              message: "No links found for this Session ID. You can start creating links into it!",
            });
          }

          renderHistory(currentLinks);
        } catch (e) {
          console.error(e);
          container.innerHTML = `<div style="padding:20px; text-align:center; color:var(--danger)">Failed to sync session: ${escapeHTML(e.message)}</div>`;
        } finally {
          closeLoadingModal();
        }
      }

      // --- PLATFORM DETECTION FOR DEEP LINKS ---
      const PLATFORMS = {
        youtube: {
          name: 'YouTube',
          icon: '▶️',
          logo: '/visuals/Youtube_Logo.png',
          pattern: /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.?be)\//i,
          appScheme: 'vnd.youtube:',
          universalLink: 'https://www.youtube.com/redirect?',
          className: 'youtube'
        },
        instagram: {
          name: 'Instagram',
          icon: '📸',
          logo: '/visuals/Instagram_Logo.png',
          pattern: /^(https?:\/\/)?(www\.|m\.)?instagram\.com\//i,
          appScheme: 'instagram:',
          universalLink: 'https://www.instagram.com/_n',
          className: 'instagram'
        },
        facebook: {
          name: 'Facebook',
          icon: '📘',
          logo: '/visuals/Facebook_Logo.png',
          pattern: /^(https?:\/\/)?(www\.|m\.|web\.)?(facebook\.com|fb\.?com)\//i,
          appScheme: 'fb://',
          universalLink: 'https://www.facebook.com/',
          className: 'facebook'
        },
        twitter: {
          name: 'X (Twitter)',
          icon: '𝕏',
          logo: '/visuals/X_Logo.png',
          pattern: /^(https?:\/\/)?(www\.|mobile\.)?(twitter\.com|x\.com)\//i,
          appScheme: 'twitter://',
          universalLink: 'https://twitter.com/',
          className: 'x'
        },
        tiktok: {
          name: 'TikTok',
          icon: '🎵',
          logo: '/visuals/Tiktok_Logo.png',
          pattern: /^(https?:\/\/)?((www|m|vm|vt)\.)?tiktok\.com\//i,
          appScheme: 'tiktok://',
          universalLink: 'https://www.tiktok.com/',
          className: 'tiktok'
        },
        linkedin: {
          name: 'LinkedIn',
          icon: '💼',
          logo: '/visuals/Linkedin_Logo.png',
          pattern: /^(https?:\/\/)?(www\.)?linkedin\.com\//i,
          appScheme: 'linkedin://',
          universalLink: 'https://www.linkedin.com/',
          className: 'linkedin'
        }
      };

      function detectPlatform(url) {
        if (!url) return null;

        for (const [key, platform] of Object.entries(PLATFORMS)) {
          if (platform.pattern.test(url)) {
            return { key, ...platform };
          }
        }
        return null;
      }

      function updatePlatformDetector() {
        try {
          const urlInput = document.getElementById('urlInput');
          const detector = document.getElementById('platformDetector');

          // Guard against missing elements
          if (!urlInput || !detector) return null;

          const iconEl = document.getElementById('platformIcon');
          const textEl = document.getElementById('platformText');
          const badgeEl = document.getElementById('platformBadge');

          const urlInputValue = urlInput.value.trim();

          if (!urlInputValue) {
            detector.classList.remove('visible', 'youtube', 'instagram', 'facebook', 'x', 'tiktok', 'linkedin');
            return null;
          }

          // Basic URL validation
          try {
            new URL(urlInputValue);
          } catch (e) {
            // Not a valid URL yet, but don't hide if it looks like it could be
            if (!urlInputValue.includes('.') || urlInputValue.includes(' ')) {
              detector.classList.remove('visible', 'youtube', 'instagram', 'facebook', 'x', 'tiktok', 'linkedin');
              return null;
            }
          }

          const platform = detectPlatform(urlInputValue);

          if (platform) {
            detector.className = 'platform-detector visible ' + platform.className;
            // Brand logo when provided, otherwise the emoji fallback icon.
            // Static trusted strings only — never user input.
            if (iconEl) iconEl.innerHTML = platform.logo
              ? '<img src="' + platform.logo + '" alt="' + platform.name + ' logo" width="26" height="26" loading="lazy" decoding="async">'
              : platform.icon;
            if (textEl) textEl.textContent = `This link will open in the ${platform.name} app`;
            if (badgeEl) badgeEl.textContent = 'Deep Link';
            return platform;
          } else {
            detector.classList.remove('visible', 'youtube', 'instagram', 'facebook', 'x', 'tiktok', 'linkedin');
            return null;
          }
        } catch (err) {
          console.error('Platform detection error:', err);
          return null;
        }
      }

      // Add event listener for real-time detection
      function initPlatformDetector() {
        const urlInput = document.getElementById('urlInput');
        if (urlInput) {
          urlInput.addEventListener('input', updatePlatformDetector);
          urlInput.addEventListener('paste', function () {
            // Small delay to allow paste to complete
            setTimeout(updatePlatformDetector, 10);
          });
        }
      }

      // Run immediately if DOM is ready, otherwise wait for DOMContentLoaded
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPlatformDetector);
      } else {
        initPlatformDetector();
      }

      // --- SHORTENER LOGIC ---

      let lastLinkCreationTime = 0; // Track last link creation time
      const LINK_RATE_LIMIT_MS = 2000; // 2 seconds between link creations

      async function shortenUrl() {
        const urlInput = document.getElementById('urlInput').value.trim();
        const slugInput = document.getElementById('slugInput').value.trim();
        const resultDiv = document.getElementById('result');
        const button = document.querySelector('button.primary');

        // Frontend rate limiting check
        const now = Date.now();
        if (now - lastLinkCreationTime < LINK_RATE_LIMIT_MS) {
          const remaining = Math.ceil((LINK_RATE_LIMIT_MS - (now - lastLinkCreationTime)) / 1000);
          showCustomModal({
            title: "Please Wait",
            message: `You're creating links too fast! Please wait ${remaining} second(s) before creating another link.`
          });
          return;
        }

        // Show loading state IMMEDIATELY before any async operations
        button.disabled = true;
        button.textContent = 'Shortening...';

        if (!urlInput) {
          showCustomModal({
            title: "Input Required",
            message: "Please enter a URL!"
          });
          button.disabled = false;
          button.textContent = 'Shorten URL';
          return;
        }

        // Client-side URL check (mirrors backend validHttpUrl for fast feedback;
        // backend remains authoritative).
        if (urlInput.length > 2048) {
          showCustomModal({ title: "URL Too Long", message: "URLs are limited to 2048 characters." });
          button.disabled = false;
          button.textContent = 'Shorten URL';
          return;
        }
        try {
          const _u = new URL(urlInput);
          if ((_u.protocol !== 'http:' && _u.protocol !== 'https:') || _u.username || _u.password || !_u.hostname || /[\x00-\x1F\x7F<>\"\\^`{|}]/.test(urlInput) || /\s/.test(urlInput)) {
            throw new Error('bad');
          }
        } catch (e) {
          showCustomModal({
            title: "Invalid URL",
            message: "The URL you provided is invalid. Please make sure it starts with http:// or https://"
          });
          button.disabled = false;
          button.textContent = 'Shorten URL';
          return;
        }

        // Client-side slug check: 1–60 chars, letters/numbers/-/_ only.
        if (slugInput && !/^[A-Za-z0-9_-]{1,60}$/.test(slugInput)) {
          showCustomModal({
            title: "Invalid Slug",
            message: "Custom slugs must be 1–60 chars: letters, numbers, - _"
          });
          button.disabled = false;
          button.textContent = 'Shorten URL';
          return;
        }

        if (!requireBackend()) {
          button.disabled = false;
          button.textContent = 'Shorten URL';
          return;
        }

        try {
          resultDiv.style.display = 'none';
          document.getElementById('errorBox').style.display = 'none';

          // Get or create session ID only when needed (after validation passes).
          // First-time users get a session silently — no prompt.
          let sid = getSessionId();
          if (!sid) {
            sid = await generateSessionId();
          }


          // Call the backend API (one-shot Turnstile token if just solved).
          const shorten = functions.httpsCallable('shortenUrl');
          const tsToken = window._tsToken || undefined;
          window._tsToken = undefined;
          const response = await shorten({
            originalUrl: urlInput,
            customSlug: slugInput || null,
            sessionId: sid,
            domain: selectedDomain.replace(/\/$/, ''), // Passes domain without slash
            ...(tsToken ? { turnstileToken: tsToken } : {}),
          });

          const shortenedUrl = response.data.shortenedUrl;
          const deleteToken = response.data.deleteToken;
          const platform = response.data.platform;
          // Validate backend output: must be an http(s) URL with a usable code.
          // (Defense in depth: never assign unvalidated schemes to href.)
          const safeShort = safeHref(shortenedUrl, null);
          const shortCode = safeShort ? safeShort.split('/').filter(Boolean).pop() : null;
          if (!safeShort || !shortCode || !deleteToken) {
            throw new Error('Backend returned an invalid short URL. Please try again.');
          }

          // The backend already created the session implicitly with the
          // shorten call above; this is a redundant idempotent confirmation.
          // Fire-and-forget so shortening never waits an extra round-trip.
          try { createSessionInDb(sid); } catch (e) {}

          // Add to local state immediately (optimistic update). The domain
          // is stored explicitly so the merge key is stable even before the
          // server round-trip; the list is persisted so a reload inside the
          // Blobs edge-lag window still shows this link.
          const newItem = {
            original: urlInput,
            short: safeShort,
            code: shortCode,
            domain: hostOf(safeShort),
            deleteToken: deleteToken,
            timestamp: Date.now(),
            sessionId: sid,
            clickCount: 0,
            platform: platform
          };

          currentLinks.unshift(newItem);
          trackJustCreated(newItem);
          saveLocalHistory();

          // Add new link to expanded set so it shows expanded on mobile
          expandedLinks.add(hostOf(safeShort) + '/' + shortCode);

          // Update rate limit timestamp
          lastLinkCreationTime = Date.now();

          // Persist session ID to localStorage only after successful link creation
          setSessionId(sid);

          // Show result (safeShort already validated as http(s) above)
          document.getElementById('shortenedUrlLink').textContent = safeShort;
          document.getElementById('shortenedUrlLink').href = safeShort;
          resultDiv.style.display = 'flex';

          // Reset any existing result timer
          if (resultTimeout) clearTimeout(resultTimeout);

          // Auto-hide result after 5 seconds
          resultTimeout = setTimeout(() => {
            resultDiv.style.display = 'none';
            resultTimeout = null;
          }, 5000);

          // Clear input after success
          document.getElementById('slugInput').value = '';
          document.getElementById('urlInput').value = '';

          // Clear platform detector
          const detector = document.getElementById('platformDetector');
          detector.classList.remove('visible', 'youtube', 'instagram', 'facebook', 'x', 'tiktok', 'linkedin');

          renderHistory(currentLinks);

          // Scroll to the newly created link on mobile
          setTimeout(() => {
            const newLinkElement = document.getElementById(`mobile-link-${shortCode}`);
            if (newLinkElement) {
              const elementPosition = newLinkElement.getBoundingClientRect().top + window.scrollY;
              window.scrollTo({
                top: elementPosition - 40, // 40px offset from top
                behavior: 'smooth'
              });
            }
          }, 100);

        } catch (error) {
          console.error("Shortening error:", error);
          const errorBox = document.getElementById('errorBox');
          let message = "An unexpected error occurred.";
          const errorCode = error.message || (error.details && error.details.message) || (error.details && error.details.error);

          if (errorCode === 'TURNSTILE_REQUIRED' && !window._tsRetried) {
            window._tsRetried = true;
            button.disabled = false;
            button.textContent = 'Shorten URL';
            try {
              const token = await showTurnstileChallenge();
              if (token) {
                window._tsToken = token;
                await shortenUrl();
                window._tsRetried = false;
                return;
              }
            } finally {
              window._tsRetried = false;
            }
            document.getElementById('errorBox').textContent = '⚠️ Quick human check needed — please try again.';
            document.getElementById('errorBox').style.display = 'flex';
            return;
          }
          window._tsRetried = false;

          if (errorCode === 'ERR_INVALID_URL') {
            message = "The URL you provided is invalid. Please make sure it starts with http:// or https://";
          } else if (errorCode === 'ERR_UNSAFE_URL') {
            message = "This URL is flagged as unsafe (phishing/malware) and can't be shortened.";
          } else if (errorCode === 'ERR_SLUG_TAKEN') {
            message = "This slug is already taken on this domain. Please choose a different one (the same slug can still be used on your other domains).";
          } else if (error.code === 'invalid-argument' && error.message && error.message !== 'ERR_INVALID_URL') {
            // Surface backend validation verbatim (slug 1–60, URL too long, etc.).
            message = error.message;
          } else if (error.message && error.message.includes('429')) {
            message = "You've made too many attempts. Please wait a moment before trying again, or try disconnecting from your VPN or proxy if you're using one.";
          } else if (error.code === 'permission-denied' || errorCode === 'permission-denied' || error.message === 'permission-denied') {
            // Domain is not active - show a clear modal with instructions.
            // showCustomModal resolves true on confirm: open the manager then.
            // A lapsed-coverage domain carries its own backend message and
            // gets a renewal dialog instead of the first-time setup one.
            const lapsed = !!error.message && error.message.includes('coverage expired');
            message = lapsed ? error.message : "Domain not active. Complete verification and payment first.";
            showCustomModal({
              title: lapsed ? "Coverage Expired" : "Domain Not Active",
              message: lapsed
                ? "This domain's coverage has lapsed — its links stopped resolving. Renew with a new promo code or the $10/year fee to reactivate everything.<br><br>Choose Manage Domain to renew."
                : "The custom domain you selected is not fully verified or paid. Please complete the following steps:<br><br>1. CNAME your domain to customers.inoculens.com<br>2. Add the TXT ownership record<br>3. Complete payment (SSL provisions automatically)<br><br>Choose Manage Domain to continue verification.",
              confirmText: "Manage Domain",
              showCancel: true,
              cancelText: "Close"
            }).then((ok) => {
              if (ok) {
                const domain = selectedDomain.replace(/\/$/, '');
                showDomainManager(domain);
              }
            });
          }

          errorBox.textContent = `⚠️ ${message}`;
          errorBox.style.display = 'flex';

          // Reset any existing error timer
          if (errorTimeout) clearTimeout(errorTimeout);

          // Auto-hide error after 5 seconds (same as success)
          errorTimeout = setTimeout(() => {
            errorBox.style.display = 'none';
            errorTimeout = null;
          }, 5000);
        } finally {
          button.disabled = false;
          button.textContent = 'Shorten URL';
        }
      }


      // --- HISTORY RENDERING ---

      // --- SEARCH FUNCTIONALITY ---


      function toggleSearch() {
        const searchContainer = document.getElementById('searchContainer');
        const searchInputWrapper = document.getElementById('searchInputWrapper');
        const searchInput = document.getElementById('searchInput');
        const purgeControls = document.getElementById('purgeControls');
        const deleteAllBtn = document.getElementById('deleteAllBtn');

        isSearchActive = !isSearchActive;

        // Sync the toggle for both classes to allow coordinated CSS transitions
        if (purgeControls) {
          if (isSearchActive) {
            purgeControls.classList.add('search-active');
            searchInputWrapper.classList.add('active');
          } else {
            purgeControls.classList.remove('search-active');
            searchInputWrapper.classList.remove('active');
          }
        }

        if (isSearchActive) {
          setTimeout(() => {
            searchInput.focus();
          }, 400); // Focus after animation completes
        } else {
          clearSearch();
        }
      }

      function handleSearch(query) {
        const searchCount = document.getElementById('searchCount');
        const trimmedQuery = query.trim().toLowerCase();

        if (!trimmedQuery) {
          // Show all links
          renderHistory(currentLinks);
          searchCount.textContent = '';
          return;
        }

        // Filter links by label, short URL slug, or original URL
        const filteredLinks = currentLinks.filter(link => {
          const label = (link.label || '').toLowerCase();
          const shortUrl = (link.short || '').toLowerCase();
          const originalUrl = (link.original || '').toLowerCase();
          const shortCode = link.code ? link.code.toLowerCase() : '';

          return label.includes(trimmedQuery) ||
            shortUrl.includes(trimmedQuery) ||
            shortCode.includes(trimmedQuery) ||
            originalUrl.includes(trimmedQuery);
        });

        renderHistory(filteredLinks);

        // Update search count
        if (filteredLinks.length !== currentLinks.length) {
          searchCount.textContent = `${filteredLinks.length} of ${currentLinks.length}`;
        } else {
          searchCount.textContent = '';
        }
      }

      function clearSearch(closeSearch = false) {
        const searchInput = document.getElementById('searchInput');
        const searchCount = document.getElementById('searchCount');

        searchInput.value = '';
        searchCount.textContent = '';

        // Restore original links
        renderHistory(currentLinks);

        // If closeSearch is true, retract the search input
        if (closeSearch) {
          toggleSearch();
        }
      }


      function handleSearchKeydown(event) {
        if (event.key === 'Escape') {
          toggleSearch();
        }
      }

      // Show/hide search controls based on links count
      function updateSearchVisibility() {
        const searchContainer = document.getElementById('searchContainer');
        if (!searchContainer) return;

        if (currentLinks && currentLinks.length > 0) {
          searchContainer.classList.add('visible');
          try { updateExportVisibility(); } catch (e) {}
        } else {
          searchContainer.classList.remove('visible');
          // Reset search state without calling clearSearch() to avoid infinite recursion
          isSearchActive = false;
          const searchInputWrapper = document.getElementById('searchInputWrapper');
          if (searchInputWrapper) {
            searchInputWrapper.classList.remove('active');
          }
          // Keep the search button shape in sync: fully round when retracted.
          const purgeControls = document.getElementById('purgeControls');
          if (purgeControls) {
            purgeControls.classList.remove('search-active');
          }

          // Manually reset UI elements instead of calling clearSearch()
          const searchInput = document.getElementById('searchInput');
          const searchCount = document.getElementById('searchCount');
          if (searchInput) searchInput.value = '';
          if (searchCount) searchCount.textContent = '';
          try { updateExportVisibility(); } catch (e) {}
        }
      }

      function renderEmptyState() {
        const container = document.getElementById('historyContainer');
        const purgeControls = document.getElementById('purgeControls');
        const header = document.getElementById('historyHeader');
        const filterContainer = document.getElementById('historyDomainFilterContainer');

        if (purgeControls) purgeControls.classList.add('hidden');
        if (header) header.style.display = 'none';
        if (filterContainer) filterContainer.style.display = 'none';

        // Update search visibility - hide search when empty
        updateSearchVisibility();

        if (container) {
          const sid = getSessionId();
          if (sid) {
            container.innerHTML = `
            <div class="empty-history" style="text-align:center; padding: 60px 0;">
              <p style="color: var(--text-muted); font-size: 1.1rem; margin-bottom: 10px;">Your history is empty.</p>
              <p style="color: var(--text-muted); font-size: 0.95rem; opacity: 0.8;">Start shortening links to see them here!</p>
            </div>
          `;
          } else {
            container.innerHTML = '';
          }
        }
      }



      // Unified pair hover: each label row + its data row highlight as ONE
      // card. Delegated on #historyContainer so it survives re-renders;
      // pairing is purely sibling-based (no markup changes).
      (function initPairHover() {
        if (window.__pairHoverInit) return;
        window.__pairHoverInit = true;
        const container = document.getElementById('historyContainer');
        if (!container) return;
        function pairFor(tr) {
          if (!tr) return [];
          if (tr.classList.contains('link-item-row')) {
            const n = tr.nextElementSibling;
            return (n && n.classList.contains('link-data-row')) ? [tr, n] : [tr];
          }
          if (tr.classList.contains('link-data-row')) {
            const p = tr.previousElementSibling;
            return (p && p.classList.contains('link-item-row')) ? [p, tr] : [tr];
          }
          return [];
        }
        function clear() {
          const marked = container.querySelectorAll('tr.pair-hover');
          for (const r of marked) r.classList.remove('pair-hover');
        }
        container.addEventListener('mouseover', (e) => {
          const t = e.target && e.target.closest ? e.target.closest('tr.link-item-row, tr.link-data-row') : null;
          clear();
          for (const r of pairFor(t)) r.classList.add('pair-hover');
        });
        container.addEventListener('mouseout', (e) => {
          const t = e.target && e.target.closest ? e.target.closest('tr.link-item-row, tr.link-data-row') : null;
          if (!t) return;
          const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('tr.link-item-row, tr.link-data-row') : null;
          if (to && pairFor(t).indexOf(to) !== -1) return; // still inside the pair
          clear();
        });
      })();

      function renderHistory(links = currentLinks) {
        const container = document.getElementById('historyContainer');
        const purgeControls = document.getElementById('purgeControls');
        const header = document.getElementById('historyHeader');
        const domainFilter = selectedHistoryDomain;

        // Filter by domain locally
        if (domainFilter !== 'all') {
          links = links.filter(l => l.short.startsWith(`https://${domainFilter}`) || l.short.startsWith(`http://${domainFilter}`));
        }

        if (!links || links.length === 0) {
          // If there's an active search query AND currentLinks is not actually empty,
          // we show a "no results found" state instead of a fully empty state.
          const searchInput = document.getElementById('searchInput');
          const searchTerm = searchInput ? searchInput.value.trim() : '';

          if (searchTerm && currentLinks && currentLinks.length > 0) {
            // Keep header and search visible
            if (header) header.style.display = 'flex';
            if (purgeControls) purgeControls.classList.remove('hidden');
            updateSearchVisibility();

            container.innerHTML = `
            <div class="empty-history" style="text-align:center; padding: 60px 0;">
              <p style="color: var(--text-muted); font-size: 1.1rem; margin-bottom: 10px;">No links match your search.</p>
              <p style="color: var(--text-muted); font-size: 0.95rem; opacity: 0.8;">Try a different keyword or clear the search.</p>
            </div>
          `;
            return;
          }

          // Filtered view with no matches (but links exist and no search is
          // active): keep header/filter/purge visible and say so per-domain
          // instead of nuking the UI with the fully-empty state.
          if (!searchTerm && currentLinks && currentLinks.length > 0 && domainFilter !== 'all') {
            if (header) header.style.display = 'flex';
            if (purgeControls) purgeControls.classList.remove('hidden');
            const filterContainer = document.getElementById('historyDomainFilterContainer');
            if (filterContainer) filterContainer.style.display = 'block';
            updateSearchVisibility();
            lastRenderedLinks = [];
            container.innerHTML = `
            <div class="empty-history" style="text-align:center; padding: 60px 0;">
              <p style="color: var(--text-muted); font-size: 1.1rem; margin-bottom: 10px;">No links for ${escapeHTML(domainFilter)} yet.</p>
              <p style="color: var(--text-muted); font-size: 0.95rem; opacity: 0.8;">Shorten a link with this domain to see it here.</p>
            </div>
          `;
            return;
          }

          renderEmptyState();
          return;
        }

        const filterContainer = document.getElementById('historyDomainFilterContainer');

        // Show header when there are links
        if (header) header.style.display = 'flex';
        if (filterContainer) filterContainer.style.display = 'block';

        // Show purge controls when there are links
        if (purgeControls) purgeControls.classList.remove('hidden');

        // Update search visibility based on links count
        updateSearchVisibility();

        // Pagination calculations (over the FILTERED list, so page counts and
        // slices stay consistent with what is actually rendered)
        lastRenderedLinks = links;
        const totalItems = links.length;
        const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
        // Clamp: a narrower filter/search can leave currentPage past the end
        if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, totalItems);
        const paginatedLinks = links.slice(startIndex, endIndex);

        let html = `
        <div class="history-table-wrapper">
          <table style="border: none;">
            <thead>
              <tr>
                <th>Original Link</th>
                <th>Short Link</th>
                <th>Clicks</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
      `;

        // Mobile dropdown HTML (added outside table)
        let mobileHtml = '';

        paginatedLinks.forEach((item) => {
          // SECURITY: never interpolate user-controlled strings into inline
          // handlers raw. escapeJS() produces a safe JS string literal
          // (prevents ');...// breakout even after HTML-entity decoding),
          // escapeAttr() is for "..." attributes, safeHref() blocks
          // javascript:/data: schemes in generated links.
          const jsOriginal = escapeJS(item.original);
          const jsShort = escapeJS(item.short);
          const codeJs = escapeJS(item.code);
          // Composite DOM identity (domain/slug): duplicate slugs on other
          // domains must not share element ids. escapeAttr keeps it safe in
          // id="..." attributes; lookups use CSS.escape / getElementById.
          const jsDomain = escapeJS(itemDomain(item));
          const keyAttr = escapeAttr(itemKey(item));
          const safeShortHref = escapeAttr(safeHref(item.short));
          const itemLabel = item.label || '';
          const hasLabel = itemLabel.length > 0;
          // State badges live pinned to the right edge (label row on
          // desktop = above the Delete button; header row on mobile) so
          // they never drift with link length. row-reverse stacks extras
          // leftward from the right edge, highest priority rightmost.
          const histBadges = item.quarantined
            ? `<span class="domain-status status-pending" title="Flagged unsafe — not resolving">Quarantined</span>`
            : '';
          const histBadgesWrap = histBadges
            ? `<span style="margin-left:auto; display:inline-flex; flex-direction:row-reverse; gap:6px; align-items:center; flex-shrink:0; padding-left:8px;">${histBadges}</span>`
            : '';
          const labelDisplay = hasLabel
            ? `<span id="label-${keyAttr}" class="link-label">${escapeHTML(itemLabel)}</span>`
            : `<span id="label-${keyAttr}" class="label-placeholder">Add label...</span>`;
          const mobileLabelDisplay = hasLabel
            ? `<span id="mobile-label-${keyAttr}" class="link-label">${escapeHTML(itemLabel)}</span>`
            : `<span id="mobile-label-${keyAttr}" class="label-placeholder">Add label...</span>`;
          const editButton = `<button class="label-edit-btn" onclick="event.stopPropagation(); editLabel(${codeJs}, false, ${jsDomain})" title="Edit Label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>`;
          const mobileEditButton = `<button class="label-edit-btn" onclick="event.stopPropagation(); editLabel(${codeJs}, true, ${jsDomain})" title="Edit Label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>`;

          // Desktop table row structure (lookups are by code, never by index:
          // indexes shift under search/filter/pagination)
          html += `
            <tr id="row-${keyAttr}" class="link-item-row">
              <td data-label="Label" colspan="4">
                <div style="display:flex; align-items:center;">
                  <div class="label-cell">
                    ${editButton}
                    ${labelDisplay}
                  </div>
                  ${histBadgesWrap}
                </div>
              </td>
            </tr>
            <tr id="row-${keyAttr}-data" class="link-data-row">
              <td data-label="Original Link"><div class="history-original" title="${escapeAttr(item.original)}">${escapeHTML(item.original)}</div></td>
              <td data-label="Short Link"><a href="${safeShortHref}" class="history-short" target="_blank" rel="noopener noreferrer">${escapeHTML(item.short)}</a></td>
              <td data-label="Clicks">
                <div class="click-count-wrapper">
                  <span id="clicks-${keyAttr}" class="click-count-number" style="font-weight:700; font-size: 0.9rem;">${item.clickCount}</span>
                  <button class="btn-small btn-copy-small" onclick="viewStats(${codeJs}, ${jsDomain})">Full Stats</button>
                </div>
              </td>
              <td data-label="Actions">
                <div class="action-btns">
                  <button class="btn-small btn-copy-small" onclick="copyText(${jsShort}, this)" title="Copy Short Link">📋 Short</button>
                  <button class="btn-small btn-copy-original" onclick="copyText(${jsOriginal}, this)" title="Copy Original Link">🔗 Original</button>
                  <button class="btn-small btn-delete-small" onclick="deleteLink(${codeJs}, ${jsDomain})" title="Delete for everyone">🔥 Delete</button>
                </div>
              </td>
            </tr>
          `;

          // Mobile dropdown structure
          const isExpanded = expandedLinks.has(itemKey(item));
          mobileHtml += `
            <div id="mobile-link-${keyAttr}" class="link-item-container${isExpanded ? ' expanded' : ''}">
              <div class="link-item-header" onclick="toggleMobileLink(${codeJs}, ${jsDomain})">
                <div class="label-cell">
                  ${mobileEditButton}
                  ${mobileLabelDisplay}
                </div>
                ${histBadgesWrap}
                <div class="dropdown-arrow">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </div>
              </div>
              <div class="link-item-content">
                <div class="data-row">
                  <span class="data-label">Original Link</span>
                  <span class="data-value history-original">${escapeHTML(item.original)}</span>
                </div>
                <div class="data-row">
                  <span class="data-label">Short Link</span>
                  <span class="data-value"><a href="${safeShortHref}" class="history-short" target="_blank" rel="noopener noreferrer">${escapeHTML(item.short)}</a></span>
                </div>
                <div class="data-row">
                  <span class="data-label">Clicks</span>
                  <div class="click-count-wrapper" style="margin-top: 8px;">
                    <span id="m-clicks-${keyAttr}" class="click-count-number" style="font-weight:700; font-size: 0.9rem;">${item.clickCount}</span>
                    <button class="btn-small btn-copy-small" onclick="viewStats(${codeJs}, ${jsDomain})">Full Stats</button>
                  </div>
                </div>
                <div class="data-row">
                  <span class="data-label">Actions</span>
                  <div class="action-btns">
                    <button class="btn-small btn-copy-small" onclick="copyText(${jsShort}, this)" title="Copy Short Link">📋 Short</button>
                    <button class="btn-small btn-copy-original" onclick="copyText(${jsOriginal}, this)" title="Copy Original Link">🔗 Original</button>
                    <button class="btn-small btn-delete-small" onclick="deleteLink(${codeJs}, ${jsDomain})" title="Delete for everyone">🔥 Delete</button>
                  </div>
                </div>
              </div>
            </div>
          `;
        });

        html += '</tbody></table></div>';

        // Add mobile dropdown structure after table
        html += mobileHtml;

        // Add pagination controls if more than one page
        if (totalPages > 1) {
          html += `
          <div id="paginationControls" class="pagination-controls" style="display: flex; flex-direction: column; gap: 12px; margin-top: 1.5rem; padding: 1rem; background: rgba(255,255,255,0.02); border-radius: 0.75rem; border: 1px solid var(--border);">
            <div class="pagination-info" style="font-size: 0.85rem; color: var(--text-muted); font-weight: 500; text-align: center; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>Showing</span> <span style="color: white; font-weight: 600;">${startIndex + 1}-${endIndex}</span> <span>of</span> <span style="color: white; font-weight: 600;">${totalItems}</span> 
              <span style="margin: 0 4px; color: var(--border);">|</span> 
              <span>Page</span> <span style="color: white; font-weight: 600;">${currentPage}</span> <span>of</span> <span style="color: white; font-weight: 600;">${totalPages}</span>
            </div>
            <div class="pagination-buttons" style="display: flex; gap: 8px; justify-content: center;">
              <button class="session-item btn-session" 
                style="padding: 0 14px; background: ${currentPage === 1 ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${currentPage === 1 ? 'var(--text-muted)' : 'white'}; ${currentPage === 1 ? 'opacity: 0.4; cursor: not-allowed;' : ''}" 
                onclick="changePage(${currentPage - 1})" 
                ${currentPage === 1 ? 'disabled' : ''}>
                ← Prev
              </button>
              <button class="session-item btn-session" 
                style="padding: 0 14px; background: ${currentPage === totalPages ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${currentPage === totalPages ? 'var(--text-muted)' : 'white'}; ${currentPage === totalPages ? 'opacity: 0.4; cursor: not-allowed;' : ''}" 
                onclick="changePage(${currentPage + 1})" 
                ${currentPage === totalPages ? 'disabled' : ''}>
                Next →
              </button>
            </div>
          </div>
        `;
        }

        container.innerHTML = html;
      }

      function changePage(newPage) {
        const totalPages = Math.max(1, Math.ceil(lastRenderedLinks.length / ITEMS_PER_PAGE));
        if (newPage < 1 || newPage > totalPages) return;

        // Store the current Y position of the history container before changing pages
        const historyContainer = document.getElementById('historyContainer');
        const containerTop = historyContainer ? historyContainer.getBoundingClientRect().top + window.scrollY : 0;

        currentPage = newPage;
        renderHistory(currentLinks);

        // Scroll to show pagination controls at bottom of viewport
        setTimeout(() => {
          const paginationControls = document.getElementById('paginationControls');
          if (paginationControls) {
            const rect = paginationControls.getBoundingClientRect();
            const absoluteTop = rect.top + window.scrollY;
            const offset = window.innerHeight - rect.height - 20; // 20px padding from bottom
            window.scrollTo({ top: absoluteTop - offset, behavior: 'smooth' });
          }
        }, 100);
      }


      // --- STATS & ACTIONS ---

      async function viewStats(code, domain = '') {
        const index = findLinkIndex(code, domain);
        if (index === -1) {
          showCustomModal({ title: "Not Found", message: "That link is no longer in your history. Refresh the list and try again." });
          return;
        }
        const item = currentLinks[index];
        window.currentStatsCode = code;
        window.currentStatsDomain = itemDomain(item);
        // Click-entries list — paged 10/page like every other list, using
        // the backend limit/offset window (newest first). Always reopens on
        // the latest page.
        window._statsOffset = 0;

        const overlay = document.getElementById('statsOverlay');
        // Re-entrancy guard: refresh callers (e.g. after a delete) run while
        // the overlay is already open and its lock already held — locking
        // again would leak +1 that closeStats() never releases (dead scroll).
        const alreadyOpen = overlay.style.display === 'flex';
        overlay.style.display = 'flex';
        if (!alreadyOpen) {
          lockScroll();
          window.addEventListener('keydown', handleStatsEsc);
        }
        refreshStatsView();
      }

      const STATS_CLICKS_PER_PAGE = 10;
      function statsChangePage(newOffset) {
        const off = Math.max(0, Math.floor(Number(newOffset) || 0));
        window._statsOffset = off;
        refreshStatsView();
      }

      async function refreshStatsView() {
        // Re-resolve by (domain, code) every time: indexes shift under search/filter/
        // pagination and currentLinks can be replaced by a re-sync.
        const item = currentLinks[findLinkIndex(window.currentStatsCode, window.currentStatsDomain)];
        const list = document.getElementById('clicksList');
        const totalCount = document.getElementById('totalClicksCount');
        const statsUrl = document.getElementById('statsUrl');
        const tz = document.getElementById('timezoneSelect').value;
        const purgeBtn = document.getElementById('purgeAllClicksBtn');

        if (!item) {
          list.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">This link is no longer in your history.</div>';
          totalCount.textContent = '0';
          if (purgeBtn) purgeBtn.style.display = 'none';
          return;
        }
        if (!requireBackend()) {
          list.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">Backend unavailable.</div>';
          return;
        }

        statsUrl.textContent = item.short;
        list.innerHTML = '<div style="padding:40px; text-align:center;">Loading analytics...</div>';
        totalCount.textContent = '...';

        // Hide purge button while loading
        if (purgeBtn) purgeBtn.style.display = 'none';

        try {
          const getStats = functions.httpsCallable('getClickStats');
          let offset = Math.max(0, Math.floor(Number(window._statsOffset) || 0));
          let res = await getStats({ shortCode: item.code, domain: itemDomain(item), deleteToken: item.deleteToken, limit: STATS_CLICKS_PER_PAGE, offset });

          totalCount.textContent = res.data.clickCount;

          // Update local memory count as well (desktop + mobile badges).
          // NOTE: getElementById takes the literal DOM id, so use the raw
          // composite key here (rendering used escapeAttr, which decodes back).
          item.clickCount = res.data.clickCount;
          const domKey = itemKey(item);
          const listEl = document.getElementById('clicks-' + domKey);
          if (listEl) listEl.textContent = res.data.clickCount;
          const mobileListEl = document.getElementById('m-clicks-' + domKey);
          if (mobileListEl) mobileListEl.textContent = res.data.clickCount;

          if (res.data.clicks.length === 0) {
            // Page emptied by a delete (or offset past the end): step back
            // once and refetch instead of stranding on an empty page.
            if (offset > 0) {
              offset = Math.max(0, offset - STATS_CLICKS_PER_PAGE);
              window._statsOffset = offset;
              res = await getStats({ shortCode: item.code, domain: itemDomain(item), deleteToken: item.deleteToken, limit: STATS_CLICKS_PER_PAGE, offset });
              totalCount.textContent = res.data.clickCount;
            }
            if (res.data.clicks.length === 0) {
              list.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">No clicks recorded yet.</div>';
              if (purgeBtn) purgeBtn.style.display = 'none';
              return;
            }
          }

          if (purgeBtn) purgeBtn.style.display = 'flex'; // or 'block' depending on styling, flex is defined in css

          let html = '';
          res.data.clicks.forEach(click => {
            const dateObj = new Date(click.timestamp);
            let dateStr;

            if (tz === 'local') {
              dateStr = dateObj.toLocaleString();
            } else {
              dateStr = new Intl.DateTimeFormat('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'medium',
                timeZone: tz
              }).format(dateObj) + ` (${tz})`;
            }

            html += `
            <div class="click-entry">
              <div>
                <div class="click-time font-bold">${escapeHTML(dateStr)}</div>
                <div class="click-ip">${escapeHTML(click.ip)}</div>
              </div>
              <button class="click-delete" onclick="removeClickEntry(${escapeJS(item.code)}, ${escapeJS(click.id)}, ${escapeJS(itemDomain(item))})" title="Delete entry">🗑️</button>
            </div>
          `;
          });
          // Newest-first backend window: offset 0 is the latest page.
          const total = Number(res.data.total) || res.data.clicks.length;
          const from = total === 0 ? 0 : offset + 1;
          const to = Math.min(offset + res.data.clicks.length, total);
          const hasOlder = !!res.data.hasMore;
          const hasNewer = offset > 0;
          if (hasNewer || hasOlder || total > res.data.clicks.length) {
            html += `
            <div id="statsPagination" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; padding: 12px 2px 2px; border-top: 1px solid var(--border);">
              <div style="font-size: 0.75rem; color: var(--text-faint); font-weight: 500; letter-spacing: 0.02em;">
                ${from}–${to} of ${total} · Page ${Math.floor(offset / STATS_CLICKS_PER_PAGE) + 1} of ${Math.max(1, Math.ceil(total / STATS_CLICKS_PER_PAGE))}
              </div>
              <div style="display: flex; gap: 8px; margin-left: auto;">
                <button class="session-item btn-session"
                  style="padding: 0 14px; background: ${!hasNewer ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${!hasNewer ? 'var(--text-muted)' : 'white'}; ${!hasNewer ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                  onclick="statsChangePage(${offset - STATS_CLICKS_PER_PAGE})"
                  ${!hasNewer ? 'disabled' : ''}>
                  ← Newer
                </button>
                <button class="session-item btn-session"
                  style="padding: 0 14px; background: ${!hasOlder ? 'transparent' : 'rgba(255,255,255,0.05)'}; border: 1px solid var(--border); color: ${!hasOlder ? 'var(--text-muted)' : 'white'}; ${!hasOlder ? 'opacity: 0.4; cursor: not-allowed;' : ''}"
                  onclick="statsChangePage(${offset + STATS_CLICKS_PER_PAGE})"
                  ${!hasOlder ? 'disabled' : ''}>
                  Older →
                </button>
              </div>
            </div>`;
          }
          list.innerHTML = html;

        } catch (error) {
          list.innerHTML = `<div style="padding:40px; text-align:center; color:var(--danger);">Error: ${escapeHTML(error.message)}</div>`;
        }
      }

      function handleStatsEsc(e) {
        const modal = document.getElementById('modalOverlay');
        if (e.key === 'Escape' && (!modal || modal.style.display !== 'flex')) {
          closeStats();
        }
      }

      function closeStats() {
        document.getElementById('statsOverlay').style.display = 'none';

        unlockScroll();

        window.removeEventListener('keydown', handleStatsEsc);
        // Release the stats lock in case the user closed during an operation
        releaseOp('stats');
        releaseOp('entry');
      }

      async function clearAllClicks() {
        // Per-operation lock: purging stats must not block link deletion etc.
        if (!acquireOp('stats')) return;

        const item = currentLinks[findLinkIndex(window.currentStatsCode, window.currentStatsDomain)];
        const purgeBtn = document.getElementById('purgeAllClicksBtn');

        if (!item) {
          releaseOp('stats');
          showCustomModal({
            title: "Not Found",
            message: "That link is no longer in your history.",
            showCancel: false
          });
          return;
        }
        // Track the authoritative count in JS, not by reading label text
        const clickCount = Number(item.clickCount) || 0;

        if (clickCount === 0) {
          releaseOp('stats');
          showCustomModal({
            title: "Nothing to delete",
            message: "There are no recorded clicks for this link.",
            showCancel: false
          });
          return;
        }

        let retryOperation = false;

        try {
          const confirmed = await showCustomModal({
            title: "⚠️ PURGE ALL LOGS?",
            message: `This will permanently delete ALL recorded click data for the link<span class="modal-url-box">${escapeHTML(item.short)}</span> This action cannot be undone.`,
            showCancel: true,
            danger: true
          });

          if (confirmed) {
            // Disable the purge button during operation
            if (purgeBtn) purgeBtn.disabled = true;

            // Show loading modal
            showLoadingModal({
              title: "🗑️ Deleting Logs",
              message: "Deleting all click data...",
              danger: true
            });

            try {
              const purgeFn = functions.httpsCallable('deleteAllClicks');
              await purgeFn({ shortCode: item.code, domain: itemDomain(item), deleteToken: item.deleteToken });

              // Close loading modal first
              closeLoadingModal();

              // Show success
              await showCustomModal({
                title: "✅ Success!",
                message: "All click data has been deleted successfully.",
                showCancel: false
              });
              window._statsOffset = 0;
              refreshStatsView();
            } catch (e) {
              // Close loading modal first
              closeLoadingModal();

              // Re-enable the purge button
              if (purgeBtn) purgeBtn.disabled = false;

              // Show error with retry option
              const retryResult = await showErrorModal({
                title: "❌ Delete Failed",
                message: `Failed to delete logs: ${escapeHTML(e.message)}`,
                danger: true
              });
              if (retryResult) {
                retryOperation = true;
                clearAllClicks(); // Retry the operation
              }
            }
          }
        } finally {
          if (!retryOperation) {
            releaseOp('stats');
          }
        }
      }

      async function removeClickEntry(shortCode, clickId, domain = '') {
        // Per-operation lock (see opLocks)
        if (!acquireOp('entry')) return;

        const item = currentLinks[findLinkIndex(shortCode, domain)];
        if (!item) {
          releaseOp('entry');
          showCustomModal({ title: "Not Found", message: "That link is no longer in your history." });
          return;
        }
        let retryOperation = false;

        try {
          const confirmed = await showCustomModal({
            title: "Delete Click Record?",
            message: "Are you sure you want to delete this specific click entry from the logs?",
            showCancel: true,
            danger: true
          });

          if (confirmed) {
            // Show loading modal
            showLoadingModal({
              title: "🗑️ Deleting Entry",
              message: "Deleting click record...",
              danger: true
            });

            try {
              const deleteEntry = functions.httpsCallable('deleteClickEntry');
              await deleteEntry({ shortCode, domain: itemDomain(item), clickId, deleteToken: item.deleteToken });

              // Close loading modal first
              closeLoadingModal();

              // Show success
              await showCustomModal({
                title: "✅ Success!",
                message: "Click record has been deleted successfully.",
                showCancel: false
              });
              // Refresh in place: the stats overlay is already open (and its
              // scroll lock already held), so re-entering viewStats() here
              // would stack a second lock that closeStats() never releases.
              // Same pattern as the purge-all path below.
              refreshStatsView();
            } catch (e) {
              // Close loading modal first
              closeLoadingModal();

              // Show error with retry option
              const retryResult = await showErrorModal({
                title: "❌ Delete Failed",
                message: `Failed to delete click record: ${escapeHTML(e.message)}`,
                danger: true
              });
              if (retryResult) {
                retryOperation = true;
                removeClickEntry(shortCode, clickId, domain); // Retry the operation
              }
            }
          }
        } finally {
          if (!retryOperation) {
            releaseOp('entry');
          }
        }
      }

      // --- MOBILE DROPDOWN TOGGLE ---
      function toggleMobileLink(code, domain) {
        const key = (domain || '') + '/' + code;
        const container = document.getElementById(`mobile-link-${key}`);
        if (container) {
          container.classList.toggle('expanded');

          // Track expanded state in memory
          if (container.classList.contains('expanded')) {
            expandedLinks.add(key);
          } else {
            expandedLinks.delete(key);
          }
        }
      }

      // --- LABEL EDIT ---
      function editLabel(code, isMobile = false, domain = '') {
        try {
          const index = findLinkIndex(code, domain);
          if (index === -1) {
            showCustomModal({ title: "Not Found", message: "That link is no longer in your history." });
            return;
          }
          // Get the appropriate label span ID based on whether it's mobile or desktop
          // (getElementById takes the literal id; selectors below use CSS.escape)
          // Composite identity: the same slug may exist on other domains.
          const linkDomain = domain || itemDomain(currentLinks[index]);
          const key = linkDomain + '/' + code;
          const labelId = isMobile ? `mobile-label-${key}` : `label-${key}`;
          const labelSpan = document.getElementById(labelId);
          if (!labelSpan) {
            console.error('Label span not found:', labelId);
            return;
          }
          const currentLabel = currentLinks[index]?.label || '';
          const rowSel = '#row-' + CSS.escape(key);
          const mobileSel = '#mobile-link-' + CSS.escape(key);

          // Replace pen icon with checkmark button in desktop table
          const editBtn = document.querySelector(`${rowSel} .label-edit-btn`);
          if (editBtn) {
            editBtn.classList.add('save-mode');
            editBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 6L9 17l-5-5" />
              </svg>`;
            editBtn.title = 'Save label';
            editBtn.onclick = async function () {
              const input = document.querySelector(`${rowSel} .label-input`);
              if (input) {
                await saveLabel(code, input.value, linkDomain);
              }
            };
          }

          // Also update mobile dropdown edit button if exists
          const mobileEditBtn = document.querySelector(`${mobileSel} .label-edit-btn`);
          if (mobileEditBtn) {
            mobileEditBtn.classList.add('save-mode');
            mobileEditBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 6L9 17l-5-5" />
              </svg>`;
            mobileEditBtn.title = 'Save label';
            // Stop propagation to prevent mobile dropdown toggle when clicking save
            mobileEditBtn.onclick = async function (e) {
              e.stopPropagation();
              const input = document.querySelector(`${mobileSel} .label-input`);
              if (input) {
                await saveLabel(code, input.value, linkDomain);
              }
            };
          }

          // Create input element — use a cancellation flag to prevent blur from saving after Escape
          let isCancelled = false;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'label-input';
          input.value = currentLabel;
          input.maxLength = 60;
          input.placeholder = 'Add label...';

          // Handle paste event to show warning if exceeding 20 characters
          input.addEventListener('paste', function (e) {
            const pastedText = (e.clipboardData || window.clipboardData).getData('text');
            const currentLength = input.value.length;
            const remainingSpace = 60 - currentLength;

            if (pastedText.length > remainingSpace && remainingSpace > 0) {
              e.preventDefault();
              showCustomModal({
                title: "Label Limit",
                message: "Labels are limited to 60 characters.",
                showCancel: false
              });
            } else if (pastedText.length > 60) {
              e.preventDefault();
              showCustomModal({
                title: "Label Limit",
                message: "Labels are limited to 60 characters.",
                showCancel: false
              });
            }
          });

          // Handle enter key and blur to save
          input.addEventListener('keydown', async function (e) {
            if (e.key === 'Enter') {
              await saveLabel(code, input.value, linkDomain);
            } else if (e.key === 'Escape') {
              isCancelled = true;
              renderHistory(currentLinks); // Cancel and re-render
            }
          });

          input.addEventListener('blur', async function () {
            if (!isCancelled) await saveLabel(code, input.value, linkDomain);
          });

          // Replace the label span with input
          labelSpan.parentNode.replaceChild(input, labelSpan);
          input.focus();
          input.select();
        } catch (e) {
          console.error('Error in editLabel:', e);
        }
      }

      async function saveLabel(code, newLabel, domain = '') {
        const trimmedLabel = String(newLabel).trim();
        const index = findLinkIndex(code, domain);
        const item = index === -1 ? null : currentLinks[index];

        if (!item) {
          renderHistory(currentLinks);
          return;
        }

        // Don't update if unchanged
        if ((trimmedLabel || '') === (item.label || '')) {
          renderHistory(currentLinks);
          return;
        }
        if (!requireBackend()) {
          renderHistory(currentLinks);
          return;
        }

        // Show loading state - replace the label cell content with spinner (Desktop)
        // Composite DOM ids (domain/slug) so duplicate slugs never collide.
        const domKey = itemDomain(item) + '/' + code;
        const rowSel = '#row-' + CSS.escape(domKey);
        const mobileSel = '#mobile-link-' + CSS.escape(domKey);
        const labelCell = document.querySelector(`${rowSel} .label-cell`);
        const editBtn = document.querySelector(`${rowSel} .label-edit-btn`);

        // Show loading state for mobile dropdown
        const mobileLabelCell = document.querySelector(`${mobileSel} .label-cell`);
        const mobileEditBtn = document.querySelector(`${mobileSel} .label-edit-btn`);

        // Disable the edit buttons
        if (editBtn) {
          editBtn.classList.add('saving');
          editBtn.disabled = true;
        }
        if (mobileEditBtn) {
          mobileEditBtn.classList.add('saving');
          mobileEditBtn.disabled = true;
        }

        if (labelCell) {
          labelCell.innerHTML = `
          <div class="label-loading">
            <div class="label-spinner"></div>
            <span>Saving...</span>
          </div>
          `;
        }

        // Mobile loading state
        if (mobileLabelCell) {
          mobileLabelCell.innerHTML = `
          <div class="label-loading">
            <div class="label-spinner"></div>
            <span>Saving...</span>
          </div>
          `;
        }

        // Ensure mobile dropdown stays expanded during save
        const mobileContainer = document.getElementById(`mobile-link-${domKey}`);
        if (mobileContainer && !mobileContainer.classList.contains('expanded')) {
          mobileContainer.classList.add('expanded');
          expandedLinks.add(domKey);
        }

        try {
          const updateLabelFn = functions.httpsCallable('updateLinkLabel');
          await updateLabelFn({
            shortCode: code,
            domain: itemDomain(item),
            deleteToken: item.deleteToken,
            label: trimmedLabel
          });

          // Update local state
          item.label = trimmedLabel;

          // Save to localStorage for offline resilience (best effort)
          saveLocalHistory();

          renderHistory(currentLinks);
        } catch (e) {
          console.error('Error saving label:', e);
          showCustomModal({ title: "Error", message: "Failed to save label. Please try again." });
          renderHistory(currentLinks);
        }
      }

      // --- GLOBAL DELETE --- (No more local purge)
      async function deleteLink(code, domain = '') {
        // Per-operation lock (see opLocks)
        if (!acquireOp('link')) return;

        const index = findLinkIndex(code, domain);
        const item = index === -1 ? null : currentLinks[index];
        if (!item) {
          releaseOp('link');
          showCustomModal({ title: "Not Found", message: "That link is no longer in your history." });
          return;
        }

        const confirmed = await showCustomModal({
          title: "Delete link?",
          message: `Delete this link for everyone on the internet?<span class="modal-url-box">${escapeHTML(item.short)}</span>Anyone on the internet will then be able to reclaim the URL slug you used.`,
          showCancel: true,
          danger: true
        });

        if (confirmed) {
          showLoadingModal({
            title: "🗑️ Deleting Link",
            message: "Deleting link...",
            danger: true
          });

          try {
            const deleteFn = functions.httpsCallable('deleteUrl');
            await deleteFn({
              shortCode: item.code,
              domain: itemDomain(item),
              deleteToken: item.deleteToken
            });

            closeLoadingModal();

            // Remove from local list (re-resolve: list may have shifted)
            const freshIndex = findLinkIndex(code, domain);
            if (freshIndex !== -1) currentLinks.splice(freshIndex, 1);
            expandedLinks.delete(itemKey(item));
            untrackJustCreated(item);
            saveLocalHistory();
            renderHistory(currentLinks);
          } catch (e) {
            closeLoadingModal();
            showCustomModal({ title: "Error", message: `Error deleting link: ${escapeHTML(e.message)}` });
          } finally {
            releaseOp('link');
          }
          return; // lock already released in finally
        }

        releaseOp('link');
      }

      // --- EXPORT CUSTOM-DOMAIN LINKS (.txt backup) ---
      // Custom domains are portable (the user owns the DNS), the system
      // host is not — so only custom-domain links are exported. One line
      // per pair:  custom.domain.com/userSlug : originalHost/originalPath
      // (schemes stripped on both sides).
      function customExportLinks() {
        const sys = (publicConfig && publicConfig.systemHost ? String(publicConfig.systemHost) : 's.inoculens.com').toLowerCase();
        return (Array.isArray(currentLinks) ? currentLinks : []).filter((l) => {
          if (!l || !l.code) return false;
          const d = String(itemDomain(l) || '').toLowerCase();
          return d && d !== sys;
        });
      }

      function updateExportVisibility() {
        const btn = document.getElementById('exportBtn');
        if (!btn) return;
        // Never disable: a disabled button swallows the click, so a new user
        // with no custom-domain links gets silence instead of an explanation.
        // Keep it pressable and let exportCustomLinks show the
        // "Nothing to export" dialog; dim slightly as a visual cue.
        const empty = customExportLinks().length === 0;
        btn.disabled = false;
        btn.classList.toggle('is-empty', empty);
        btn.title = empty
          ? "No custom-domain links yet — press to learn more"
          : "Export custom-domain links as .txt";
      }

      async function exportCustomLinks() {
        const items = customExportLinks();
        if (items.length === 0) {
          showCustomModal({
            title: "Nothing to export",
            message: "Only <strong>custom-domain</strong> links can be exported (your domain moves with you — <strong>s.inoculens.com</strong> links do not). Shorten a link on a custom domain first.",
            showCancel: false
          });
          return;
        }
        const stripScheme = (u) => String(u || '').trim().replace(/^https?:\/\//i, '').replace(/[\r\n]+/g, '');
        const lines = items.map((l) => {
          const domain = stripScheme(itemDomain(l));
          const code = String(l.code || '').replace(/[\r\n]+/g, '');
          return `${domain}/${code} : ${stripScheme(l.original)}`;
        });
        const text = lines.join('\n') + '\n';
        try {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const day = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = `tunnel-custom-links-${day}.txt`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 500);
          showCustomModal({
            title: "Exported",
            message: `Exported <strong>${items.length}</strong> custom-domain link${items.length === 1 ? '' : 's'} to a .txt file (one <strong>domain/slug : original</strong> pair per line). Re-create each pair on your next provider.`,
            showCancel: false
          });
        } catch (e) {
          console.error('Export failed:', e);
          showCustomModal({ title: "Export failed", message: "Could not generate the file. Please try again." });
        }
      }

      // --- DELETE ALL LINKS ---
      async function deleteAllLinks() {
        // Per-operation lock (see opLocks)
        if (!acquireOp('links')) return;

        if (!currentLinks || currentLinks.length === 0) {
          releaseOp('links');
          showCustomModal({
            title: "No Links to Delete",
            message: "There are no links to delete in your session.",
            showCancel: false
          });
          return;
        }

        const linkCount = currentLinks.length;

        try {
          const confirmed = await showCustomModal({
            title: "⚠️ DELETE ALL LINKS?",
            message: `Are you sure you want to delete ALL <strong>${linkCount}</strong> links?<br><br>This will permanently remove these links for everyone on the internet. This action cannot be undone.`,
            showCancel: true,
            danger: true
          });

          if (confirmed) {
            // Show progress modal
            const progressModal = document.createElement('div');
            progressModal.id = 'progressModal';
            progressModal.style.cssText = 'position:fixed;inset:0;width:100%;height:100vh;height:100dvh;background:rgba(0,0,0,0.85);z-index:30000;display:flex;align-items:center;justify-content:center;overscroll-behavior:contain;';
            progressModal.innerHTML = `
          <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:1rem;padding:32px;text-align:center;max-width:400px;">
            <div style="font-size:1.5rem;font-weight:700;margin-bottom:16px;">Deleting Links...</div>
            <div id="deleteProgressText" style="color:var(--text-muted);margin-bottom:16px;">0 of ${linkCount} deleted</div>
            <div style="background:var(--border);border-radius:999px;height:8px;overflow:hidden;">
              <div id="deleteProgressBar" style="background:var(--danger);height:100%;width:0%;transition:width 0.3s;"></div>
            </div>
          </div>
          `;
            document.body.appendChild(progressModal);
            lockScroll();

            let successCount = 0;
            let failedCount = 0;
            const remainingLinks = [];

            try {
              // Delete each link
              for (let i = 0; i < currentLinks.length; i++) {
                const item = currentLinks[i];
                try {
                  const deleteFn = functions.httpsCallable('deleteUrl');
                  await deleteFn({
                    shortCode: item.code,
                    domain: itemDomain(item),
                    deleteToken: item.deleteToken
                  });
                  successCount++;
                } catch (e) {
                  console.error(`Failed to delete ${item.code}:`, e);
                  failedCount++;
                  remainingLinks.push(item);
                }

                // Update progress
                const progressText = document.getElementById('deleteProgressText');
                const progressBar = document.getElementById('deleteProgressBar');
                if (progressText) progressText.textContent = `${i + 1} of ${linkCount} processed`;
                if (progressBar) progressBar.style.width = `${((i + 1) / linkCount) * 100}%`;
              }
            } finally {
              // Remove progress modal
              if (progressModal && progressModal.parentNode) {
                document.body.removeChild(progressModal);
              }
              unlockScroll();
            }

            // Keep only the failed links so the user can retry
            try {
              const remaining = new Set(remainingLinks);
              for (const l of currentLinks) {
                if (l && !remaining.has(l)) untrackJustCreated(l);
              }
            } catch (e) {}
            currentLinks = remainingLinks;
            saveLocalHistory();
            renderHistory(currentLinks);

            // Show result
            if (failedCount === 0) {
              showCustomModal({
                title: "Success!",
                message: `Successfully deleted all <strong>${successCount}</strong> links.`,
                showCancel: false
              });
            } else {
              showCustomModal({
                title: "Partially Complete",
                message: `Deleted <strong>${successCount}</strong> links. <br>Failed to delete <strong>${failedCount}</strong> links. The failed links remain in your history so you can retry.`,
                showCancel: false
              });
            }
          }
        } catch (e) {
          console.error("Critical error in deleteAllLinks:", e);
          showCustomModal({ title: "Error", message: "A critical error occurred while deleting links." });
        } finally {
          releaseOp('links');
        }
      }

      // --- MERGE SESSION ---
      async function openMergeModal() {
        const currentSid = getSessionId();

        const result = await showCustomModal({
          title: "Merge Sessions",
          message: "Enter the Session ID you want to merge <strong>INTO</strong> this one. <br>The links and custom domains from that session will be moved here, and that session will become empty.",
          showCancel: true,
          showInput: true,
          inputPlaceholder: "Enter other Session ID...",
          inputType: 'password'
        });

        if (result && typeof result === 'string') {
          const otherSid = result.trim();
          if (!otherSid) return;

          if (!requireBackend()) return;

          // Hidden admin path: sessions are strict alphanumeric-no-1 (10),
          // admins are exactly 10 chars always containing "1" (specials
          // "@#$" allowed, never valid as session). Disjoint namespaces, no
          // collisions. Session-format input tries session first, then admin
          // (covers session-alphabet admins containing 1). Anything else can
          // only be an admin attempt.
          async function tryAdminUnlock(key) {
            if (!validAdminKeyFrontend(key)) return false;
            // The entry popup is already gone here and verification takes a
            // backend round-trip — show progress so the action reads as
            // registered instead of dead.
            showLoadingModal({ title: 'Verifying admin key…', message: 'Checking, please wait' });
            try {
              const adminFn = functions.httpsCallable('adminListDiscountCodes');
              await adminFn({ adminKey: key });
            } catch (adminErr) {
              closeLoadingModal();
              return false;
            }
            closeLoadingModal();
            try { sessionStorage.setItem('tunnel_admin_key', key); } catch (e) {}
            updateSessionUI();
            showCustomModal({ title: "Admin Unlocked", message: "Admin unlocked. Use the <strong>Admin</strong> button next to your session controls." });
            return true;
          }

          // Validate session format (exactly 10 chars, strict alphabet).
          // Anything else can only be an admin-key attempt, never a session.
          const sessionRegex = /^[A-Za-z023456789]{10}$/;
          if (!sessionRegex.test(otherSid) || otherSid.length !== SESSION_ID_LENGTH || otherSid.includes('1')) {
            if (await tryAdminUnlock(otherSid)) return;
            showCustomModal({
              title: "Invalid Format",
              message: "Session IDs must be exactly 10 characters, letters and numbers only (no 1, no specials)."
            });
            return;
          }

          if (otherSid === currentSid) {
            showCustomModal({ title: "Error", message: "Cannot merge a session into itself." });
            return;
          }

          try {
            showLoadingModal({ title: 'Merging sessions…', message: 'Moving links and domains, please wait' });
            const checkFn = functions.httpsCallable('checkSessionExists');
            const exists = await checkFn({ sessionId: otherSid });
            if (!exists.data || !exists.data.exists) {
              // Hand over to the admin path (it shows its own progress).
              closeLoadingModal();
              if (await tryAdminUnlock(otherSid)) return;
              showCustomModal({ title: "Not Found", message: "Unknown Session ID." });
              return;
            }
          } catch (e) {
            console.error('Session lookup failed:', e);
            closeLoadingModal();
            showCustomModal({ title: "Error", message: escapeHTML(e.message || 'Lookup failed') });
            return;
          }

          try {
            const mergeFn = functions.httpsCallable('mergeSessions');
            const res = await mergeFn({ oldSessionId: otherSid, newSessionId: currentSid });

            if (res.data.success) {
              const mergedCount = Number(res.data.count) || 0;
              const movedDomains = Number(res.data.domains) || 0;
              const prevCount = currentLinks.length;
              await fetchAndRenderSession(currentSid);
              // Storage reads lag writes: re-sync until the merged links
              // show up (bounded retries so a slow backend can't hang the UI).
              if (mergedCount > 0) {
                const target = prevCount + mergedCount;
                for (let i = 0; i < 3 && currentLinks.length < target; i++) {
                  await new Promise((r) => setTimeout(r, 1200));
                  await fetchAndRenderSession(currentSid);
                }
              }
              await loadUserDomains();
              // Show everything post-merge so moved links and domains are
              // visible immediately without a refresh.
              currentPage = 1;
              selectHistoryFilter('all', 'All domains');
              const domainBit = movedDomains > 0 ? ` and ${movedDomains} custom domain${movedDomains === 1 ? '' : 's'}` : '';
              closeLoadingModal();
              showCustomModal({ title: "Success", message: `Merged ${mergedCount} link${mergedCount === 1 ? '' : 's'}${domainBit} into this session.` });
            } else {
              // Defensive: backend always answers success:true or throws —
              // never strand the spinner if that contract ever breaks.
              closeLoadingModal();
              showCustomModal({ title: "Merge Error", message: "Unexpected response, please try again." });
            }
          } catch (e) {
            closeLoadingModal();
            showCustomModal({ title: "Merge Error", message: escapeHTML(e.message || 'Merge failed') });
          }
        }
      }

      // --- START FRESH ---
      async function startFresh() {
        const confirmed = await showCustomModal({
          title: "Start Fresh?",
          message: "This will reset your browser's memory for this app. You will be logged out of the current session (including promo admin, if unlocked). <br><br>The session and links will <strong>NOT</strong> be deleted from the server, so you can recover them later if you have the Session ID.",
          showCancel: true,
          danger: true
        });

        if (confirmed) {
          localStorage.removeItem('tunnel_session_id');
          localStorage.removeItem('tunnel_history');
          // A fresh start logs out of everything: drop the promo admin key
          // too (reload alone preserves sessionStorage, so without this the
          // Admin button would stay unlocked after Start Fresh).
          try { sessionStorage.removeItem('tunnel_admin_key'); } catch (e) {}
          window.location.reload();
        }
      }

      // --- UTILS ---
      // Clipboard with fallback: navigator.clipboard is undefined on
      // non-secure contexts (plain http:// LAN, file://) and older browsers.
      function writeClipboardText(text) {
        const value = String(text === null || text === undefined ? '' : text);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(value);
        }
        return new Promise((resolve, reject) => {
          try {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (ok) resolve();
            else reject(new Error('execCommand copy failed'));
          } catch (e) {
            reject(e);
          }
        });
      }
      function flashCopied(btnElement, fallbackMessage) {
        if (btnElement) {
          if (!btnElement.dataset.originalText) {
            btnElement.dataset.originalText = btnElement.textContent;
          }
          btnElement.textContent = 'Copied!';
          setTimeout(() => {
            btnElement.textContent = btnElement.dataset.originalText || 'Copy';
          }, 2000);
        } else if (fallbackMessage) {
          showCustomModal({ title: "Success", message: fallbackMessage });
        }
      }
      function copyText(text, btnElement) {
        // Prevent spam - if already showing "Copied!", don't process again
        if (btnElement && btnElement.textContent === 'Copied!') {
          return;
        }

        writeClipboardText(text).then(() => {
          flashCopied(btnElement, "Copied to clipboard!");
        }).catch((err) => {
          console.error('Copy failed:', err);
          showToast('Copy failed — long-press / right-click to copy manually.', 'error');
        });
      }

      function copyResult() {
        const linkElement = document.getElementById('shortenedUrlLink');
        const url = linkElement.href;
        const btn = document.querySelector('#result .copy-btn');

        // copyText carries the same spam guard, feedback, and error toast.
        if (url) copyText(url, btn);
      }

      // Modal System Logic (Enhanced with Input)
      // Shared modal primitives: every dialog below uses the same overlay
      // elements, nested-modal scroll check, and Esc-handler lifecycle.
      function modalEls() {
        return {
          overlay: document.getElementById('modalOverlay'),
          titleEl: document.getElementById('modalTitle'),
          messageEl: document.getElementById('modalMessage'),
          cancelBtn: document.getElementById('modalCancelBtn'),
          okBtn: document.getElementById('modalOkBtn'),
          inputEl: document.getElementById('modalInput'),
        };
      }
      let scrollLockCount = 0;
      function lockScroll() {
        scrollLockCount++;
        document.body.classList.add('modal-open');
      }
      function unlockScroll() {
        scrollLockCount = Math.max(0, scrollLockCount - 1);
        if (!scrollLockCount) document.body.classList.remove('modal-open');
      }
      function modalClearEsc() {
        if (window.modalEscHandler) {
          window.removeEventListener('keydown', window.modalEscHandler);
          window.modalEscHandler = null;
        }
      }
      // Peek toggle for password-masked secret inputs (session IDs, admin
      // keys). Reveals blind-typed secrets on demand; always resets to
      // masked on open and on submit/cancel.
      function toggleModalInputPeek() {
        const inputEl = document.getElementById('modalInput');
        const peekBtn = document.getElementById('modalInputPeek');
        if (!inputEl || !peekBtn || inputEl.dataset.secretInput !== '1') return;
        if (inputEl.type === 'password') {
          inputEl.type = 'text';
          peekBtn.textContent = 'Hide';
        } else {
          inputEl.type = 'password';
          peekBtn.textContent = 'Show';
        }
      }
      function showCustomModal({ title, message, showCancel = false, danger = false, showInput = false, inputPlaceholder = '', inputType = 'text', confirmText = '', cancelText = '' }) {
        return new Promise((resolve) => {
          const { overlay, titleEl, messageEl, cancelBtn, okBtn, inputEl } = modalEls();
          const peekWrap = document.getElementById('modalInputPeek');
          const peekBox = peekWrap ? peekWrap.parentElement : null;

          // Lock Nested Scroll Logic
          lockScroll();

          // Use textContent for title (plain text from callers — safe).
          // NOTE: message intentionally uses innerHTML to support formatted content (<strong>, <span> etc).
          // All caller-provided user data MUST be passed through escapeHTML() before interpolation.
          titleEl.textContent = title;
          messageEl.innerHTML = message;

          if (showInput) {
            inputEl.style.display = 'block';
            inputEl.value = '';
            inputEl.placeholder = inputPlaceholder;
            // Secret inputs (session IDs, admin keys) mask as password and
            // get the peek toggle; everything else stays a plain text field.
            const isSecret = inputType === 'password';
            inputEl.type = isSecret ? 'password' : 'text';
            inputEl.dataset.secretInput = isSecret ? '1' : '';
            if (peekBox) peekBox.style.display = isSecret ? 'block' : 'none';
            if (peekWrap) peekWrap.textContent = 'Show';
            setTimeout(() => inputEl.focus(), 100);
          } else {
            inputEl.style.display = 'none';
            inputEl.dataset.secretInput = '';
            if (peekBox) peekBox.style.display = 'none';
          }

          cancelBtn.style.display = showCancel ? 'block' : 'none';
          cancelBtn.textContent = cancelText || 'Cancel';
          cancelBtn.className = 'modal-btn modal-btn-cancel';

          // Always show OK button
          okBtn.style.display = 'block';
          okBtn.className = 'modal-btn ' + (danger ? 'modal-btn-danger' : 'modal-btn-ok');
          okBtn.textContent = confirmText || (danger && showCancel ? 'Delete' : 'OK');


          overlay.style.display = 'flex';

          const handleAction = (result) => {
            overlay.style.display = 'none';
            unlockScroll();
            modalClearEsc();
            resolve(result);
          };

          const okHandler = () => {
            if (showInput) {
              handleAction(inputEl.value);
            } else {
              handleAction(true);
            }
          };
          const cancelHandler = () => handleAction(false);
          const escHandler = (e) => {
            if (e.key === 'Escape') handleAction(!showCancel);
            if (e.key === 'Enter' && showInput) okHandler();
          };

          modalClearEsc();
          window.modalEscHandler = escHandler;
          window.addEventListener('keydown', escHandler);

          okBtn.onclick = okHandler;
          cancelBtn.onclick = cancelHandler;
        });
      }

      // Show loading modal with spinner - returns a promise that resolves when operation is done
      // The caller is responsible for closing this modal manually after their operation
      function showLoadingModal({ title, message, danger = false }) {
        return new Promise((resolve) => {
          const { overlay, titleEl, messageEl, cancelBtn, okBtn, inputEl } = modalEls();

          // Lock scroll
          lockScroll();

          titleEl.textContent = title;
          messageEl.innerHTML = `<div class="modal-spinner ${danger ? 'danger' : ''}"></div><div class="modal-loading-text">${escapeHTML(message)}</div>`;

          inputEl.style.display = 'none';
          inputEl.dataset.secretInput = '';
          { const pb = document.getElementById('modalInputPeek'); if (pb && pb.parentElement) pb.parentElement.style.display = 'none'; }
          cancelBtn.style.display = 'none';

          okBtn.className = 'modal-btn';
          okBtn.style.display = 'none'; // Hide OK button during loading

          overlay.style.display = 'flex';

          modalClearEsc();

          okBtn.onclick = null;
          cancelBtn.onclick = null;

          // This modal stays open - caller must resolve it
          window.loadingModalResolve = resolve;
        });
      }

      // Show error modal with Try Again and OK buttons
      function showErrorModal({ title, message, danger = false }) {
        return new Promise((resolve) => {
          const { overlay, titleEl, messageEl, cancelBtn, okBtn, inputEl } = modalEls();

          // Lock scroll
          lockScroll();

          titleEl.textContent = title;
          messageEl.innerHTML = message;

          inputEl.style.display = 'none';
          inputEl.dataset.secretInput = '';
          { const pb = document.getElementById('modalInputPeek'); if (pb && pb.parentElement) pb.parentElement.style.display = 'none'; }

          // Show both Try Again and OK buttons
          cancelBtn.style.display = 'block';
          cancelBtn.textContent = 'Try Again';
          cancelBtn.className = 'modal-btn modal-btn-danger';

          okBtn.style.display = 'block';
          okBtn.textContent = 'OK';
          okBtn.className = 'modal-btn modal-btn-cancel';

          overlay.style.display = 'flex';

          const handleAction = (result) => {
            overlay.style.display = 'none';
            unlockScroll();
            modalClearEsc();
            resolve(result);
          };

          const okHandler = () => handleAction(false); // OK = don't retry
          const cancelHandler = () => handleAction(true); // Try Again = retry
          const escHandler = (e) => {
            if (e.key === 'Escape') handleAction(false);
          };

          modalClearEsc();
          window.modalEscHandler = escHandler;
          window.addEventListener('keydown', escHandler);

          okBtn.onclick = okHandler;
          cancelBtn.onclick = cancelHandler;
        });
      }

      // Helper to close loading modal programmatically
      function closeLoadingModal() {
        const overlay = document.getElementById('modalOverlay');
        if (window.loadingModalResolve) {
          if (overlay) overlay.style.display = 'none';
          const resolve = window.loadingModalResolve;
          window.loadingModalResolve = null;
          unlockScroll();
          resolve(true);
        }
      }
