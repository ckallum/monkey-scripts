// Run with: npm test (from the repo root)
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConditionPrices, parseGradedPrice, withGrade, variantOf, describeMatch, searchQueryFor } = require('./whatnot-pulse-comps.user.js');

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

test('reads the variant from a product id', () => {
  assert.equal(variantOf('card:m5_jp|118/081|Holo|null|null|null'), 'Holo');
  assert.equal(variantOf(FLYING_PIKACHU), null);
  assert.equal(variantOf(undefined), null);
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
  assert.equal(describeMatch({ product_id: FLYING_PIKACHU, set_name: 'Unnumbered Promos' }), 'Unnumbered Promos');
  assert.equal(searchQueryFor({ card_name: 'Flying Pikachu' }), 'Flying Pikachu');
});

test('script source is pure ASCII, so a mis-encoded paste cannot mangle it', () => {
  const source = require('node:fs').readFileSync(require.resolve('./whatnot-pulse-comps.user.js'), 'utf8');
  const offending = source.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /[^\x00-\x7F]/.test(line));
  assert.deepEqual(offending, []);
});
