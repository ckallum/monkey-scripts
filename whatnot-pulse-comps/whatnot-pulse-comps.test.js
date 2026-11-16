// Run with: npm test (from the repo root)
const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./whatnot-pulse-comps.user.js');

const FLYING_PIKACHU = 'card:unnumbered_jp|Unnumbered-02|null|CoroCoro 1997 (Flying)|null|null';

// Trimmed from a real /api/internal/market-data response.
const MARKET_DATA = [
  { type: 'last_sold_price', value: 240 },
  {
    type: 'market_price',
    value: 261.04,
    conditionPricing: {
      nm: { productId: FLYING_PIKACHU, value: 261.04, last_sold_date: '2026-11-01T00:00:00.000Z', low_availability: false },
      lp: { productId: `${FLYING_PIKACHU}|lp`, value: 156.35, last_sold_date: '2026-11-01 00:00:00+00', low_availability: false },
      mp: { productId: `${FLYING_PIKACHU}|mp`, value: '99.3', last_sold_date: '2026-11-01 00:00:00+00', salesVolume30d: 1, low_availability: true },
      hp: { productId: `${FLYING_PIKACHU}|hp`, value: 65.4, last_sold_date: null, low_availability: false },
    },
  },
];

test('reads all four condition prices, last-sold dates and low-data flags', () => {
  assert.deepEqual(parseConditionPrices(MARKET_DATA), {
    nm: { value: 261.04, lowData: false, lastSold: '2026-11-01' },
    lp: { value: 156.35, lowData: false, lastSold: '2026-11-01' },
    mp: { value: 99.3, lowData: true, lastSold: '2026-11-01' },
    hp: { value: 65.4, lowData: false, lastSold: null },
  });
});

test('NM falls back to the market price when there is no condition breakdown', () => {
  const r = parseConditionPrices([{ type: 'market_price', value: 32.42 }]);
  assert.equal(r.nm.value, 32.42);
  assert.deepEqual([r.lp.value, r.mp.value, r.hp.value], [null, null, null]);
});

test('missing or unpriced products give empty rows instead of throwing', () => {
  const empty = { value: null, lowData: false, lastSold: null };
  const expected = { nm: empty, lp: empty, mp: empty, hp: empty };
  assert.deepEqual(parseConditionPrices(undefined), expected);
  assert.deepEqual(parseConditionPrices([]), expected);
  assert.deepEqual(parseConditionPrices([{ type: 'market_price', value: null, conditionPricing: { nm: { value: null } } }]), expected);
});

test('reads a PSA 10 price from its market-data entries', () => {
  // Trimmed from the real response for card:dptp_jp|043/DPt-P|null|null|PSA|10.
  const entries = [
    { type: 'market_price', value: '4567.78', condition: 'nm', low_availability: true, last_sold_price: 5086.7, last_sold_date: '2026-10-24T00:00:00.000Z' },
    { type: 'last_sold_price', value: 5086.7 },
  ];
  assert.deepEqual(parseGradedPrice(entries), { value: 4567.78, lowData: true, lastSold: '2026-10-24' });
  assert.deepEqual(parseGradedPrice(undefined), { value: null, lowData: false, lastSold: null });
});

test('swaps the grading fields of a product id', () => {
  const raw = 'card:dptp_jp|043/DPt-P|null|null|null|null';
  assert.equal(withGrade(raw, 'PSA', '10'), 'card:dptp_jp|043/DPt-P|null|null|PSA|10');
  assert.equal(withGrade('card:dptp_jp|043/DPt-P|null|null|PSA|9', null, null), raw);
  assert.equal(withGrade(FLYING_PIKACHU, 'PSA', '10'), 'card:unnumbered_jp|Unnumbered-02|null|CoroCoro 1997 (Flying)|PSA|10');
  assert.equal(withGrade('card:short|1', 'PSA', '10'), 'card:short|1');
});

test('normalises UK and US eBay sales to GBP, newest first', () => {
  // Trimmed from real /api/ebay-listings/.../recent responses for Mega Darkrai ex 118/081.
  const uk = normalizeSales({
    listings: [
      { ebayItemId: '257736454303', title: 'Mega Darkrai EX M5 Abyss Eye', price: 167.1, currency: 'GBP', auctionType: 'Fixed price', condition: 'NM', gradedBy: null, grade: null, dateSold: '2026-11-01T00:00:00.000Z' },
      { ebayItemId: '206648627822', title: 'Mega Darkrai EX 118/081', price: 150, currency: 'GBP', auctionType: 'Fixed price', condition: 'NM', gradedBy: null, grade: null, dateSold: '2026-11-02T00:00:00.000Z' },
    ],
  }, 'uk');
  assert.deepEqual(uk.map((s) => [s.grade, s.gbp, s.date]), [['nm', 150, '2026-11-02'], ['nm', 167.1, '2026-11-01']]);
  assert.equal(uk[0].url, 'https://www.ebay.co.uk/itm/206648627822');

  const us = normalizeSales({
    listings: [
      { ebayItemId: '820304395641', title: 'Mega Darkrai ex 118/081', price: 115, bestOfferPrice: 115, askingPrice: 125, currency: 'USD', auctionType: 'Best Offer Accepted', condition: 'LP', dateSold: '2026-11-07T00:00:00.000Z', priceGbp: 85.92 },
      { ebayItemId: '377604974396', title: 'PSA 10 Japanese Mega Darkrai EX', price: 499.95, currency: 'USD', auctionType: 'Fixed price', gradedBy: 'PSA', grade: '10', dateSold: '2026-10-30T00:00:00.000Z', priceGbp: 373.13 },
      { ebayItemId: '327453209884', title: 'Mega Darkrai ex PSA 9', price: 175, currency: 'USD', gradedBy: 'PSA', grade: '9', dateSold: '2026-11-13T00:00:00.000Z', priceGbp: 132.31 },
      { ebayItemId: '1', title: 'no conversion', price: 50, currency: 'USD', condition: 'NM', dateSold: '2026-11-14T00:00:00.000Z' },
    ],
  }, 'us');
  assert.deepEqual(us.map((s) => [s.grade, s.gbp]), [[null, 132.31], ['lp', 85.92], ['psa10', 373.13]]);
  assert.equal(us[1].url, 'https://www.ebay.com/itm/820304395641');
  assert.equal(us[1].type, 'Best Offer Accepted');
  assert.deepEqual(normalizeSales(null, 'uk'), []);
});

test('reads what the stream listing is from its title and condition line', () => {
  assert.equal(listingGrade('Japanese Single Card #31', 'Near Mint'), 'nm');
  assert.equal(listingGrade('0- Card on the screen', 'Lightly Played \u2022 Japanese'), 'lp');
  assert.equal(listingGrade('Charizard', 'Damaged'), 'hp');
  assert.equal(listingGrade('Mega Darkrai ex PSA 10 Japanese', 'New'), 'psa10');
  assert.equal(listingGrade('Umbreon PSA 9', 'Near Mint'), 'graded');
  assert.equal(listingGrade('PSA GRADING ITEM', 'New \u2022 Japanese'), null);
  assert.equal(listingGrade('', ''), null);
});

test('reads pound prices and pound shipping chips, ignoring yen chips', () => {
  assert.equal(parseGbp('\u00a33'), 3);
  assert.equal(parseGbp(' \u00a31,234.50 '), 1234.5);
  assert.equal(parseGbp('Bid: \u00a33'), null);
  assert.equal(parseGbp('est. \u00a312.24'), null);
  assert.equal(lastGbpIn('Post fees \u00a58,262 \u00b7 \u00a339.21'), 39.21);
  assert.equal(lastGbpIn('Post fees \u00a58,262'), null);
  assert.equal(parseGbpShipping('\u00a32.63 Shipping'), 2.63);
  assert.equal(parseGbpShipping('FREE Shipping'), 0);
  assert.equal(parseGbpShipping('\ud83c\uddef\ud83c\uddf5 \u00a54,170 (est. \u00a319.79) Shipping'), null);
  assert.equal(parseGbpShipping('Ships FedEx IP'), null);
});

test('compares a listing cost with a comp', () => {
  const under = compare(39.21, 62.33);
  assert.equal(under.under, true);
  assert.ok(Math.abs(under.amount - 23.12) < 1e-9);
  assert.equal(Math.round(under.pct), 37);
  assert.deepEqual(compare(75, 50), { under: false, amount: 25, pct: 50 });
  assert.equal(compare(39.21, null), null);
  assert.equal(compare(null, 62.33), null);
});

test('reads the variant from a product id', () => {
  assert.equal(variantOf('card:m5_jp|118/081|Holo|null|null|null'), 'Holo');
  assert.equal(variantOf(FLYING_PIKACHU), null);
  assert.equal(variantOf(undefined), null);
  assert.equal(editionOf('card:xy2_jp|078/080|null|1st Edition|null|null'), '1st Edition');
  assert.equal(editionOf('card:xy2_jp|078/080|null|null|null|null'), null);
  assert.equal(editionOf(FLYING_PIKACHU), 'CoroCoro 1997 (Flying)');
});

test('describes a scan match and builds its search query', () => {
  const match = {
    product_id: 'card:m5_jp|118/081|Holo|null|null|null',
    card_name: 'Mega Darkrai ex',
    set_name: 'Abyss Eye',
    card_number: '118/081',
    language: 'Japanese',
  };
  assert.equal(describeMatch(match), 'Abyss Eye · 118/081 · Japanese · Holo');
  assert.equal(searchQueryFor(match), 'Mega Darkrai ex 118/081');
  assert.equal(describeMatch({ product_id: FLYING_PIKACHU, set_name: 'Unnumbered Promos' }), 'Unnumbered Promos · CoroCoro 1997 (Flying)');
  // Pokemon Center Lady 078/080 came back from one scan as both printings; only the edition tells them apart.
  const lady = { set_name: 'Wild Blaze', card_number: '078/080', language: 'Japanese' };
  assert.equal(describeMatch({ ...lady, product_id: 'card:xy2_jp|078/080|null|1st Edition|null|null' }), 'Wild Blaze · 078/080 · Japanese · 1st Edition');
  assert.equal(describeMatch({ ...lady, product_id: 'card:xy2_jp|078/080|null|null|null|null' }), 'Wild Blaze · 078/080 · Japanese');
  assert.equal(searchQueryFor({ card_name: 'Flying Pikachu' }), 'Flying Pikachu');
});

test('script source is pure ASCII, so a mis-encoded paste cannot mangle it', () => {
  const source = require('node:fs').readFileSync(require.resolve('./whatnot-pulse-comps.user.js'), 'utf8');
  const offending = source.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /[^\x00-\x7F]/.test(line));
  assert.deepEqual(offending, []);
});
