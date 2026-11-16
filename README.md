# monkey-scripts

Personal Tampermonkey userscripts. Each script lives in its own folder next to its tests.

| Script | Site | What it does |
|---|---|---|
| [whatnot-landed-cost](whatnot-landed-cost/whatnot-landed-cost.user.js) | whatnot.com | Adds the all-in UK price (item + VAT + duty + customs fee) under every JPY price, plus a yen calculator box |

## Installing a script

1. In Tampermonkey, choose **Create a new script**, select everything in the editor, paste the `.user.js` file over it, and save.
2. In Chromium browsers, open `chrome://extensions`, then Tampermonkey's **Details**. Turn on **Allow User Scripts** and set **Site access** to **On all sites**. Without both, no script runs.

The repo is private, so Tampermonkey can't fetch updates from it. To update a script, paste the new version over the old one.

## Tests

`npm test` runs every `*.test.js` with Node's built-in test runner. It needs Node 20 or later and has no dependencies.

## Conventions

- Keep script sources pure ASCII and write currency signs as escapes, such as `\u00A3` for the pound sign. A clipboard copy in the wrong encoding once turned every `£` into `¬£`, and the price matching broke without any error. Each script's tests check for this.
- Export the pure helpers through `module.exports` behind a `typeof module` guard, so tests can `require` a script without a browser.

## whatnot-landed-cost

The badge and the calculator both estimate what Whatnot charges a UK buyer for an item from a Japanese seller:

- **Duty:** 2%, the UK third-country rate for commodity 9504 40 00 00 (playing cards). The UK–Japan 0% preference is ignored because Whatnot charged 2%.
- **VAT:** 20% of item + duty.
- **Customs fee:** 10% of duty + VAT.
- Duty and VAT come from the UK Trade Tariff API and refresh once a day. Pounds use Whatnot's own `est. £` rate from the page.

The fee percentage matches two receipts. ¥34,800 came to exactly ¥43,375, line for line. ¥59,900 came to ¥74,661, where the script gives ¥74,660.

Items worth £135 or less get VAT only, under the UK low-value rule. That part hasn't been checked against a real receipt yet. If a cheap item's receipt shows duty or a customs fee, turn the rule off from the menu.

The Tampermonkey menu can refresh the rates, set the fee %, shipping and commodity code, toggle the £135 rule, and reset the calculator's position.
