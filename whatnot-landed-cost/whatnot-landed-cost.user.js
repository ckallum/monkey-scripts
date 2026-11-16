// ==UserScript==
// @name         Whatnot UK landed cost (JPY sellers)
// @namespace    https://ckallum.com/userscripts
// @version      1.3.0
// @description  Shows the post-fees UK price (item + VAT + customs duty + customs fee) next to every JPY price on Whatnot, plus a quick yen calculator. Duty and VAT rates refresh daily from the UK Trade Tariff API.
// @author       Callum Ke
// @homepageURL  https://github.com/ckallum/monkey-scripts
// @supportURL   https://github.com/ckallum/monkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/ckallum/monkey-scripts/main/whatnot-landed-cost/whatnot-landed-cost.user.js
// @downloadURL  https://raw.githubusercontent.com/ckallum/monkey-scripts/main/whatnot-landed-cost/whatnot-landed-cost.user.js
// @match        https://www.whatnot.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      www.trade-tariff.service.gov.uk
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[whatnot-landed-cost]';
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Currency signs as escapes so the file stays ASCII and survives copy/paste in any text encoding.
  const YEN = '\u00A5';
  const POUND = '\u00A3';
  const TARIFF_URL = (code) => `https://www.trade-tariff.service.gov.uk/uk/api/commodities/${code}`;

  // Measure types and area in the UK Trade Tariff:
  // - 103 = third-country (MFN) duty, 305 = VAT, area 1011 = "all third countries".
  // - The UK-Japan CEPA 0% preference (type 142) is ignored: Whatnot charged MFN duty on the reference receipt.
  const MFN_DUTY_MEASURE = '103';
  const VAT_MEASURE = '305';
  const ERGA_OMNES = '1011';

  const DEFAULT_SETTINGS = {
    commodityCode: '9504400000', // "Playing cards", the code Whatnot's 2% duty matches for TCG singles
    customsFeePct: 10, // % of (duty + VAT); fitted from a JPY 59,900 receipt (fee 1,342 on 13,419)
    minCustomsFeeJpy: 0,
    lowValueThresholdGbp: 135, // UK consignment threshold: at or below it, VAT only, no duty or clearance fee
    applyLowValueRule: true,
    shippingJpy: 0, // fallback when the stream shows no shipping chip
  };

  const FALLBACK_RATES = { dutyPct: 2, vatPct: 20, source: 'built-in defaults', fetchedAt: 0 };

  // ---------- Pure helpers (exported for tests) ----------

  /**
   * Parse a JPY amount from Whatnot price text.
   * - Accepts the yen sign, the "JP" prefix used by the en-GB locale, and the full-width yen sign.
   * - Returns null unless the whole string is a price, so containers with extra text don't match.
   */
  function parseYen(text) {
    if (!text) return null;
    const m = String(text).trim().match(/^(?:JP)?[\u00A5\uFFE5]\s?([\d,]+)$/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  /** Parse an "est. <pound>16.11" or "(est. <pound>1,350.42)" estimate into pounds, else null. */
  function parseEstGbp(text) {
    if (!text) return null;
    const m = String(text).trim().match(/^\(?est\.\s*\u00A3\s*([\d,]+(?:\.\d{1,2})?)\)?$/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  /**
   * Parse what the user types into the calculator.
   * - Ignores spaces, commas, a yen sign and a "JP" prefix.
   * - "k" means thousands, so "12k" and "1.5k" are 12,000 and 1,500.
   * - Returns whole yen, or null for empty, zero or unparseable input.
   */
  function parseJpyInput(text) {
    const t = String(text || '').toLowerCase().replace(/[\s,\u00A5\uFFE5]/g, '').replace(/^jp/, '');
    const m = t.match(/^(\d+(?:\.\d+)?)(k?)$/);
    if (!m) return null;
    const n = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
    return n > 0 ? n : null;
  }

  /**
   * Parse the stream's shipping chip into yen.
   * - "<flag> JP<yen>3,380 (est. <pound>15.99) Shipping" gives 3380; "FREE Shipping" gives 0.
   * - Returns null for anything else, e.g. "Ships FedEx IP".
   */
  function parseShippingChip(text) {
    const t = String(text || '').trim();
    if (/^free shipping$/i.test(t)) return 0;
    const m = t.match(/(?:JP)?[\u00A5\uFFE5]\s?([\d,]+)\s*\(est\.[^)]*\)\s*Shipping$/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  /**
   * Extract MFN duty % and VAT % from a Trade Tariff commodity response.
   * Returns { dutyPct, vatPct }; a field is null when the tariff has no ad-valorem rate for it.
   */
  function parseTariff(json) {
    const included = (json && json.included) || [];
    const byKey = new Map(included.map((x) => [`${x.type}:${x.id}`, x]));
    const pctOf = (measure) => {
      const ref = measure.relationships.duty_expression && measure.relationships.duty_expression.data;
      const base = ref && byKey.get(`${ref.type}:${ref.id}`);
      const m = base && String(base.attributes.base || '').match(/^([\d.]+)\s*%$/);
      return m ? Number(m[1]) : null;
    };
    let dutyPct = null;
    let vatPct = null;
    for (const x of included) {
      if (x.type !== 'measure' || !x.relationships) continue;
      const type = x.relationships.measure_type && x.relationships.measure_type.data.id;
      const areaRef = x.relationships.geographical_area && x.relationships.geographical_area.data;
      const area = areaRef && areaRef.id;
      if (type === MFN_DUTY_MEASURE && area === ERGA_OMNES) dutyPct = pctOf(x);
      if (type === VAT_MEASURE && vatPct === null) vatPct = pctOf(x);
    }
    return { dutyPct, vatPct };
  }

  /**
   * Estimate what Whatnot charges a UK buyer for a JPY item.
   * - Amounts are whole yen, rounded per line like Whatnot's receipt.
   * - Duty and VAT apply to item + shipping (shipping is part of the UK customs value).
   * - The low-value threshold compares the goods alone; UK rules exclude shipping from it.
   * - The customs fee is a % of (duty + VAT).
   * @param {number} priceJpy  item price in yen
   * @param {number} gbpPerJpy pounds per yen, used for the low-value threshold and the GBP total
   * @param {{dutyPct:number, vatPct:number}} rates
   * @param {typeof DEFAULT_SETTINGS} settings
   * @param {number} [shippingJpy] shipping in yen; defaults to the settings fallback
   * @returns {{price:number, shipping:number, duty:number, vat:number, fee:number, total:number, totalGbp:number, lowValue:boolean}}
   */
  function computeLanded(priceJpy, gbpPerJpy, rates, settings, shippingJpy = settings.shippingJpy || 0) {
    const shipping = shippingJpy;
    const lowValue = Boolean(settings.applyLowValueRule) && priceJpy * gbpPerJpy <= settings.lowValueThresholdGbp;
    const duty = lowValue ? 0 : Math.round((priceJpy + shipping) * rates.dutyPct / 100);
    const vat = Math.round((priceJpy + shipping + duty) * rates.vatPct / 100);
    const fee = lowValue ? 0 : Math.max(settings.minCustomsFeeJpy || 0, Math.round((duty + vat) * settings.customsFeePct / 100));
    const total = priceJpy + shipping + duty + vat + fee;
    return { price: priceJpy, shipping, duty, vat, fee, total, totalGbp: total * gbpPerJpy, lowValue };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { parseYen, parseEstGbp, parseJpyInput, parseShippingChip, parseTariff, computeLanded, DEFAULT_SETTINGS };
    return;
  }

  // ---------- Settings and daily rate cache ----------

  const settings = Object.assign({}, DEFAULT_SETTINGS, GM_getValue('settings', {}));
  let rates = GM_getValue('rates', null) || FALLBACK_RATES;

  function saveSettings() {
    GM_setValue('settings', settings);
  }

  function ratesAreStale() {
    return !rates.fetchedAt || Date.now() - rates.fetchedAt > DAY_MS || rates.commodityCode !== settings.commodityCode;
  }

  function fetchRates() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: TARIFF_URL(settings.commodityCode),
        headers: { Accept: 'application/json' },
        timeout: 20000,
        onload: (res) => {
          if (res.status !== 200) return reject(new Error(`Trade Tariff HTTP ${res.status}`));
          try {
            const { dutyPct, vatPct } = parseTariff(JSON.parse(res.responseText));
            if (dutyPct === null || vatPct === null) return reject(new Error('Trade Tariff response had no ad-valorem duty/VAT'));
            resolve({ dutyPct, vatPct, commodityCode: settings.commodityCode, source: 'UK Trade Tariff', fetchedAt: Date.now() });
          } catch (err) {
            reject(err);
          }
        },
        onerror: () => reject(new Error('Trade Tariff request failed')),
        ontimeout: () => reject(new Error('Trade Tariff request timed out')),
      });
    });
  }

  async function refreshRates(force) {
    if (!force && !ratesAreStale()) return;
    try {
      rates = await fetchRates();
      GM_setValue('rates', rates);
      console.info(LOG, `rates updated: duty ${rates.dutyPct}% VAT ${rates.vatPct}% (${settings.commodityCode})`);
      scheduleScan(true);
    } catch (err) {
      console.warn(LOG, `${err.message}; keeping ${rates.source} (duty ${rates.dutyPct}%, VAT ${rates.vatPct}%)`);
    }
  }

  // ---------- Shipping and weekly bundling ----------

  // Whatnot's Weekly Bundling ships later wins from the same seller free, so a seller marked bundled stays free this long.
  const BUNDLE_MS = 7 * DAY_MS;
  let shippingSeen = null; // { seller, jpy } from the last shipping chip, kept while the stream is between items

  /** The live seller's username, from the "<seller> is live" page title; null off live pages. */
  function currentSeller() {
    const m = document.title.match(/^(\S+) is live\b/);
    return m ? m[1] : null;
  }

  function isBundled(seller) {
    const until = GM_getValue('bundled', {})[seller];
    return Boolean(until && until > Date.now());
  }

  function setBundled(seller, bundled) {
    const all = GM_getValue('bundled', {});
    for (const [name, until] of Object.entries(all)) if (until <= Date.now()) delete all[name];
    if (bundled) all[seller] = Date.now() + BUNDLE_MS;
    else delete all[seller];
    GM_setValue('bundled', all);
  }

  function updateListingShipping() {
    const seller = currentSeller();
    const snap = document.evaluate("//body//text()[contains(., 'Shipping')]/parent::*[not(self::script or self::style)]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < snap.snapshotLength; i++) {
      const el = snap.snapshotItem(i);
      if (el.closest('[data-wnl]')) continue;
      const jpy = parseShippingChip(el.textContent);
      if (jpy !== null) {
        shippingSeen = { seller, jpy };
        return;
      }
    }
  }

  /** The seller's listed shipping: the stream's chip for this seller, else the menu fallback. */
  function listedShipping() {
    const seller = currentSeller();
    return shippingSeen && shippingSeen.seller === seller ? shippingSeen.jpy : settings.shippingJpy || 0;
  }

  /** Shipping on your next win: free once bundled with this seller, else the listed amount. */
  function shippingForNextBuy() {
    const seller = currentSeller();
    return seller && isBundled(seller) ? 0 : listedShipping();
  }

  // ---------- Rendering ----------

  const yen = (n) => `${YEN}${Math.round(n).toLocaleString('en-GB')}`;
  const gbp = (n) => `${POUND}${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pair = (jpy, pounds) => `${yen(jpy)} \u00B7 ${gbp(pounds)}`;

  function tooltip(r, gbpPerJpy) {
    const checked = rates.fetchedAt ? new Date(rates.fetchedAt).toLocaleDateString('en-GB') : 'never (offline defaults)';
    const lines = [`Post fees estimate for ${yen(r.price)}`, `Item: ${yen(r.price)}`];
    if (r.shipping) lines.push(`Shipping: ${yen(r.shipping)}`);
    else if (listedShipping() > 0) lines.push('Shipping: free (bundled)');
    if (r.lowValue) {
      lines.push(`VAT ${rates.vatPct}%: ${yen(r.vat)}`, `Under ${POUND}${settings.lowValueThresholdGbp}: VAT only, no duty or customs fee`);
    } else {
      lines.push(
        `Duty ${rates.dutyPct}%: ${yen(r.duty)}`,
        `VAT ${rates.vatPct}%: ${yen(r.vat)}`,
        `Customs fee (${settings.customsFeePct}% of duty+VAT): ${yen(r.fee)}`,
      );
    }
    lines.push(
      `Total: ${yen(r.total)} \u2248 ${gbp(r.totalGbp)}`,
      '',
      `Rates: ${rates.source}, commodity ${settings.commodityCode}, checked ${checked}`,
      `GBP uses Whatnot's own estimate: 1 JPY = ${POUND}${gbpPerJpy.toFixed(6)}`,
    );
    return lines.join('\n');
  }

  function createBadge() {
    const wrap = document.createElement('div');
    wrap.dataset.wnl = '1';
    // CSSOM styles rather than a <style> tag, so a strict style-src CSP can't strip them.
    Object.assign(wrap.style, { display: 'block', marginTop: '2px', lineHeight: '1.2' });
    const pill = document.createElement('span');
    Object.assign(pill.style, {
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: '999px',
      background: '#FBBF24',
      color: '#1C1917',
      font: '600 11px/1.35 system-ui, -apple-system, sans-serif',
      whiteSpace: 'normal',
      cursor: 'help',
    });
    wrap.appendChild(pill);
    return wrap;
  }

  /** The nearest preceding element whose own text (or title) is exactly a JPY price, up to 3 levels up. */
  function findYenNear(estEl) {
    let node = estEl;
    for (let depth = 0; depth < 3 && node; depth++) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const direct = parseYen(sib.getAttribute('title')) ?? parseYen(sib.textContent);
        if (direct !== null) return direct;
        const leaves = sib.querySelectorAll('*');
        for (let i = leaves.length - 1; i >= 0; i--) {
          const v = parseYen(leaves[i].getAttribute('title')) ?? parseYen(leaves[i].textContent);
          if (v !== null) return v;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  /** Where the badge goes: below the est. line, or below the whole row when the row is horizontal flex. */
  function badgeAnchor(estEl) {
    const parent = estEl.parentElement;
    const cs = parent && getComputedStyle(parent);
    const horizontal = cs && cs.display.includes('flex') && cs.flexDirection.startsWith('row');
    return horizontal ? parent : estEl;
  }

  const badgeFor = new WeakMap(); // est element -> badge wrapper
  const live = new Map(); // badge wrapper -> est element, for pruning orphans
  let lastLoggedCount = -1;

  /**
   * Elements whose full text is an "est." pound estimate.
   * - Matches on the parent of the "est." text node, so React splitting "est. " and the amount into separate nodes still works.
   */
  function findEstElements() {
    const snap = document.evaluate("//body//text()[contains(., 'est.')]/parent::*[not(self::script or self::style)]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const els = [];
    for (let i = 0; i < snap.snapshotLength; i++) {
      const el = snap.snapshotItem(i);
      if (!el.closest('[data-wnl]') && parseEstGbp(el.textContent) !== null) els.push(el);
    }
    return els;
  }

  function scan() {
    updateListingShipping();
    for (const [wrap, est] of live) {
      if (!est.isConnected || !wrap.isConnected) {
        wrap.remove();
        live.delete(wrap);
      }
    }

    const pairs = [];
    for (const est of findEstElements()) {
      const priceJpy = findYenNear(est);
      const estGbp = parseEstGbp(est.textContent);
      if (priceJpy && estGbp) pairs.push({ est, priceJpy, estGbp });
    }
    if (pairs.length !== lastLoggedCount) {
      lastLoggedCount = pairs.length;
      console.info(LOG, `${pairs.length} JPY price(s) badged`);
    }
    if (!pairs.length) {
      syncCalculator(null);
      return;
    }

    // Whatnot rounds est. amounts to pennies; the largest price on the page gives the most precise FX rate.
    const best = pairs.reduce((a, b) => (b.priceJpy > a.priceJpy ? b : a));
    const gbpPerJpy = best.estGbp / best.priceJpy;
    syncCalculator(gbpPerJpy);
    const shipping = shippingForNextBuy();

    for (const { est, priceJpy } of pairs) {
      const r = computeLanded(priceJpy, gbpPerJpy, rates, settings, shipping);
      const text = `Post fees ${pair(r.total, r.totalGbp)}`;
      const anchor = badgeAnchor(est);

      let wrap = badgeFor.get(est);
      if (!wrap || !wrap.isConnected) {
        wrap = createBadge();
        badgeFor.set(est, wrap);
        live.set(wrap, est);
      }
      if (wrap.previousElementSibling !== anchor) {
        const estCs = getComputedStyle(est);
        wrap.style.textAlign = anchor === est ? estCs.textAlign : 'left';
        wrap.style.alignSelf = anchor === est ? estCs.alignSelf : 'auto';
        anchor.after(wrap);
      }
      const pill = wrap.firstChild;
      if (pill.textContent !== text) pill.textContent = text;
      const tip = tooltip(r, gbpPerJpy);
      if (pill.title !== tip) pill.title = tip;
    }
  }

  let scanTimer = null;
  function scheduleScan(now) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try {
        scan();
      } catch (err) {
        console.warn(LOG, 'scan failed', err);
      }
    }, now ? 0 : 250);
  }

  const ownMutation = (m) => {
    const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
    return el && el.closest && el.closest('[data-wnl]');
  };
  new MutationObserver((mutations) => {
    if (mutations.every(ownMutation)) return;
    scheduleScan(false);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---------- Calculator ----------

  /**
   * Floating box where you type a yen amount and see the pre-fee and post-fee totals as you type.
   * - Shown while the page has JPY prices; uses the same rates and Whatnot FX as the badges.
   * - Attached to <body>, not Whatnot's overlay, so it survives item changes and React re-renders.
   * - Drag by the header; position and collapsed state persist across pages.
   */
  const CALC_WIDTH = 230;
  const calc = { root: null, body: null, input: null, shipRow: null, shipBox: null, shipText: null, pre: null, post: null, detail: null, gbpPerJpy: null, placed: false };

  function buildCalculator() {
    const root = document.createElement('div');
    root.dataset.wnl = '1';
    Object.assign(root.style, {
      position: 'fixed',
      zIndex: '2147483000',
      width: `${CALC_WIDTH}px`,
      display: 'none',
      background: 'rgba(17,17,17,0.9)',
      color: '#fff',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.18)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
      font: '12px/1.35 system-ui, -apple-system, sans-serif',
      overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '3px 8px',
      background: '#FBBF24',
      color: '#1C1917',
      fontWeight: '600',
      cursor: 'move',
      userSelect: 'none',
      touchAction: 'none',
    });
    const title = document.createElement('span');
    title.textContent = `${YEN} Post fees calculator`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    Object.assign(toggle.style, { background: 'none', border: 'none', color: 'inherit', font: '700 14px/1 system-ui, sans-serif', cursor: 'pointer', padding: '0 2px' });
    header.append(title, toggle);

    const body = document.createElement('div');
    Object.assign(body.style, { padding: '6px 8px 7px' });
    const input = document.createElement('input');
    Object.assign(input, { type: 'text', inputMode: 'decimal', placeholder: 'yen, e.g. 12000 or 12k', autocomplete: 'off', spellcheck: false });
    Object.assign(input.style, {
      width: '100%',
      boxSizing: 'border-box',
      margin: '0 0 5px',
      padding: '4px 6px',
      border: '1px solid rgba(255,255,255,0.25)',
      borderRadius: '6px',
      background: 'rgba(255,255,255,0.08)',
      color: '#fff',
      font: '600 14px/1.3 system-ui, -apple-system, sans-serif',
      outline: 'none',
    });
    const shipRow = document.createElement('label');
    Object.assign(shipRow.style, { display: 'none', alignItems: 'center', gap: '5px', margin: '0 0 4px', fontSize: '11px', cursor: 'pointer', userSelect: 'none' });
    const shipBox = document.createElement('input');
    shipBox.type = 'checkbox';
    // Explicit appearance, in case the site's form CSS restyles checkboxes.
    Object.assign(shipBox.style, { appearance: 'auto', webkitAppearance: 'checkbox', width: '13px', height: '13px', margin: '0', accentColor: '#FBBF24', cursor: 'pointer' });
    const shipText = document.createElement('span');
    shipRow.append(shipBox, shipText);
    shipBox.addEventListener('change', () => {
      const seller = currentSeller();
      if (seller) setBundled(seller, !shipBox.checked);
      scheduleScan(true);
    });
    const row = (label, valueFont) => {
      const el = document.createElement('div');
      Object.assign(el.style, { display: 'flex', alignItems: 'baseline', gap: '6px' });
      const name = document.createElement('span');
      name.textContent = label;
      Object.assign(name.style, { flex: '0 0 58px', fontSize: '11px', opacity: '0.75' });
      const value = document.createElement('span');
      Object.assign(value.style, { font: valueFont });
      el.append(name, value);
      return { el, value };
    };
    const pre = row('Pre fees', '500 13px/1.3 system-ui, -apple-system, sans-serif');
    const post = row('Post fees', '700 14px/1.3 system-ui, -apple-system, sans-serif');
    post.value.style.cursor = 'help';
    const detail = document.createElement('div');
    Object.assign(detail.style, { fontSize: '11px', opacity: '0.75', marginTop: '1px' });
    body.append(input, shipRow, pre.el, post.el, detail);
    root.append(header, body);
    document.body.appendChild(root);
    Object.assign(calc, { root, body, input, shipRow, shipBox, shipText, pre: pre.value, post: post.value, detail });

    // Whatnot listens for keys at page level; keep typing inside the box.
    for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
    input.addEventListener('input', renderCalculator);

    const setCollapsed = (collapsed) => {
      body.style.display = collapsed ? 'none' : 'block';
      toggle.textContent = collapsed ? '+' : '\u2013';
      toggle.title = collapsed ? 'Expand' : 'Collapse';
    };
    setCollapsed(GM_getValue('calcCollapsed', false));
    toggle.addEventListener('click', () => {
      const collapsed = body.style.display !== 'none';
      GM_setValue('calcCollapsed', collapsed);
      setCollapsed(collapsed);
      if (!collapsed) input.focus();
    });

    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const start = root.getBoundingClientRect();
      const dx = e.clientX - start.left;
      const dy = e.clientY - start.top;
      header.setPointerCapture(e.pointerId);
      const onMove = (ev) => moveCalculator(ev.clientX - dx, ev.clientY - dy);
      const onUp = () => {
        header.removeEventListener('pointermove', onMove);
        header.removeEventListener('pointerup', onUp);
        header.removeEventListener('pointercancel', onUp);
        GM_setValue('calcPos', { left: root.offsetLeft, top: root.offsetTop });
      };
      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    });
    window.addEventListener('resize', () => moveCalculator(root.offsetLeft, root.offsetTop));
  }

  /** Move the box, keeping it fully on screen. */
  function moveCalculator(left, top) {
    const root = calc.root;
    const maxLeft = window.innerWidth - root.offsetWidth - 4;
    const maxTop = window.innerHeight - root.offsetHeight - 4;
    root.style.left = `${Math.max(4, Math.min(left, maxLeft))}px`;
    root.style.top = `${Math.max(4, Math.min(top, maxTop))}px`;
  }

  /** Saved position, else just above the stream's price column, else the bottom-right corner. */
  function placeCalculator() {
    const saved = GM_getValue('calcPos', null);
    const player = document.querySelector('[data-testid="live-player"]');
    const rect = player && player.getBoundingClientRect();
    if (saved) moveCalculator(saved.left, saved.top);
    else if (rect && rect.width) moveCalculator(rect.right - CALC_WIDTH - 12, rect.bottom - 235);
    else moveCalculator(window.innerWidth - CALC_WIDTH - 16, window.innerHeight - 150);
    calc.placed = true;
  }

  function renderCalculator() {
    if (!calc.root) return;
    const seller = currentSeller();
    const listed = listedShipping();
    calc.shipRow.style.display = seller && listed > 0 ? 'flex' : 'none';
    if (seller && listed > 0) {
      const bundled = isBundled(seller);
      calc.shipBox.checked = !bundled;
      calc.shipText.textContent = bundled ? 'Shipping free (bundled)' : `Shipping ${yen(listed)}`;
      calc.shipRow.title = `Ticked: shipping is added, as on your first win from ${seller} this week.\nUntick once you've won something: Weekly Bundling ships the rest free. Remembered for 7 days.`;
    }
    const jpy = parseJpyInput(calc.input.value);
    if (jpy === null || !calc.gbpPerJpy) {
      calc.pre.textContent = '\u2014';
      calc.post.textContent = '\u2014';
      calc.post.title = '';
      calc.detail.textContent = calc.input.value.trim() ? 'Type a yen amount, e.g. 12000 or 12k' : '';
      return;
    }
    const r = computeLanded(jpy, calc.gbpPerJpy, rates, settings, shippingForNextBuy());
    calc.pre.textContent = pair(r.price, r.price * calc.gbpPerJpy);
    calc.post.textContent = pair(r.total, r.totalGbp);
    const parts = [];
    if (r.shipping) parts.push(`shipping ${yen(r.shipping)}`);
    if (!r.lowValue) parts.push(`duty ${yen(r.duty)}`);
    parts.push(`VAT ${yen(r.vat)}`);
    if (!r.lowValue) parts.push(`customs fee ${yen(r.fee)}`);
    calc.detail.textContent = `+ ${parts.join(' + ')}${r.lowValue ? ` (under ${POUND}${settings.lowValueThresholdGbp}: no duty or customs fee)` : ''}`;
    calc.post.title = tooltip(r, calc.gbpPerJpy);
  }

  /**
   * Show, hide and refresh the calculator after each scan.
   * @param {number|null} gbpPerJpy Whatnot's FX from this scan, or null when the page has no JPY prices
   */
  function syncCalculator(gbpPerJpy) {
    if (gbpPerJpy) calc.gbpPerJpy = gbpPerJpy;
    const typing = calc.root && calc.root.contains(document.activeElement);
    if (!gbpPerJpy && !typing) {
      if (calc.root) calc.root.style.display = 'none';
      return;
    }
    if (!calc.root) buildCalculator();
    if (calc.root.style.display === 'none') {
      calc.root.style.display = 'block';
      if (!calc.placed) placeCalculator();
    }
    renderCalculator();
  }

  // ---------- Menu ----------

  function promptNumber(label, current) {
    const raw = prompt(label, String(current));
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      alert(`"${raw}" is not a valid number.`);
      return null;
    }
    return n;
  }

  GM_registerMenuCommand('Refresh import rates now', () => refreshRates(true));
  GM_registerMenuCommand('Set customs fee % of duty+VAT', () => {
    const n = promptNumber('Customs fee as % of (duty + VAT):', settings.customsFeePct);
    if (n !== null) { settings.customsFeePct = n; saveSettings(); scheduleScan(true); }
  });
  GM_registerMenuCommand('Set fallback shipping (JPY)', () => {
    const n = promptNumber('Shipping in yen, used when the stream shows no shipping price:', settings.shippingJpy);
    if (n !== null) { settings.shippingJpy = n; saveSettings(); scheduleScan(true); }
  });
  GM_registerMenuCommand('Set commodity code', () => {
    const raw = prompt('UK commodity code (10 digits):', settings.commodityCode);
    if (raw === null) return;
    if (!/^\d{10}$/.test(raw.trim())) { alert('Commodity codes are 10 digits, e.g. 9504400000.'); return; }
    settings.commodityCode = raw.trim();
    saveSettings();
    refreshRates(true);
  });
  GM_registerMenuCommand('Reset calculator position', () => {
    GM_setValue('calcPos', null);
    calc.placed = false;
    if (calc.root && calc.root.style.display !== 'none') placeCalculator();
  });
  GM_registerMenuCommand(`Toggle ${POUND}135 low-value rule`, () => {
    settings.applyLowValueRule = !settings.applyLowValueRule;
    saveSettings();
    scheduleScan(true);
    alert(`${POUND}${settings.lowValueThresholdGbp} low-value rule is now ${settings.applyLowValueRule ? 'ON (VAT only under the threshold)' : 'OFF (duty and fee on every item)'}.`);
  });

  // ---------- Start ----------

  const version = typeof GM_info === 'object' ? GM_info.script.version : '?';
  console.info(LOG, `v${version} running; rates: ${rates.source} (duty ${rates.dutyPct}%, VAT ${rates.vatPct}%)`);
  scheduleScan(true);
  refreshRates(false);
  setInterval(() => refreshRates(false), 60 * 60 * 1000); // long-lived stream tabs still roll over daily
})();
