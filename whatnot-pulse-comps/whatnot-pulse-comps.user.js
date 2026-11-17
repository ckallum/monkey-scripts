// ==UserScript==
// @name         Whatnot Pulse comps
// @namespace    https://ckallum.com/userscripts
// @version      1.4.1
// @description  Scan the card on a Whatnot stream with PulseTCG's scanner, or type it, and show its NM/LP/MP/HP, PSA 10/9/8 and ACE 10 comps, the last UK and US eBay sales, PSA population, and how the stream price compares, all in GBP. Needs you signed in to pulsetcg.io in the same browser.
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
  const PLAYER = '[data-testid="live-player"]';
  // Built from char codes so the source stays ASCII; a mis-encoded paste can't mangle them.
  const POUND = String.fromCharCode(0xa3);
  const YENS = [String.fromCharCode(0xa5), String.fromCharCode(0xffe5)];
  const DOT = String.fromCharCode(0xb7);
  const ARROW_OPEN = String.fromCharCode(0x25be);
  const ARROW_CLOSED = String.fromCharCode(0x25b8);
  const CONDITIONS = ['nm', 'lp', 'mp', 'hp'];
  // Slab grades priced alongside the raw card, as [grader, grade] in Pulse's product-id spelling.
  const SLABS = { psa10: ['PSA', '10'], psa9: ['PSA', '9'], psa8: ['PSA', '8'], ace10: ['ACE', '10'] };
  const GRADES = [...CONDITIONS, ...Object.keys(SLABS)];
  const GRADE_LABELS = { nm: 'NM', lp: 'LP', mp: 'MP', hp: 'HP', psa10: 'PSA 10', psa9: 'PSA 9', psa8: 'PSA 8', ace10: 'ACE 10' };
  // Whatnot's condition line under the stream title. Damaged has no comp of its own, so it compares as HP.
  const LISTING_CONDITIONS = { 'near mint': 'nm', 'lightly played': 'lp', 'moderately played': 'mp', 'heavily played': 'hp', damaged: 'hp' };
  const MAX_MATCHES = 5; // the scanner returns every card in view, background ones included
  const MAX_SEARCH_RESULTS = 8; // a typed search often returns several printings of one card
  const RECENT_SALES = 3; // per region, in the expanded list
  const PANEL_WIDTH = 300;
  const FONT = 'system-ui, -apple-system, sans-serif';
  const GREEN = '#6EE7B7';
  const RED = '#FCA5A5';

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

  /**
   * Sales from one /api/ebay-listings/<sold|sold-us>/<id>/recent response, newest first, in GBP.
   * - Each sale: { grade, gbp, date: 'YYYY-MM-DD'|null, type, title, url }. grade is a raw condition ('nm'...'hp'),
   *   a SLABS key ('psa10', 'psa9', 'psa8', 'ace10'), or null for anything else.
   * - UK sales are already in GBP; US sales use Pulse's own priceGbp conversion. Sales with no GBP price are dropped.
   * - url finds the sale on ebay.co.uk (see soldSearchUrl), for UK and US sales alike.
   */
  function normalizeSales(body) {
    const sales = [];
    for (const l of (body && body.listings) || []) {
      const gbp = toPrice(l.currency === 'GBP' ? l.price : l.priceGbp);
      if (gbp === null) continue;
      let grade = null;
      if (l.gradedBy) {
        const slab = `${String(l.gradedBy).toLowerCase()}${String(l.grade)}`;
        grade = SLABS[slab] ? slab : null;
      } else if (CONDITIONS.includes(String(l.condition || '').toLowerCase())) grade = String(l.condition).toLowerCase();
      const id = String(l.ebayItemId || '');
      sales.push({
        grade,
        gbp,
        date: l.dateSold ? String(l.dateSold).slice(0, 10) : null,
        type: l.auctionType || '',
        title: l.title || '',
        url: soldSearchUrl(l.title, id),
      });
    }
    return sales.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  /**
   * A link that finds one sale on ebay.co.uk.
   * - Searches sold listings for the exact title in quotes, which lands on that sale; eBay falls back to
   *   similar sales when the phrase doesn't match.
   * - The item's own page isn't used: eBay often redirects an ended item to a catalogue page of live listings.
   * - ebay.co.uk's default location includes US sellers, so US sales show there too.
   */
  function soldSearchUrl(title, itemId) {
    const site = 'https://www.ebay.co.uk';
    const phrase = String(title || '').replace(/"/g, '').trim();
    if (phrase) return `${site}/sch/i.html?_nkw=${encodeURIComponent(`"${phrase}"`)}&LH_Sold=1&LH_Complete=1`;
    return /^\d+$/.test(String(itemId || '')) ? `${site}/itm/${itemId}` : null;
  }

  /**
   * What the stream's listing is, from its title and Whatnot's condition line.
   * - The condition line may be spelled out ("Near Mint") or a code ("NM").
   * - Returns a SLABS key ('psa10', 'psa9', 'psa8', 'ace10'), a raw condition ('nm', 'lp', 'mp', 'hp'),
   *   'graded' for any other slab, or null when unknown.
   */
  function listingGrade(title, conditionText) {
    const t = String(title || '');
    // The lookahead keeps half grades ("PSA 8.5") from reading as whole ones.
    const slab = t.match(/\b(PSA|ACE)\s*(10|9|8)(?![.\d])/i);
    const slabKey = slab && `${slab[1].toLowerCase()}${slab[2]}`;
    if (slabKey && SLABS[slabKey]) return slabKey;
    if (/\b(PSA|BGS|CGC|ACE|SGC|TAG)\s*\d/i.test(t)) return 'graded';
    const c = String(conditionText || '').trim().toLowerCase();
    for (const [name, grade] of Object.entries(LISTING_CONDITIONS)) if (c.startsWith(name)) return grade;
    const code = c.match(/^(nm|lp|mp|hp|dmg)\b/);
    if (code) return code[1] === 'dmg' ? 'hp' : code[1];
    return null;
  }

  /** A pound amount that is the whole text ("3" after a pound sign, "1,234.50"); null otherwise. */
  function parseGbp(text) {
    const t = String(text || '').trim();
    if (t[0] !== POUND) return null;
    const m = t.slice(1).trim().match(/^([\d,]+(?:\.\d{1,2})?)$/);
    return m ? toPrice(m[1].replace(/,/g, '')) : null;
  }

  /** The last pound amount in a text ("Post fees" badge: yen total, then the pound total); null if none. */
  function lastGbpIn(text) {
    const parts = String(text || '').split(POUND);
    if (parts.length < 2) return null;
    const m = parts[parts.length - 1].match(/^\s?([\d,]+(?:\.\d{1,2})?)/);
    return m ? toPrice(m[1].replace(/,/g, '')) : null;
  }

  /** Shipping in pounds from a stream chip ("2.63 Shipping" after a pound sign, "FREE Shipping"); null for yen chips and other text. */
  function parseGbpShipping(text) {
    const t = String(text || '').trim();
    if (/^free shipping$/i.test(t)) return 0;
    if (!/shipping$/i.test(t) || /est\./i.test(t) || YENS.some((y) => t.includes(y))) return null;
    const i = t.indexOf(POUND);
    if (i < 0) return null;
    const m = t.slice(i + 1).match(/^\s?([\d,]+(?:\.\d{1,2})?)\s*shipping$/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  /**
   * How a cost compares with a comp, both in GBP.
   * - Returns { under, amount, pct }: under is true when the cost is at or below the comp; amount and pct are positive.
   * - Returns null when either price is missing.
   */
  function compare(cost, comp) {
    if (!(cost > 0) || !(comp > 0)) return null;
    const diff = comp - cost;
    return { under: diff >= 0, amount: Math.abs(diff), pct: (Math.abs(diff) / comp) * 100 };
  }

  /** One field of a Pulse product id ("card:set|number|variant|edition|grader|grade"), or null when empty. */
  function idField(productId, index) {
    const value = String(productId || '').split('|')[index];
    return value && value !== 'null' ? value : null;
  }

  /** The variant field of a Pulse product id ("Holo" in "card:m5_jp|118/081|Holo|null|null|null"), or null. */
  function variantOf(productId) {
    return idField(productId, 2);
  }

  /** The edition or promo field of a Pulse product id ("1st Edition", "CoroCoro 1997 (Flying)"), or null. */
  function editionOf(productId) {
    return idField(productId, 3);
  }

  /** "Set . number . language . variant . edition" for a scan match, skipping missing parts. */
  function describeMatch(match) {
    return [match.set_name, match.card_number, match.language, variantOf(match.product_id), editionOf(match.product_id)].filter(Boolean).join(` ${DOT} `);
  }

  /** Pulse search text ("name number") that ranks the matched product first. */
  function searchQueryFor(match) {
    return `${match.card_name || ''} ${match.card_number || ''}`.trim();
  }

  /**
   * PSA population from one /api/grade-population entry.
   * - Returns { total, psa10, gemRate } with gemRate from 0 to 1, or null when Pulse has no PSA data.
   */
  function parsePsaPop(entry) {
    const psa = entry && entry.graders && entry.graders.psa;
    const total = psa ? Number(psa.totalPopulation) : NaN;
    if (!(total > 0)) return null;
    const psa10 = Number((psa.gradeData || {})['10']) || 0;
    return { total, psa10, gemRate: psa10 / total };
  }

  /** A Pulse search result in the scanner's match shape: { product_id, card_name, set_name, card_number, language }. */
  function searchItemToMatch(item) {
    return { product_id: item.productId, card_name: item.name, set_name: item.setName, card_number: item.number, language: item.language };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      parseConditionPrices,
      parseGradedPrice,
      withGrade,
      normalizeSales,
      listingGrade,
      parseGbp,
      lastGbpIn,
      parseGbpShipping,
      compare,
      variantOf,
      editionOf,
      describeMatch,
      searchQueryFor,
      parsePsaPop,
      searchItemToMatch,
    };
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
   * Raw condition prices, slab prices (SLABS) and PSA population for each match.
   * - Returns { [match product id]: { nm, lp, mp, hp, psa10, psa9, psa8, ace10, pop } }; pop is null when Pulse has none.
   * - Priced from the raw card even when the scanner matched a slab.
   * - A failed population lookup leaves pop null instead of failing the prices.
   */
  async function fetchPrices(ids) {
    const lookups = ids.map((id) => ({
      id,
      raw: withGrade(id, null, null),
      slabs: Object.fromEntries(Object.entries(SLABS).map(([key, [grader, grade]]) => [key, withGrade(id, grader, grade)])),
    }));
    const productIds = [...new Set(lookups.flatMap((l) => [l.raw, ...Object.values(l.slabs)]))];
    const raws = [...new Set(lookups.map((l) => l.raw))];
    const json = { 'Content-Type': 'application/json' };
    const [prices, pops] = await Promise.all([
      post('/api/internal/market-data', JSON.stringify({ productIds, metrics: ['market_price', 'last_sold_price'] }), json),
      post('/api/grade-population', JSON.stringify({ productIds: raws }), json).catch((err) => {
        console.warn(LOG, 'population lookup failed', err);
        return null;
      }),
    ]);
    const body = prices || {};
    const popBody = pops || {};
    return Object.fromEntries(lookups.map((l) => [l.id, {
      ...parseConditionPrices(body[l.raw]),
      ...Object.fromEntries(Object.entries(l.slabs).map(([key, slabId]) => [key, parseGradedPrice(body[slabId])])),
      pop: parsePsaPop(popBody[l.raw]),
    }]));
  }

  /**
   * Recent UK and US eBay sales of a match's raw card and each SLABS grade, newest first, in GBP.
   * - One lookup per product and site (10 in all), run together.
   * - Returns { uk: sale[], us: sale[] } (see normalizeSales). Fails only if every lookup fails.
   */
  async function fetchSales(match) {
    const ids = [withGrade(match.product_id, null, null), ...Object.values(SLABS).map(([grader, grade]) => withGrade(match.product_id, grader, grade))];
    const get = (site, id) => request('GET', `/api/ebay-listings/${site}/${encodeURIComponent(id)}/recent`);
    const lookups = [];
    for (const [region, site] of [['uk', 'sold'], ['us', 'sold-us']]) for (const id of ids) lookups.push({ region, promise: get(site, id) });
    const results = await Promise.allSettled(lookups.map((l) => l.promise));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    const sales = { uk: [], us: [] };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') sales[lookups[i].region].push(...normalizeSales(r.value));
    });
    const newestFirst = (a, b) => (b.date || '').localeCompare(a.date || '');
    return { uk: sales.uk.sort(newestFirst), us: sales.us.sort(newestFirst) };
  }

  /** The match's card-page slug, found by searching Pulse for "name number"; null if not found. */
  async function fetchSlug(match) {
    const body = await request('GET', `/api/v2/search/all?q=${encodeURIComponent(searchQueryFor(match))}&limit=10`);
    const raw = withGrade(match.product_id, null, null);
    const hit = ((body && body.items) || []).find((item) => item.productId === match.product_id || item.productId === raw);
    return hit ? hit.slug : null;
  }

  /** Pulse's own search for typed text such as "Dragonite 149 JP"; resolves to [{ match, slug }], best first. */
  async function searchCards(text) {
    const body = await request('GET', `/api/v2/search/all?q=${encodeURIComponent(text)}&limit=10`);
    return ((body && body.items) || [])
      .filter((item) => String(item.productId || '').startsWith('card:'))
      .slice(0, MAX_SEARCH_RESULTS)
      .map((item) => ({ match: searchItemToMatch(item), slug: item.slug || null }));
  }

  // ---------- Formatting ----------

  const gbp = (n) => `${POUND}${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  /** "2 Nov" for a 'YYYY-MM-DD' date, with the year added when it isn't this year. */
  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return '';
    const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
    if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = '2-digit';
    return d.toLocaleDateString('en-GB', opts);
  }

  // ---------- Stream ----------

  function liveVideo() {
    const video = document.querySelector(`${PLAYER} video`);
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

  /** Visible text inside the player as { text, el } pairs, skipping the landed-cost script's badges. */
  function playerTexts(player) {
    const out = [];
    const walker = document.createTreeWalker(player, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      const text = walker.currentNode.textContent.trim();
      if (text && el && !el.closest('[data-wnl]')) out.push({ text, el });
    }
    return out;
  }

  /**
   * The stream listing's cost to you in GBP.
   * - Yen listings use the post-fees total on the whatnot-landed-cost badge (item, shipping, VAT, duty, customs fee).
   * - Pound listings use the price plus the shipping chip.
   * - Returns { cost: number|null, basis, reason, title, grade } or null off live pages.
   */
  function readListing() {
    const player = document.querySelector(PLAYER);
    if (!player) return null;
    const texts = playerTexts(player);
    const titleEl = player.querySelector('[data-testid="show-product-title"]');
    const title = titleEl ? titleEl.textContent.trim() : '';
    const conditionLine = texts.find(({ text }) => listingGrade('', text) !== null);
    const grade = listingGrade(title, conditionLine && conditionLine.text);

    // whatnot-landed-cost 1.4+ sets data-wnl-post-gbp; older versions only have the badge text.
    const badge = player.querySelector('[data-wnl-post-gbp]') || player.querySelector('[data-wnl]');
    const postFees = badge && (toPrice(badge.dataset.wnlPostGbp) || lastGbpIn(badge.textContent));
    if (postFees) return { cost: postFees, basis: 'post fees', reason: null, title, grade };

    // Shipping chips hold their amount in a text node of its own, so the price search skips them.
    const chips = [...player.querySelectorAll('[data-testid*="shipping"]')];
    const shipping = chips.map((chip) => parseGbpShipping(chip.textContent)).find((v) => v !== null) ?? null;
    let price = null;
    let yen = false;
    for (const { text, el } of texts) {
      if (el.closest('[data-testid*="shipping"], [data-testid="show-bid-button"], [data-testid="show-custom-bid-button"]')) continue;
      if (YENS.some((y) => text.includes(y))) yen = true;
      if (price === null) price = parseGbp(text);
    }
    if (price !== null) {
      return { cost: price + (shipping || 0), basis: shipping ? `incl. ${gbp(shipping)} shipping` : 'price', reason: null, title, grade };
    }
    const reason = yen ? 'Turn on whatnot-landed-cost to check yen listings.' : 'No pound or yen price on the stream.';
    return { cost: null, basis: '', reason, title, grade };
  }

  // ---------- Panel ----------

  const ui = { root: null, body: null, button: null, search: null, go: null, status: null, result: null, deal: null, dealGrade: null, placed: false };
  let state = null; // { matches, prices, slugs, sales, selected, gradeChosen, source: 'scan'|'search' }
  let listing = null; // readListing() as last rendered
  let listingKey = '';
  let busy = false;

  const MUTED = { fontSize: '11px', opacity: '0.6' };
  const DATE = { fontSize: '10px', opacity: '0.5', lineHeight: '1.2' };
  const PRICE = { font: `600 12px/1.3 ${FONT}`, whiteSpace: 'nowrap' };
  const CELL = { padding: '2px 4px' };
  const SECTION = { marginTop: '7px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.15)' };
  const SECTION_HEAD = { fontSize: '10px', opacity: '0.55', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '2px' };

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
    const title = el('span', null, 'Comps');
    const toggle = el('button', { background: 'none', border: 'none', color: 'inherit', font: `700 14px/1 ${FONT}`, cursor: 'pointer', padding: '0 2px' });
    toggle.type = 'button';
    header.append(title, toggle);

    const body = el('div', { padding: '7px 8px 8px', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto' });
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
    const searchRow = el('div', { display: 'flex', gap: '4px', marginTop: '5px' });
    const search = el('input', {
      flex: '1',
      minWidth: '0',
      padding: '4px 6px',
      border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: '6px',
      background: '#0d0d0d',
      color: '#fff',
      font: `12px/1.3 ${FONT}`,
      outline: 'none',
    });
    search.type = 'text';
    search.placeholder = 'Or type a card, e.g. Dragonite 149 JP';
    search.spellcheck = false;
    search.autocomplete = 'off';
    const go = el('button', { padding: '4px 8px', border: `1px solid ${GREEN}`, borderRadius: '6px', background: 'none', color: GREEN, font: `600 12px/1.3 ${FONT}`, cursor: 'pointer' }, 'Search');
    go.type = 'button';
    searchRow.append(search, go);
    const status = el('div', { fontSize: '11px', opacity: '0.75', marginTop: '5px', minHeight: '14px' });
    const result = el('div');
    body.append(button, searchRow, status, result);
    root.append(header, body);
    document.body.appendChild(root);
    Object.assign(ui, { root, body, button, search, go, status, result });

    button.addEventListener('click', () => runScan());
    go.addEventListener('click', () => runSearch());
    // Keep typing in the box away from Whatnot's own keyboard handlers.
    for (const type of ['keydown', 'keyup', 'keypress']) search.addEventListener(type, (e) => e.stopPropagation());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch();
    });

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
    const player = document.querySelector(PLAYER);
    const rect = player && player.getBoundingClientRect();
    if (saved) movePanel(saved.left, saved.top);
    else if (rect && rect.width) movePanel(rect.left + 12, rect.top + 80);
    else movePanel(16, 120);
    ui.placed = true;
  }

  function setStatus(text, isError) {
    ui.status.textContent = text;
    ui.status.style.color = isError ? RED : '';
    ui.status.style.opacity = isError ? '1' : '0.75';
  }

  /** The grade the deal check compares against: your pick, else the listing's own, else NM. */
  function selectedGrade() {
    if (state.gradeChosen) return state.gradeChosen;
    return listing && GRADES.includes(listing.grade) ? listing.grade : 'nm';
  }

  /** The newest sale of a grade in a region, or null while sales are loading or missing. */
  function lastSale(sales, region, grade) {
    return sales && Array.isArray(sales[region]) ? sales[region].find((s) => s.grade === grade) || null : null;
  }

  function saleLink(sale, text, style) {
    const node = el(sale.url ? 'a' : 'span', { color: 'inherit', textDecoration: 'none', ...style }, text);
    if (sale.url) {
      node.href = sale.url;
      node.target = '_blank';
      node.rel = 'noopener';
    }
    node.title = [sale.title, `${sale.type || 'Sold'} on ${sale.date}`, 'Opens this sale on ebay.co.uk'].filter(Boolean).join('\n');
    return node;
  }

  function pulseCell(p, rowStyle) {
    const cell = el('div', { ...CELL, ...rowStyle });
    cell.append(el('div', PRICE, p.value === null ? '-' : `${gbp(p.value)}${p.lowData ? ' *' : ''}`), el('div', DATE, shortDate(p.lastSold)));
    cell.title = p.value === null ? 'No Pulse price' : `Pulse market price${p.lastSold ? `, last sold ${p.lastSold}` : ''}${p.lowData ? ' (few recent sales)' : ''}`;
    return cell;
  }

  function saleCell(sales, region, grade, rowStyle) {
    const cell = el('div', { ...CELL, ...rowStyle });
    if (!sales || sales === 'loading' || sales instanceof Error) {
      cell.append(el('div', { ...PRICE, opacity: '0.4' }, sales instanceof Error ? '?' : '...'));
      if (sales instanceof Error) cell.title = messageFor(sales);
      return cell;
    }
    const sale = lastSale(sales, region, grade);
    if (!sale) {
      cell.append(el('div', { ...PRICE, opacity: '0.4' }, '-'));
      cell.title = `No recent ${region.toUpperCase()} eBay sale`;
      return cell;
    }
    cell.append(saleLink(sale, gbp(sale.gbp), { ...PRICE, display: 'block' }), el('div', DATE, shortDate(sale.date)));
    return cell;
  }

  function priceGrid(prices, sales, grade) {
    // Cells stretch to the row's height so the selected row's highlight is one even band.
    const grid = el('div', { display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', margin: '6px 0 2px', alignItems: 'stretch' });
    for (const head of ['', 'Pulse', 'eBay UK', 'eBay US']) grid.append(el('span', { ...SECTION_HEAD, ...CELL, marginBottom: '0' }, head));
    for (const g of GRADES) {
      if (g === GRADES[CONDITIONS.length]) grid.append(el('div', { gridColumn: '1 / -1', borderTop: '1px solid rgba(255,255,255,0.15)', margin: '2px 0' }));
      const selected = g === grade;
      const rowStyle = selected ? { background: 'rgba(52,211,153,0.14)' } : {};
      const label = el('div', { ...CELL, ...rowStyle, fontSize: '11px', fontWeight: selected ? '700' : '400', color: selected ? GREEN : '', whiteSpace: 'nowrap' }, GRADE_LABELS[g]);
      const pulse = pulseCell(prices[g], rowStyle);
      for (const target of [label, pulse]) {
        target.style.cursor = 'pointer';
        target.addEventListener('click', () => {
          state.gradeChosen = g;
          render();
        });
      }
      grid.append(label, pulse, saleCell(sales, 'uk', g, rowStyle), saleCell(sales, 'us', g, rowStyle));
    }
    return grid;
  }

  /** "PSA pop 2,470 . 1,626 PSA 10s (66% gem rate)", or an empty line when Pulse has no PSA data. */
  function popLine(pop) {
    const line = el('div', { fontSize: '11px', opacity: '0.75', margin: '2px 0 1px' });
    if (!pop) return line;
    const n = (v) => v.toLocaleString('en-GB');
    line.textContent = `PSA pop ${n(pop.total)} ${DOT} ${n(pop.psa10)} PSA 10s (${Math.round(pop.gemRate * 100)}% gem rate)`;
    line.title = `PSA population as Pulse records it, which can lag PSA's own counts`;
    return line;
  }

  function dealSection(prices, sales, grade) {
    const wrap = el('div', SECTION);
    wrap.append(el('div', SECTION_HEAD, `Deal check ${DOT} ${GRADE_LABELS[grade]}`));
    if (!listing || listing.cost === null) {
      wrap.append(el('div', MUTED, (listing && listing.reason) || 'No listing on the stream.'));
      return wrap;
    }
    if (listing.grade === 'graded' && !state.gradeChosen) {
      wrap.append(el('div', MUTED, 'The listing is a slab without a row here. Click a row to compare.'));
      return wrap;
    }
    const grid = el('div', { display: 'grid', gridTemplateColumns: 'auto auto 1fr', columnGap: '8px', rowGap: '1px', alignItems: 'baseline' });
    if (listing.title) grid.title = `Stream listing: ${listing.title}`;
    grid.append(el('span', MUTED, 'Stream'), el('span', PRICE, gbp(listing.cost)), el('span', MUTED, listing.basis));
    const uk = lastSale(sales, 'uk', grade);
    const us = lastSale(sales, 'us', grade);
    for (const [label, comp] of [['vs Pulse', prices[grade].value], ['vs eBay UK', uk && uk.gbp], ['vs eBay US', us && us.gbp]]) {
      const c = compare(listing.cost, comp);
      const verdict = c ? `${gbp(c.amount)} ${c.under ? 'under' : 'over'} (${Math.round(c.pct)}%)` : '';
      grid.append(
        el('span', MUTED, label),
        el('span', { ...PRICE, opacity: comp ? '1' : '0.4' }, comp ? gbp(comp) : '-'),
        el('span', { fontSize: '11px', fontWeight: '600', color: c ? (c.under ? GREEN : RED) : '' }, verdict),
      );
    }
    wrap.append(grid);
    return wrap;
  }

  /** A section heading that expands and collapses it, remembered under storeKey. Returns { toggle, open }. */
  function sectionToggle(storeKey, label) {
    const open = GM_getValue(storeKey, false);
    const toggle = el('button', { background: 'none', border: 'none', color: GREEN, padding: '0', font: `12px/1.4 ${FONT}`, cursor: 'pointer' },
      `${open ? ARROW_OPEN : ARROW_CLOSED} ${label}`);
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      GM_setValue(storeKey, !open);
      render();
    });
    return { toggle, open };
  }

  function recentSalesSection(sales, grade) {
    const wrap = el('div', { marginTop: '6px' });
    const { toggle, open } = sectionToggle('salesOpen', `Recent eBay sales ${DOT} ${GRADE_LABELS[grade]}`);
    wrap.append(toggle);
    if (!open) return wrap;
    if (!sales || sales === 'loading') {
      wrap.append(el('div', MUTED, 'Loading...'));
      return wrap;
    }
    if (sales instanceof Error) {
      wrap.append(el('div', { ...MUTED, color: RED, opacity: '1' }, messageFor(sales)));
      return wrap;
    }
    const list = el('div', { display: 'grid', gridTemplateColumns: 'auto auto auto 1fr', columnGap: '8px', rowGap: '1px', marginTop: '2px', alignItems: 'baseline' });
    for (const region of ['uk', 'us']) {
      const recent = sales[region].filter((s) => s.grade === grade).slice(0, RECENT_SALES);
      if (!recent.length) {
        list.append(el('span', MUTED, region.toUpperCase()), el('span', { ...MUTED, gridColumn: '2 / -1' }, 'no recent sales'));
        continue;
      }
      for (const s of recent) {
        list.append(
          el('span', MUTED, region.toUpperCase()),
          saleLink(s, gbp(s.gbp), PRICE),
          el('span', { ...DATE, fontSize: '11px' }, shortDate(s.date)),
          el('span', { ...MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, s.type),
        );
      }
    }
    wrap.append(list);
    return wrap;
  }

  function render() {
    const box = ui.result;
    box.replaceChildren();
    if (!state) return;
    const match = state.matches[state.selected];
    const prices = state.prices[match.product_id];
    const sales = state.sales[match.product_id];
    const grade = selectedGrade();

    box.append(
      el('div', { font: `600 14px/1.3 ${FONT}`, marginTop: '6px' }, match.card_name),
      el('div', MUTED, describeMatch(match)),
      priceGrid(prices, sales, grade),
      popLine(prices.pop),
      el('div', { ...MUTED, fontSize: '10px' }, `All GBP ${DOT} eBay: last sold ${DOT} * few recent sales ${DOT} click a row to compare`),
    );
    ui.deal = dealSection(prices, sales, grade);
    ui.dealGrade = grade;
    box.append(ui.deal);

    const slug = state.slugs[match.product_id];
    if (slug) {
      const link = el('a', { display: 'inline-block', marginTop: '6px', color: GREEN, fontSize: '12px' }, 'Open on Pulse');
      link.href = `${PULSE}/cards/${encodeURIComponent(slug)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      box.append(el('div', null), link);
    }

    box.append(recentSalesSection(sales, grade));

    if (state.matches.length > 1) {
      const hint = state.source === 'search' ? 'Other Pulse search results' : 'Other cards in view, or other printings of this one';
      const { toggle, open } = sectionToggle('matchesOpen', `Other matches (${state.matches.length - 1})`);
      toggle.title = hint;
      box.append(el('div', { marginTop: '4px' }), toggle);
      if (!open) return;
      box.append(el('div', { ...MUTED, marginBottom: '3px' }, hint));
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
        });
        const top = el('div', { display: 'flex', justifyContent: 'space-between', gap: '8px' });
        top.append(el('span', { fontWeight: '600' }, other.card_name), el('span', { ...PRICE, opacity: '0.85' }, nm === null ? '' : `NM ${gbp(nm)}`));
        row.append(top, el('div', MUTED, describeMatch(other)));
        row.type = 'button';
        row.title = 'Show this match';
        row.addEventListener('click', () => {
          state.selected = i;
          loadSales(other);
          render();
        });
        box.append(row);
      });
    }
  }

  /**
   * Redraw the deal check for a new stream price.
   * - Only the deal section is replaced while the compared grade stays the same, so a click on the
   *   table or the toggles isn't lost to a redraw mid-auction.
   */
  function refreshDeal() {
    const grade = selectedGrade();
    if (!ui.deal || !ui.deal.isConnected || grade !== ui.dealGrade) {
      render();
      return;
    }
    const match = state.matches[state.selected];
    const fresh = dealSection(state.prices[match.product_id], state.sales[match.product_id], grade);
    ui.deal.replaceWith(fresh);
    ui.deal = fresh;
  }

  function messageFor(err) {
    if (err.status === 401) return 'Sign in to pulsetcg.io in this browser, then try again.';
    if (err.status === 403) return 'Pulse refused the request (403). Open pulsetcg.io once, then retry.';
    return err.message || 'Scan failed';
  }

  /** Fetch a match's eBay sales once per scan, re-rendering when they arrive. Retries after an error. */
  function loadSales(match) {
    const current = state;
    const existing = current && current.sales[match.product_id];
    if (!current || (existing && !(existing instanceof Error))) return;
    current.sales[match.product_id] = 'loading';
    fetchSales(match)
      .then((sales) => {
        current.sales[match.product_id] = sales;
      })
      .catch((err) => {
        console.warn(LOG, err);
        current.sales[match.product_id] = err instanceof Error ? err : new Error(String(err));
      })
      .then(() => {
        if (state === current) render();
      });
  }

  /** Run one lookup at a time, with the buttons disabled and any error shown in the status line. */
  async function exclusive(task) {
    if (busy || !ui.root) return;
    busy = true;
    for (const b of [ui.button, ui.go]) {
      b.disabled = true;
      b.style.opacity = '0.6';
    }
    try {
      await task();
    } catch (err) {
      console.warn(LOG, err);
      setStatus(messageFor(err), true);
    } finally {
      busy = false;
      for (const b of [ui.button, ui.go]) {
        b.disabled = false;
        b.style.opacity = '1';
      }
    }
  }

  /**
   * Price a list of matches and show the first.
   * - slugs: card-page slugs already known (search results carry them); the rest are looked up.
   * - source: 'scan' or 'search', which words the other-matches hint.
   */
  async function showMatches(matches, slugs, source, doneText) {
    setStatus('Fetching prices...');
    const prices = await fetchPrices(matches.map((m) => m.product_id));
    listing = readListing();
    listingKey = JSON.stringify(listing);
    state = { matches, prices, slugs: { ...slugs }, sales: {}, selected: 0, gradeChosen: null, source };
    loadSales(matches[0]);
    render();
    setStatus(`${doneText} at ${new Date().toLocaleTimeString('en-GB')}`);
    const current = state;
    for (const m of matches) {
      if (current.slugs[m.product_id]) continue;
      fetchSlug(m)
        .then((slug) => {
          if (slug && state === current) {
            current.slugs[m.product_id] = slug;
            render();
          }
        })
        .catch(() => {});
    }
  }

  function clearResult(message) {
    state = null;
    render();
    setStatus(message, true);
  }

  function runScan() {
    return exclusive(async () => {
      setStatus('Scanning...');
      const matches = await scanFrame(await grabFrame());
      if (!matches.length) return clearResult('No card recognised. Wait for a clear view of one card and try again.');
      return showMatches(matches, {}, 'scan', 'Scanned');
    });
  }

  function runSearch() {
    const text = ui.search.value.trim();
    if (!text) return undefined;
    return exclusive(async () => {
      setStatus('Searching...');
      const results = await searchCards(text);
      if (!results.length) return clearResult(`No Pulse cards match "${text}".`);
      const slugs = Object.fromEntries(results.filter((r) => r.slug).map((r) => [r.match.product_id, r.slug]));
      return showMatches(results.map((r) => r.match), slugs, 'search', `Searched "${text}"`);
    });
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
  // The same tick keeps the deal check in step with the stream's price as bids come in.
  setInterval(() => {
    const onLive = Boolean(document.querySelector(PLAYER));
    if (onLive && !ui.root) buildPanel();
    if (!ui.root) return;
    const show = onLive ? 'block' : 'none';
    if (ui.root.style.display !== show) {
      ui.root.style.display = show;
      if (onLive && !ui.placed) placePanel();
    }
    if (state && onLive) {
      const next = readListing();
      const key = JSON.stringify(next);
      if (key !== listingKey) {
        listing = next;
        listingKey = key;
        refreshDeal();
      }
    }
  }, 1000);

  console.info(LOG, 'running');
})();
