# monkey-scripts

Personal Tampermonkey userscripts. Each script lives in its own folder next to its tests.

| Script | Site | What it does |
|---|---|---|
| [whatnot-landed-cost](whatnot-landed-cost/whatnot-landed-cost.user.js) | whatnot.com | Adds the post-fees UK price (item + VAT + duty + customs fee) under every JPY price, plus a yen calculator box |
| [whatnot-pulse-comps](whatnot-pulse-comps/whatnot-pulse-comps.user.js) | whatnot.com | Scans the card on stream with PulseTCG's scanner and shows its NM/LP/MP/HP and PSA 10 comp prices |

## Installing a script

1. Open the script's raw file in a browser with Tampermonkey, for example [whatnot-landed-cost.user.js](https://raw.githubusercontent.com/ckallum/monkey-scripts/main/whatnot-landed-cost/whatnot-landed-cost.user.js). Tampermonkey shows an install page; click **Install**.
2. In Chromium browsers, open `chrome://extensions`, then Tampermonkey's **Details**. Turn on **Allow User Scripts** and set **Site access** to **On all sites**. Without both, no script runs.

Tampermonkey then keeps the script updated: it checks the header's `@updateURL` (daily by default) and installs any higher `@version`. Pasting the file into **Create a new script** works too, and the pasted copy updates the same way as long as its header keeps the `@updateURL`.

## Tests

`npm test` runs every `*.test.js` with Node's built-in test runner. It needs Node 20 or later and has no dependencies.

## Conventions

- Keep script sources pure ASCII and write currency signs as escapes, such as `\u00A3` for the pound sign. A clipboard copy in the wrong encoding once turned every `£` into `¬£`, and the price matching broke without any error. Each script's tests check for this.
- Bump `@version` in every change you want installed copies to pick up; Tampermonkey ignores updates that don't raise it.
- Export the pure helpers through `module.exports` behind a `typeof module` guard, so tests can `require` a script without a browser.

## whatnot-landed-cost

The badge and the calculator both estimate what Whatnot charges a UK buyer for an item from a Japanese seller:

- **Shipping:** read from the stream's shipping chip (e.g. `JP¥3,380 (est. £15.99) Shipping`). Weekly Bundling ships later wins from the same seller free, so the calculator has a tick box per seller: untick it after your first win and shipping drops out for 7 days.
- **Duty:** 2% of item + shipping, the UK third-country rate for commodity 9504 40 00 00 (playing cards). The UK–Japan 0% preference is ignored because Whatnot charged 2%.
- **VAT:** 20% of item + shipping + duty.
- **Customs fee:** 10% of duty + VAT.
- Duty and VAT come from the UK Trade Tariff API and refresh once a day. Pounds use Whatnot's own `est. £` rate from the page.

The fee percentage matches two receipts. ¥34,800 came to exactly ¥43,375, line for line. ¥59,900 came to ¥74,661, where the script gives ¥74,660.

Items whose goods are worth £135 or less (shipping doesn't count towards this) get VAT only, under the UK low-value rule. That part hasn't been checked against a real receipt yet. If a cheap item's receipt shows duty or a customs fee, turn the rule off from the menu.

The Tampermonkey menu can refresh the rates, set the fee %, a fallback shipping amount for streams with no shipping chip, and the commodity code, toggle the £135 rule, and reset the calculator's position.

## whatnot-pulse-comps

On a live stream, press **Alt+P** (Option+P on a Mac) or click **Scan card** in the green "Pulse comps" panel. The script:

1. Grabs the current video frame at full resolution.
2. Sends it to Pulse's card scanner, the same one behind the scan page on pulsetcg.io.
3. Fetches market prices for the matches and shows the top one: name, set, number, language and variant, then NM, LP, MP and HP prices for the raw card and the PSA 10 price, each with its last sale date. A `*` marks prices with few recent sales.
4. Adds an **Open on Pulse** link to the card's page, and lists other cards it found in the frame. Click one to switch to it.

It uses your Pulse login, so sign in to pulsetcg.io in the same browser first. On the first scan Tampermonkey asks whether the script may connect to `pulsetcg.io`; choose **Always allow domain**.

Caveats:

- It calls Pulse's private web API, the one pulsetcg.io's own pages use. Pulse can change it without notice, which would break the script.
- Pulse may log each scan in your scan history, as it does for scans made on the site.
- The scanner reads every card in view, including ones on the seller's mat or shelf, and ranks them by confidence, so the top match is sometimes the wrong card. Scan when the card fills the shot, or pick it from "Also in frame".
- It has no separate check for 1st edition. Check the set and variant line against the card on screen before trusting the price.
