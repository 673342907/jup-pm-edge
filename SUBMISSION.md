# Submission package: pm-edge → Solana "Perps and Prediction Markets" hackathon

## Target

| | |
|---|---|
| Listing | https://hackathons.solana.com/hackathons/perps-and-prediction-markets |
| Organiser / payer | Solana Foundation (main track). Sponsor bounties are paid from on-chain USDC escrow |
| Status (checked 2026-11-24 ~11:50 UTC+8) | **SCHEDULED**: "Launches Dec 1, 2026 · in 7 days", 799 registered, 0 submissions. Registration is open now |
| Build window / deadline | Perps page: "One week to build" from Dec 1, 2026; hub "How it works": 14 days from launch. The exact closing time is **not yet published**. Re-check it on Dec 1 and convert to UTC+8 |
| Prize structure | $101,000 total. Main track $100,000: 1st $50,000 · 2nd $30,000 · 3rd $20,000. Sponsor bounty "Best use of the pm-AMM by PREDICT" is a $1,000 *investment*, judged mostly on traction. OrbitFlare gives free RPC for a week (no prize) |
| Eligibility (platform rules, from the sister Stocklana page) | Individuals or teams, one submission per team, original work, "open-source components are fine if you say so". Submit at least one link: GitHub, live demo, or video. Edits are allowed until close |
| Judging (platform standard, from Stocklana; the Perps page has not posted its own yet) | "Could this be a real app that people will actually use?" Real user and problem · working end-to-end demo · reason it belongs on Solana · quality of execution |
| Region / payout | Global online. Winners are contacted through the site for payout. No US-only or in-person requirement is stated. Note: Jupiter's Prediction API blocks US and South Korea IPs. Mainland China is not on that list, but the user's network path to api.jup.ag should be confirmed |

### Why this target, not a Superteam Earn bounty

The live Superteam Earn scan is in `../SCAN.md`. On 2026-11-24 the site had 12 open listings, and the 3 in
Development all reward something other than code quality:

- **MultiHopper**: $5k USDC, requires ≥ $100k production volume per product.
- **OOBE Steve Capital**: $500 split 8 ways, 626 submissions, ranked by Arena XP and trading volume, and needs a funded agent wallet.
- **SSR.FUN**: $300, ranked by trading volume or PnL.

The other 9 are content or feedback tasks. No open technical bounty rewards a strong code submission, so the best
verified, China-compatible code competition with an open registration is this $100k Solana Foundation hackathon.

### Prior-work disclosure (build window opens Dec 1, 2026)

What the official pages say (re-checked 2026-11-24 ~11:50 UTC+8):

- The Perps page: "Launches Dec 1, 2026", "One week to build". The hub's *How it works* page says "You have 14
  days from launch to submission deadline". The two disagree, so read the deadline on the page on Dec 1 and convert it to UTC+8.
- *How it works* lists what to submit: GitHub repo, live demo (devnet or mainnet), pitch video (3 min max),
  technical video (5 min), all optional. "Projects are private until after judging."
- Neither page publishes a rule about work done before launch. The Stocklana page (same platform) said
  original work, and "open-source components are fine if you say so". **No explicit prior-work rule has been
  published for this hackathon yet. Check the page on Dec 1 before submitting.**

pm-edge was written **before** Dec 1, so the submission must say so in plain words, and in-window work must be
separable:

| git ref | date (UTC+8) | contents |
|---|---|---|
| `08f1042` | 2026-11-24 09:54 | scanner core: complete-set builder, venue exclusivity checks, depth sizing, fees, integrity, CLI, tests |
| dashboard commit (see `git log`) | 2026-11-24 | web desk, wallet flow, safety review, server API, static demo, UI tests |

Before Dec 1, tag the last pre-window commit (`git tag pre-window-2026-11-30`) and push the tag with the repo.
Judges can then diff `pre-window-2026-11-30..main` to see exactly what was built during the hackathon. If the
rules turn out to require all work inside the window, enter pm-edge as a disclosed MIT open-source component and
present only the in-window diff as the entry.

## Criteria → deliverable map

| Criterion | Where pm-edge meets it |
|---|---|
| Real user and real problem | Prediction traders and bots on Jupiter Prediction. Complete-set arbitrage is the textbook trade, and 877 of 937 tempting baskets in today's live scan are traps that would lose money. The dashboard shows each one and why |
| Working end-to-end demo | `npm start` → scan → stake calculator on live books → wallet connect → unsigned Jupiter orders → simulate or sign. A judge can run the whole flow in 30 s with a watch-only key and no funds, or open `samples/demo.html` with no install |
| Why it belongs on Solana | One Solana wallet reaches Polymarket and Kalshi liquidity through Jupiter. pm-edge builds the real Jupiter `POST /prediction/v1/orders` transactions, decodes them before signing, simulates on Solana RPC, and executes via wallet signing + Jupiter `/execute` |
| Quality of execution | Zero runtime dependencies, strict TypeScript (`tsc --noEmit` 0 errors), 60 offline tests + 2 live + a headless-Chrome UI test, fee model pinned to all 18 published values, one safety review shared by browser and server, fails closed |
| Safety | No keys ever; traps hard-blocked server-side; per-tx fee-payer check; $5 minimum, stake cap, loss acknowledgement; partial-fill risk disclosed |
| Honest numbers | Today: 0 fee-positive sets (closest −$0.42). Jupiter is within ±1¢ of the native venue on 100% of 80 sampled markets. Reported as found, not dressed up |

## Hackathon-window plan (Dec 1 → close)

Done before the window (disclosed above): scanner, dashboard, wallet dry-run/live flow, static demo.
In-window work, each a separate commit after the `pre-window` tag:

1. **Fill tracking:** poll Jupiter order status after `/execute` and show per-leg fills and the resulting position in the drawer.
2. **Alerts:** `watch` → Telegram/X push when an ARB ≥ $X net appears, with a deep link straight into the drawer.
3. **Cross-venue matching:** pair the same real-world event across Polymarket- and Kalshi-sourced Jupiter markets, under the same exclusivity discipline.
4. **Exit flow:** sell or redeem complete sets (`isBuy:false` with contract quantities) from the same drawer.
5. Record the 2-minute video (script below) from a non-US/KR connection with a small funded wallet for one live leg.

## Ready-to-paste submission text

**Project name:** pm-edge: the complete-set scanner that knows which "arbs" are traps

**One-liner:** A dark-mode trading desk for Jupiter Prediction Markets on Solana: finds complete-set arbitrage net of live depth and fees, proves which "arbs" are traps, and lets your own wallet sign the real Jupiter orders, which it hard-blocks on traps.

**Description:**
> Jupiter Prediction puts Polymarket and Kalshi liquidity behind a single Solana wallet. That makes the classic
> prediction-market trade, buying every outcome for less than it pays, executable on Solana. It also makes it
> easy to blow up: in our live scan of 3,039 events and 30,587 open markets, 937 baskets looked mispriced, and
> 877 of them priced below their payout. None were real complete sets. They were cumulative "by date…" ladders
> (820) or Polymarket negRiskAugmented events whose placeholder outcomes can win (117).
>
> pm-edge builds every complete-set basket, checks each one against the source venue (Polymarket negRisk /
> negRiskAugmented, Kalshi mutually_exclusive, full outcome list), walks the live Jupiter order book of every leg,
> and prices any stake net of Jupiter's fee curve (reproduced exactly from the 18 published values) and the $5
> per-leg minimum. The web desk shows it all: KPIs, a sortable sets table, traps with a plain-English "why a naive
> bot loses", a venue-parity audit, and a stake calculator from $25 to $500.
>
> Execution is wallet-native and key-free. Connect Phantom, Solflare or any Wallet Standard wallet; pm-edge builds
> the real unsigned Jupiter `POST /orders` transactions, decodes each one to check your wallet is the fee payer,
> runs a pre-sign safety review, and then either simulates on Solana RPC (dry-run, zero funds) or asks your wallet to
> sign and relays to Jupiter `/execute` (live). Trap baskets are hard-blocked by the same review on the server, so
> a modified client cannot get around it.
>
> Zero runtime dependencies, strict TypeScript, 60 offline tests + 2 live + a headless-browser UI test, MIT.

**Links:** GitHub `<repo URL>` · static demo `<Pages URL for site/index.html>` · pitch video `<URL>`
**Prior-work disclosure (paste into the form):** "pm-edge's scanner and dashboard were built before the Dec 1 launch
(commits up to tag `pre-window-2026-11-30`, MIT). Everything after that tag was built during the hackathon: <list>."

## 2-minute demo video script

| time | screen | voice-over |
|---|---|---|
| 0:00–0:15 | dashboard KPIs | "Jupiter puts Polymarket and Kalshi behind one Solana wallet. Buy every outcome for under a dollar and you lock in profit. That's the theory. This is pm-edge, scanning 3,039 live events." |
| 0:15–0:40 | Rejected traps → expand the first row | "937 baskets look like free money. 877 cost less than their payout. Not one is a complete set. This one is a 'by date' ladder: both dates can resolve NO, so a naive bot pays $0.02 for a dollar it never gets. pm-edge checks every basket against the source venue." |
| 0:40–1:05 | Genuine sets → open the closest set → drag stake $25 → $500 | "These are real complete sets. Live order books, Jupiter's fee curve, the $5 minimum: at $25 we're cents under water, at $500 depth pushes it further. Today there's no free lunch, and pm-edge tells you that honestly." |
| 1:05–1:35 | Use watch-only key → Build unsigned orders → Simulate | "Dry-run. These are real unsigned Jupiter transactions. pm-edge decodes each one, checks my wallet is the fee payer, and simulates on Solana RPC. Nothing is signed, no funds needed." |
| 1:35–1:50 | open a trap → Live wallet signing | "Now try to execute a trap live. Blocked, here and on the server. The wallet is never even asked." |
| 1:50–2:00 | Connect Phantom → Live → Sign & execute (or show the confirm dialog) | "Genuine and positive? Your wallet signs, Jupiter executes. pm-edge never touches a key. Open source, demo link below." |

Record from a non-US/KR connection: from a blocked region Jupiter returns `unsupported_region` on build, and the UI
shows that message along with the exact request body.

## Exact steps for the user (about 2 minutes now, then on Dec 1)

1. Create a public GitHub repo, e.g. `pm-edge`, then from the box:
   ```bash
   cd /workspace/offchain/superteam-bounty/jup-pm-edge
   git remote add origin git@github.com:<you>/pm-edge.git   # or https://github.com/<you>/pm-edge.git
   git push -u origin main
   ```
   (The local repo is already initialised and committed. Before Dec 1: `git tag pre-window-2026-11-30 && git push --tags`.)
2. Publish the static demo: GitHub Pages from `site/`, or `npx wrangler deploy` (Cloudflare static assets, `wrangler.toml`).
3. Go to https://hackathons.solana.com/hackathons/perps-and-prediction-markets, sign in (wallet or Google), and **Register**.
4. On/after **Dec 1, 2026**, click **Submit Project**: paste the name, one-liner, and description above, add the GitHub URL (plus video and dashboard links when ready), add the prior-work disclosure, and select the main track.
5. Payout: the main track is paid by the Solana Foundation, which contacts winners through the site. Keep a dedicated Solana wallet ready for USDC.
