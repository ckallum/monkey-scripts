# Installing the Whatnot userscripts

This repo has two userscripts for watching Pokémon card streams on [whatnot.com](https://www.whatnot.com):

- **Whatnot UK landed cost** puts a yellow "Post fees" badge under every yen price, showing what a UK buyer pays once shipping, import VAT, customs duty and the customs fee are added. It also adds a small yen calculator.
- **Whatnot Comps** adds a green "Comps" panel to live streams. Press Alt+P (Option+P on a Mac) to scan the card on screen, or type one such as `Dragonite 149 JP`. The panel shows PulseTCG prices by condition and grade, the latest UK and US eBay sales, and how the stream's price compares.

They work separately, so you can install either or both. Whatnot Comps uses the landed-cost badge for yen listings, so install both if you buy from Japanese sellers.

Both were built and tested in Chromium browsers (Chrome, Edge, Brave, Arc, Dia) on a desktop. They don't run in the Whatnot phone app.

## 1. Install Tampermonkey

Tampermonkey is the browser extension that runs userscripts.

- Chrome and other Chromium browsers: [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Firefox: [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/)
- Other browsers: [tampermonkey.net](https://www.tampermonkey.net/) links to each store.

## 2. Let Tampermonkey run scripts (Chromium browsers)

Chromium browsers block userscripts until you allow them, and with this left off nothing happens and no error appears.

1. Open your browser's extensions page: type `chrome://extensions` in the address bar (Edge: `edge://extensions`).
2. Find Tampermonkey and click **Details**.
3. Turn on **Allow User Scripts**. Older browser versions don't have this switch; turn on **Developer mode** (top right of the extensions page) instead.
4. Set **Site access** to **On all sites**.

Firefox needs none of this.

## 3. Install the scripts

Click a link below. Tampermonkey opens an install page showing the script's name and the sites it connects to; click **Install**.

| Script | Install link |
|---|---|
| Whatnot UK landed cost | [whatnot-landed-cost.user.js](https://raw.githubusercontent.com/ckallum/monkey-scripts/main/whatnot-landed-cost/whatnot-landed-cost.user.js) |
| Whatnot Comps | [whatnot-comps.user.js](https://raw.githubusercontent.com/ckallum/monkey-scripts/main/whatnot-comps/whatnot-comps.user.js) |

If the link shows plain code instead of an install page, Tampermonkey isn't installed or is switched off. Go back to steps 1 and 2.

Install from these links rather than copying and pasting the code. A paste can mangle the `£` and `¥` signs if the clipboard uses the wrong text encoding, and the scripts then can't read prices.

## 4. Set up each script

### Whatnot UK landed cost

No account is needed. On first use it fetches the current UK duty and VAT rates from the UK government's Trade Tariff service (`www.trade-tariff.service.gov.uk`), and refreshes them once a day. If Tampermonkey asks whether the script may connect there, choose **Always allow domain**.

The estimate assumes you're a UK buyer. Pounds use Whatnot's own "est. £" exchange rate.

Its Tampermonkey menu (click the Tampermonkey icon on a Whatnot page) can refresh the rates, change the customs fee, set a fallback shipping amount, change the commodity code, switch the £135 low-value rule, and reset the calculator's position.

### Whatnot Comps

You need a [PulseTCG](https://pulsetcg.io) account. Sign in at pulsetcg.io in the same browser: the script makes its requests with that login, the same way Pulse's own site does. If Tampermonkey asks whether the script may connect to `pulsetcg.io`, choose **Always allow domain**.

Each scan sends the current video frame to Pulse's card scanner, and Pulse may keep it in your scan history.

## 5. Check they're working

Open any live Pokémon stream on Whatnot.

- Whatnot Comps: a green **Comps** panel appears near the top left of the video. Click **Scan card** or press Alt+P.
- Landed cost: on a Japanese seller's stream, yellow **Post fees** badges appear under the yen prices, and a **Post fees calculator** box sits beside the video.

You can drag both boxes by their headers. They remember where you put them.

## Updates

Tampermonkey checks for new versions once a day and installs them on its own. To update straight away, use **Check for userscript updates** in Tampermonkey's menu.

## Troubleshooting

| What you see | What to do |
|---|---|
| Nothing on Whatnot at all | Check step 2, then open the Tampermonkey dashboard and make sure both scripts are switched on. Reload the Whatnot tab. |
| Comps says "Sign in to pulsetcg.io" | Sign in at pulsetcg.io in this browser, then scan again. |
| Comps says "Pulse refused the request (403)" | Open pulsetcg.io once in a tab, then scan again. |
| Comps says "No card recognised" | The scanner needs a clear view of one card. Wait until the seller holds it up, or type the card instead. |
| The deal check says to turn on whatnot-landed-cost | Install the landed-cost script; yen listings are compared using its post-fees total. |
| Menu items show `¬£` instead of `£` | The script was pasted with the wrong encoding. Delete it in the Tampermonkey dashboard and reinstall from the link above. |

## Removing a script

Open the Tampermonkey dashboard, find the script and click the bin icon, or switch it off to keep it for later.

## More detail

[README.md](README.md) explains how each script works out its figures, where the prices come from, and its known limits.
