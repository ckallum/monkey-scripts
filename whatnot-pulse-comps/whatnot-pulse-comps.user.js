// ==UserScript==
// @name         Whatnot Pulse comps
// @namespace    https://ckallum.com/userscripts
// @version      1.1.0
// @description  Scan the card on a Whatnot stream with PulseTCG's scanner and show its NM/LP/MP/HP and PSA 10 comp prices. Needs you signed in to pulsetcg.io in the same browser.
// @author       Callum Ke
// @homepageURL  https://github.com/ckallum/monkey-scripts
// @supportURL   https://github.com/ckallum/monkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/ckallum/monkey-scripts/main/whatnot-pulse-comps/whatnot-pulse-comps.user.js
// @downloadURL  https://raw.githubusercontent.com/ckallum/monkey-scripts/main/whatnot-pulse-comps/whatnot-pulse-comps.user.js
// @match        https://www.whatnot.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      pulsetcg.io
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[whatnot-pulse-comps]';
  const PULSE = 'https://pulsetcg.io';
  // Built from char codes so the source stays ASCII; a mis-encoded paste can't mangle them.
  const POUND = String.fromCharCode(0xa3);
  const DOT = String.fromCharCode(0xb7);
  const CONDITIONS = ['nm', 'lp', 'mp', 'hp'];
  const MAX_MATCHES = 5; // the scanner returns every card in view, background ones included
  const PANEL_WIDTH = 260;
  const FONT = 'system-ui, -apple-system, sans-serif';

  // ---------- Pure helpers (exported for tests) ----------

  /**
   * Per-condition prices from one product's /api/internal/market-data entries.
   * - Returns { nm, lp, mp, hp }, each { value: number|null, lowData: boolean, lastSold: 'YYYY-MM-DD'|null }.
   * - NM falls back to the plain market price when Pulse has no condition breakdown.
   */
  function parseConditionPrices(entries) {
    const market = (entries || []).find((e) => e && e.type === 'market_price') || {};
    const pricing = market.conditionPricing || {};
    const out = {};
    for (const c of CONDITIONS) {
      const p = pricing[c];
      out[c] = {
        value: toPrice(p && p.value),
        lowData: Boolean(p && p.low_availability),
        lastSold: p && p.last_sold_date ? String(p.last_sold_date).slice(0, 10) : null,
      };
    }
    if (out.nm.value === null) out.nm.value = toPrice(market.value);
    return out;
  }

  /** A graded product's price from its market-data entries: { value, lowData, lastSold }, as for one condition. */
  function parseGradedPrice(entries) {
    const market = (entries || []).find((e) => e && e.type === 'market_price') || {};
    return {
      value: toPrice(market.value),
      lowData: Boolean(market.low_availability),
      lastSold: market.last_sold_date ? String(market.last_sold_date).slice(0, 10) : null,
    };
  }

  /**
   * A product id with its grading fields (5th and 6th) replaced.
   * - withGrade(id, null, null) gives the raw card, withGrade(id, 'PSA', '10') its PSA 10 slab.
   * - Ids with fewer than six fields are returned unchanged.
   */
  function withGrade(productId, grader, grade) {
    const parts = String(productId || '').split('|');
    if (parts.length < 6) return productId;
    parts[4] = grader || 'null';
    parts[5] = grade || 'null';
    return parts.join('|');
  }

  /** A positive price from a number or numeric string; null for null, blanks and zero (Pulse's "no data"). */
  function toPrice(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** The variant field of a Pulse product id ("Holo" in "card:m5_jp|118/081|Holo|null|null|null"), or null. */
  function variantOf(productId) {
    const variant = String(productId || '').split('|')[2];
    return variant && variant !== 'null' ? variant : null;
  }

  /** "Set . number . language . variant" for a scan match, skipping missing parts. */
  function describeMatch(match) {
    return [match.set_name, match.card_number, match.language, variantOf(match.product_id)].filter(Boolean).join(` ${DOT} `);
  }

  /** Pulse search text ("name number") that ranks the matched product first. */
  function searchQueryFor(match) {
    return `${match.card_name || ''} ${match.card_number || ''}`.trim();
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { parseConditionPrices, parseGradedPrice, withGrade, variantOf, describeMatch, searchQueryFor };
    return;
  }

  // ---------- Pulse API (your signed-in session, via GM_xmlhttpRequest) ----------

  class PulseError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  function request(method, path, { headers = {}, data, timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: PULSE + path,
        headers,
        data,
        timeout,
        onload: (res) => {
          let body = null;
          try {
            body = JSON.parse(res.responseText);
          } catch (err) {
            body = null;
          }
          if (res.status >= 200 && res.status < 300) resolve(body);
          else reject(new PulseError((body && (body.error || body.message || body.code)) || `HTTP ${res.status}`, res.status));
        },
        onerror: () => reject(new PulseError('Network error reaching Pulse', 0)),
        ontimeout: () => reject(new PulseError('Pulse took too long to respond', 0)),
      });
    });
  }

  let csrfToken = null;

  async function getCsrf(refresh) {
    if (!csrfToken || refresh) csrfToken = (await request('GET', '/api/csrf-token')).csrfToken;
    return csrfToken;
  }

  /** POST with Pulse's CSRF token, refetching it once if Pulse rejects a stale one. */
  async function post(path, data, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await getCsrf(attempt > 0);
      try {
        return await request('POST', path, { data, headers: { ...headers, 'X-CSRF-Token': token } });
      } catch (err) {
        if (err.status !== 403 || attempt > 0) throw err;
      }
    }
  }

  /** Scan one frame with Pulse's card scanner; resolves to its matches, best first. */
  async function scanFrame(blob) {
    const form = new FormData();
    form.append('files', blob, 'frame.jpg');
    const body = await post('/api/scan?mode=single', form);
    const result = body && body.results && body.results[0];
    if (!result || !result.success) throw new PulseError((result && (result.error || result.errorMessage)) || 'Scan failed', 0);
    return (result.matches || []).slice(0, MAX_MATCHES);
  }

  /**
   * Raw condition prices plus the PSA 10 price for each match, in one request.
   * - Returns { [match product id]: { nm, lp, mp, hp, psa10 } }.
   * - Priced from the raw card even when the scanner matched a slab.
   */
  async function fetchPrices(ids) {
    const lookups = ids.map((id) => ({ id, raw: withGrade(id, null, null), psa10: withGrade(id, 'PSA', '10') }));
    const productIds = [...new Set(lookups.flatMap((l) => [l.raw, l.psa10]))];
    const body = (await post('/api/internal/market-data', JSON.stringify({ productIds, metrics: ['market_price', 'last_sold_price'] }), {
      'Content-Type': 'application/json',
    })) || {};
    return Object.fromEntries(lookups.map((l) => [l.id, { ...parseConditionPrices(body[l.raw]), psa10: parseGradedPrice(body[l.psa10]) }]));
  }

  /** The match's card-page slug, found by searching Pulse for "name number"; null if not found. */
  async function fetchSlug(match) {
    const body = await request('GET', `/api/v2/search/all?q=${encodeURIComponent(searchQueryFor(match))}&limit=10`);
    const raw = withGrade(match.product_id, null, null);
    const hit = ((body && body.items) || []).find((item) => item.productId === match.product_id || item.productId === raw);
    return hit ? hit.slug : null;
  }

  // ---------- Stream frame ----------

  function liveVideo() {
    const video = document.querySelector('[data-testid="live-player"] video');
    return video && video.videoWidth ? video : null;
  }

  /** The stream's current frame as a full-resolution JPEG. Whatnot streams over WebRTC, so the canvas isn't tainted. */
  function grabFrame() {
    const video = liveVideo();
    if (!video) return Promise.reject(new Error('No stream video is playing'));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the frame'))), 'image/jpeg', 0.9);
    });
  }

  // ---------- Panel ----------

  const ui = { root: null, body: null, button: null, status: null, result: null, placed: false };
  let state = null; // { matches, prices, slugs, selected }
  let busy = false;

  const gbp = (n) => `${POUND}${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildPanel() {
    const root = el('div', {
      position: 'fixed',
      zIndex: '2147483000',
      width: `${PANEL_WIDTH}px`,
      display: 'none',
      background: '#151515',
      color: '#fff',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.18)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
      font: `12px/1.35 ${FONT}`,
      overflow: 'hidden',
    });

    const header = el('div', {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '3px 8px',
      background: '#34D399',
      color: '#052e1c',
      fontWeight: '600',
      cursor: 'move',
      userSelect: 'none',
      touchAction: 'none',
    });
    const title = el('span', null, 'Pulse comps');
    const toggle = el('button', { background: 'none', border: 'none', color: 'inherit', font: `700 14px/1 ${FONT}`, cursor: 'pointer', padding: '0 2px' });
    toggle.type = 'button';
    header.append(title, toggle);

    const body = el('div', { padding: '7px 8px 8px' });
    const button = el('button', {
      width: '100%',
      padding: '5px 8px',
      border: 'none',
      borderRadius: '6px',
      background: '#34D399',
      color: '#052e1c',
      font: `600 13px/1.3 ${FONT}`,
      cursor: 'pointer',
    }, 'Scan card  (Alt+P)');
    button.type = 'button';
    const status = el('div', { fontSize: '11px', opacity: '0.75', marginTop: '5px', minHeight: '14px' });
    const result = el('div');
    body.append(button, status, result);
    root.append(header, body);
    document.body.appendChild(root);
    Object.assign(ui, { root, body, button, status, result });

    button.addEventListener('click', runScan);

    const setCollapsed = (collapsed) => {
      body.style.display = collapsed ? 'none' : 'block';
      toggle.textContent = collapsed ? '+' : '-';
      toggle.title = collapsed ? 'Expand' : 'Collapse';
    };
    setCollapsed(GM_getValue('collapsed', false));
    toggle.addEventListener('click', () => {
      const collapsed = body.style.display !== 'none';
      GM_setValue('collapsed', collapsed);
      setCollapsed(collapsed);
    });

    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const start = root.getBoundingClientRect();
      const dx = e.clientX - start.left;
      const dy = e.clientY - start.top;
      header.setPointerCapture(e.pointerId);
      const onMove = (ev) => movePanel(ev.clientX - dx, ev.clientY - dy);
      const onUp = () => {
        header.removeEventListener('pointermove', onMove);
        header.removeEventListener('pointerup', onUp);
        header.removeEventListener('pointercancel', onUp);
        GM_setValue('panelPos', { left: root.offsetLeft, top: root.offsetTop });
      };
      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    });
    window.addEventListener('resize', () => movePanel(root.offsetLeft, root.offsetTop));
  }

  /** Move the panel, keeping it fully on screen. */
  function movePanel(left, top) {
    const root = ui.root;
    const maxLeft = window.innerWidth - root.offsetWidth - 4;
    const maxTop = window.innerHeight - root.offsetHeight - 4;
    root.style.left = `${Math.max(4, Math.min(left, maxLeft))}px`;
    root.style.top = `${Math.max(4, Math.min(top, maxTop))}px`;
  }

  /** Saved position, else the stream's top-left below the seller header. */
  function placePanel() {
    const saved = GM_getValue('panelPos', null);
    const player = document.querySelector('[data-testid="live-player"]');
    const rect = player && player.getBoundingClientRect();
    if (saved) movePanel(saved.left, saved.top);
    else if (rect && rect.width) movePanel(rect.left + 12, rect.top + 80);
    else movePanel(16, 120);
    ui.placed = true;
  }

  function setStatus(text, isError) {
    ui.status.textContent = text;
    ui.status.style.color = isError ? '#FCA5A5' : '';
    ui.status.style.opacity = isError ? '1' : '0.75';
  }

  function render() {
    const box = ui.result;
    box.replaceChildren();
    if (!state) return;
    const match = state.matches[state.selected];
    const prices = state.prices[match.product_id];

    box.append(
      el('div', { font: `600 14px/1.3 ${FONT}`, marginTop: '6px' }, match.card_name),
      el('div', { fontSize: '11px', opacity: '0.75' }, describeMatch(match)),
    );

    const grid = el('div', { display: 'grid', gridTemplateColumns: 'auto 1fr auto', columnGap: '8px', rowGap: '1px', margin: '6px 0 2px', alignItems: 'baseline' });
    let anyLowData = false;
    const addRow = (label, p) => {
      anyLowData = anyLowData || p.lowData;
      grid.append(
        el('span', { fontSize: '11px', opacity: '0.7' }, label),
        el('span', { font: `600 13px/1.35 ${FONT}` }, p.value === null ? '-' : `${gbp(p.value)}${p.lowData ? ' *' : ''}`),
        el('span', { fontSize: '11px', opacity: '0.55' }, p.lastSold ? `sold ${p.lastSold}` : ''),
      );
    };
    for (const c of CONDITIONS) addRow(c.toUpperCase(), prices[c]);
    grid.append(el('div', { gridColumn: '1 / -1', borderTop: '1px solid rgba(255,255,255,0.15)', margin: '3px 0 2px' }));
    addRow('PSA 10', prices.psa10);
    box.append(grid);
    if (anyLowData) box.append(el('div', { fontSize: '11px', opacity: '0.6' }, '* few recent sales'));

    const slug = state.slugs[match.product_id];
    if (slug) {
      const link = el('a', { display: 'inline-block', marginTop: '4px', color: '#6EE7B7', fontSize: '12px' }, 'Open on Pulse');
      link.href = `${PULSE}/cards/${encodeURIComponent(slug)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      box.append(link);
    }

    if (state.matches.length > 1) {
      box.append(el('div', { fontSize: '11px', opacity: '0.6', margin: '7px 0 2px' }, 'Also in frame'));
      state.matches.forEach((other, i) => {
        if (i === state.selected) return;
        const nm = state.prices[other.product_id].nm.value;
        const row = el('button', {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '6px',
          color: '#fff',
          padding: '3px 6px',
          margin: '2px 0',
          font: `12px/1.3 ${FONT}`,
          cursor: 'pointer',
        }, `${other.card_name} ${DOT} ${other.card_number || '?'}${nm === null ? '' : ` ${DOT} NM ${gbp(nm)}`}`);
        row.type = 'button';
        row.title = describeMatch(other);
        row.addEventListener('click', () => {
          state.selected = i;
          render();
        });
        box.append(row);
      });
    }
  }

  function messageFor(err) {
    if (err.status === 401) return 'Sign in to pulsetcg.io in this browser, then try again.';
    if (err.status === 403) return 'Pulse refused the request (403). Open pulsetcg.io once, then retry.';
    return err.message || 'Scan failed';
  }

  async function runScan() {
    if (busy || !ui.root) return;
    busy = true;
    ui.button.disabled = true;
    ui.button.style.opacity = '0.6';
    setStatus('Scanning...');
    try {
      const frame = await grabFrame();
      const matches = await scanFrame(frame);
      if (!matches.length) {
        state = null;
        render();
        setStatus('No card recognised. Wait for a clear view of one card and try again.', true);
        return;
      }
      setStatus('Fetching prices...');
      const prices = await fetchPrices(matches.map((m) => m.product_id));
      state = { matches, prices, slugs: {}, selected: 0 };
      render();
      setStatus(`Scanned at ${new Date().toLocaleTimeString('en-GB')}`);
      const current = state;
      for (const m of matches) {
        fetchSlug(m)
          .then((slug) => {
            if (slug && state === current) {
              current.slugs[m.product_id] = slug;
              render();
            }
          })
          .catch(() => {});
      }
    } catch (err) {
      console.warn(LOG, err);
      setStatus(messageFor(err), true);
    } finally {
      busy = false;
      ui.button.disabled = false;
      ui.button.style.opacity = '1';
    }
  }

  // ---------- Start ----------

  const isTyping = (target) => Boolean(target && target.closest && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));

  // Alt+P (Option+P on Mac). e.code ignores the character Option produces.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyP' || !e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
    if (!ui.root || ui.root.style.display === 'none') return;
    e.preventDefault();
    runScan();
  }, true);

  // Whatnot is a single-page app, so check for a live player as pages change.
  setInterval(() => {
    const onLive = Boolean(document.querySelector('[data-testid="live-player"]'));
    if (onLive && !ui.root) buildPanel();
    if (!ui.root) return;
    const show = onLive ? 'block' : 'none';
    if (ui.root.style.display !== show) {
      ui.root.style.display = show;
      if (onLive && !ui.placed) placePanel();
    }
  }, 1000);

  console.info(LOG, 'running');
})();
