# monkey-scripts

Personal Tampermonkey userscripts. Each script lives in its own folder next to its tests. To install them, follow [INSTALL.md](INSTALL.md).

| Script | Site | What it does |
|---|---|---|
| [whatnot-landed-cost](whatnot-landed-cost/whatnot-landed-cost.user.js) | whatnot.com | Adds the post-fees UK price (item + VAT + duty + customs fee) under every JPY price, plus a yen calculator box |
| [whatnot-comps](whatnot-comps/whatnot-comps.user.js) | whatnot.com | Scans the card on stream with PulseTCG's scanner, or looks up a typed card, and shows its NM/LP/MP/HP, PSA 10/9/8 and ACE 10 comps, the last UK and US eBay sales, PSA population, and a deal check against the stream price |

## Installing

[INSTALL.md](INSTALL.md) covers installing Tampermonkey, letting it run scripts, installing either script and fixing common problems.

Tampermonkey keeps installed scripts updated: it checks the header's `@updateURL` (daily by default) and installs any higher `@version`. Pasting the file into **Create a new script** works too, and the pasted copy updates the same way as long as its header keeps the `@updateURL`.

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

## whatnot-comps

On a live stream, press **Alt+P** (Option+P on a Mac) or click **Scan card** in the green "Comps" panel. To skip the scan, type a card into the box below the button, such as `Dragonite 149 JP`, and press Enter. That runs Pulse's own search, which understands JP and set numbers, and the results go through the same steps from step 3 on.

The script:

1. Grabs the current video frame at full resolution.
2. Sends it to Pulse's card scanner, the same one behind the scan page on pulsetcg.io.
3. Shows the top match's name, set, number, language, variant and edition (such as 1st Edition), then a table with a row each for NM, LP, MP and HP, then PSA 10, PSA 9, PSA 8 and ACE 10:
   - **Pulse:** Pulse's market price and its last sale date. A `*` marks prices with few recent sales.
   - **eBay UK** and **eBay US:** the most recent eBay sale in that grade on ebay.co.uk and ebay.com, with its date. Click one to find that sale on ebay.co.uk, US sales included: the link searches sold listings for the sale's exact title. The sale's own item page isn't used, because eBay often redirects an ended item to a page of live listings. ebay.co.uk converts US sales to pounds itself and appears to add UK VAT, so its figure can be higher than the panel's: a $1,895 Light Dragonite sale shows there as £1,724.56, against £1,414.30 in the panel.

   Under the table, the card's PSA population and gem rate (the share graded 10), as Pulse records them. Pulse's counts can lag PSA's own.
4. Runs a **deal check**: what the stream's current listing costs you against the Pulse price and the last eBay UK and eBay US sales, as an amount and a percentage under or over.
5. Adds an **Open on Pulse** link to the card's page.
6. Below that, two collapsed sections: **Recent eBay sales** lists the last 3 UK and 3 US sales for the chosen grade, and **Other matches** lists the scanner's other guesses (other cards in view, or other printings of the same card), or the other search results. Click a match to switch to it.

Every price is in GBP. UK sales are already in pounds, and US sales use Pulse's own dollar-to-pound conversion.

The deal check's cost depends on the seller's currency:

- **Yen:** the post-fees total from whatnot-landed-cost's badge, which includes shipping, VAT, duty and the customs fee. Without that script it says so instead of guessing.
- **Pounds:** the price plus the shipping chip.

It compares against the grade on the listing's condition line ("Near Mint" compares with NM), or PSA 10 when the title says PSA 10, and falls back to NM. Click a row's label or Pulse price to compare against another grade. The check follows the stream price as bids come in.

It uses your Pulse login, so sign in to pulsetcg.io in the same browser first. On the first scan Tampermonkey asks whether the script may connect to `pulsetcg.io`; choose **Always allow domain**.

Caveats:

- It calls Pulse's private web API, the one pulsetcg.io's own pages use. Pulse can change it without notice, which would break the script.
- Pulse may log each scan in your scan history, as it does for scans made on the site.
- The scanner reads every card in view, including ones on the seller's mat or shelf, and ranks them by confidence, so the top match is sometimes the wrong card. Scan when the card fills the shot, or pick it from the other matches.
- The scanner can return a card's 1st Edition and Unlimited printings as separate matches with different prices. The edition shows in each match's description; check it against the stamp on the card.
