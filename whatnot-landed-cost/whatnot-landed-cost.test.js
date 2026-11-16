// Run with: npm test (from the repo root)
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYen, parseEstGbp, parseJpyInput, parseShippingChip, parseTariff, computeLanded, DEFAULT_SETTINGS } = require('./whatnot-landed-cost.user.js');

const RATES = { dutyPct: 2, vatPct: 20 };
const GBP_PER_JPY = 235.97 / 49800; // Whatnot's own est. for a ¥49,800 listing

test('matches the ¥59,900 receipt to within ¥1 (Whatnot rounds VAT via GBP)', () => {
  const r = computeLanded(59900, GBP_PER_JPY, RATES, DEFAULT_SETTINGS);
  assert.equal(r.lowValue, false);
  assert.equal(r.duty, 1198);
  assert.ok(Math.abs(r.vat - 12221) <= 1, `vat ${r.vat}`);
  assert.equal(r.fee, 1342);
  assert.ok(Math.abs(r.total - 74661) <= 1, `total ${r.total}`);
});

test('matches the ¥34,800 receipt exactly, line for line', () => {
  const r = computeLanded(34800, GBP_PER_JPY, RATES, DEFAULT_SETTINGS);
  assert.equal(r.lowValue, false);
  assert.deepEqual([r.duty, r.vat, r.fee, r.total], [696, 7099, 780, 43375]);
});

test('at or under £135 only VAT is added', () => {
  const r = computeLanded(3400, 16.11 / 3400, RATES, DEFAULT_SETTINGS);
  assert.equal(r.lowValue, true);
  assert.deepEqual([r.duty, r.vat, r.fee, r.total], [0, 680, 0, 4080]);
});

test('shipping adds to duty and VAT but not to the £135 threshold', () => {
  const fx = 0.00474;
  // ¥20,000 of goods (about £95) stays low-value even with ¥10,000 shipping on top.
  const low = computeLanded(20000, fx, RATES, DEFAULT_SETTINGS, 10000);
  assert.equal(low.lowValue, true);
  assert.deepEqual([low.duty, low.vat, low.fee, low.total], [0, 6000, 0, 36000]);
  const high = computeLanded(34800, fx, RATES, DEFAULT_SETTINGS, 3380);
  assert.deepEqual([high.duty, high.vat, high.fee, high.total], [764, 7789, 855, 47588]);
});

test('reads shipping from the stream chip', () => {
  assert.equal(parseShippingChip('🇯🇵 JP¥3,380 (est. £15.99) Shipping'), 3380);
  assert.equal(parseShippingChip('¥4,814 (est. £22.78) Shipping'), 4814);
  assert.equal(parseShippingChip('FREE Shipping'), 0);
  assert.equal(parseShippingChip('Ships FedEx IP'), null);
  assert.equal(parseShippingChip('Shipping and Delivery'), null);
});

test('low-value rule can be switched off', () => {
  const r = computeLanded(3400, 16.11 / 3400, RATES, { ...DEFAULT_SETTINGS, applyLowValueRule: false });
  assert.deepEqual([r.duty, r.vat, r.fee], [68, 694, 76]);
});

test('parses Whatnot price and estimate text', () => {
  assert.equal(parseYen('¥3,400'), 3400);
  assert.equal(parseYen('JP¥49,800'), 49800);
  assert.equal(parseYen('￥285,000'), 285000);
  assert.equal(parseYen('JP¥49,800 0 bids'), null);
  assert.equal(parseYen('$20'), null);
  assert.equal(parseEstGbp('est. £16.11'), 16.11);
  assert.equal(parseEstGbp('(est. £1,350.42)'), 1350.42);
  assert.equal(parseEstGbp('est. $16.11'), null);
});

test('parses calculator input, including k shorthand', () => {
  assert.equal(parseJpyInput('12000'), 12000);
  assert.equal(parseJpyInput(' 12,000 '), 12000);
  assert.equal(parseJpyInput('¥12k'), 12000);
  assert.equal(parseJpyInput('JP¥5,900'), 5900);
  assert.equal(parseJpyInput('1.5K'), 1500);
  assert.equal(parseJpyInput(''), null);
  assert.equal(parseJpyInput('0'), null);
  assert.equal(parseJpyInput('12x'), null);
});

test('script source is pure ASCII, so a mis-encoded paste cannot mangle the currency signs', () => {
  const source = require('node:fs').readFileSync(require.resolve('./whatnot-landed-cost.user.js'), 'utf8');
  const offending = source.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /[^\x00-\x7F]/.test(line));
  assert.deepEqual(offending, []);
});

test('reads MFN duty and VAT from a Trade Tariff response, ignoring preferences', () => {
  const measure = (id, type, area, expr) => ({
    type: 'measure',
    id,
    relationships: {
      measure_type: { data: { id: type, type: 'measure_type' } },
      geographical_area: { data: { id: area, type: 'geographical_area' } },
      duty_expression: { data: { id: expr, type: 'duty_expression' } },
    },
  });
  const expr = (id, base) => ({ type: 'duty_expression', id, attributes: { base } });
  const json = {
    included: [
      measure('1', '142', 'JP', 'e1'), expr('e1', '0.00 %'),
      measure('2', '103', '1011', 'e2'), expr('e2', '2.00 %'),
      measure('3', '305', '1400', 'e3'), expr('e3', '20.00 %'),
    ],
  };
  assert.deepEqual(parseTariff(json), { dutyPct: 2, vatPct: 20 });
});
