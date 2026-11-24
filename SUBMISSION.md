# Submission package: pm-edge → Solana "Perps and Prediction Markets" hackathon

## Target

| | |
|---|---|
| Listing | https://hackathons.solana.com/hackathons/perps-and-prediction-markets |
| Organiser / payer | Solana Foundation (main track). Sponsor bounties are paid from on-chain USDC escrow |
| Status (checked 2026-11-24 09:3x UTC+8) | **SCHEDULED**: "Launches Dec 1, 2026 · in 8 days", 799 registered, 0 submissions. Registration is open now |
| Build window / deadline | "One week to build" from Dec 1, 2026. The exact closing time was **not yet published** on the page. Re-check it on Dec 1 and convert to UTC+8 |
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

### Timing and rule caveat (be transparent)

Build time does not open until Dec 1. The rules seen so far allow open-source components if disclosed, and nothing
seen prohibits prior work, but **read the Perps page rules on Dec 1**. If they require all work inside the window,
submit pm-edge as a disclosed open-source component and present the week's new work (below) as the entry.

## Criteria → deliverable map

| Criterion | Where pm-edge meets it |
|---|---|
| Real user and real problem | Prediction traders and bots on Jupiter Prediction. Complete-set arbitrage is the textbook trade, and 869 of 937 tempting baskets in today's live scan are traps that would lose money (`samples/report.md` → "Traps rejected") |
| Working end-to-end demo | `node src/cli.ts scan --integrity-sample 40 --out samples` scans 3,039 live events and 31,035 open markets, checks 120 sets on live order books, checks 80 markets against Polymarket and Kalshi, and writes Markdown, HTML, and JSON (`samples/`) |
| Why it belongs on Solana | One Solana wallet reaches Polymarket and Kalshi liquidity through Jupiter. The tool builds Jupiter `POST /prediction/v1/orders` bodies (USDC mint) for each basket leg, ready for wallet signing |
| Quality of execution | Zero runtime dependencies, strict TypeScript, 30 offline tests on recorded live payloads plus 2 live tests, fee model pinned to all 18 published fee values, fails closed (UNVERIFIED / NO-DEPTH can never become ARB), bounded I/O with retry and concurrency limits |
| Honest numbers | Today: 0 fee-positive sets (closest −$0.43). Jupiter is within ±1¢ of the native venue on 100% of 80 sampled markets. Reported as found, not dressed up |

## Hackathon-week plan (Dec 1 → close) to compete for the main track

1. **Hosted live dashboard**: run `watch` on a cron and publish `report.html` (e.g. Cloudflare Pages + scheduled Worker), so judges get a URL rather than a CLI.
2. **One-click basket execution**: wallet-adapter page that takes an ARB row's `orders`, calls `POST /orders` per leg, has the user sign, and tracks fills through `GET /orders/status`. Keep it user-signed and non-custodial.
3. **Alerts**: Telegram or X push when `watch` finds an ARB ≥ $X net.
4. **Cross-venue matching** (stretch): pair the same real-world event across Polymarket- and Kalshi-sourced Jupiter markets, then run the same exclusivity discipline.
5. Record a 2-minute demo video (script below).

## Ready-to-paste submission text

**Project name:** pm-edge: the complete-set scanner that knows which "arbs" are traps

**One-liner:** Live, depth-aware, fee-exact complete-set arbitrage and price-integrity scanner for Jupiter Prediction Markets on Solana, which checks every basket against Polymarket and Kalshi before calling it free money.

**Description:**
> Jupiter Prediction puts Polymarket and Kalshi liquidity behind a single Solana wallet. That makes the classic
> prediction-market trade, buying every outcome for less than it pays, executable on Solana. It also makes it
> easy to blow up: in our live scan of 3,039 events and 31,035 open markets, 937 baskets looked mispriced, and
> 869 of them priced below their payout. None were real complete sets. They were cumulative "by date…" ladders
> (816) or Polymarket negRiskAugmented events whose placeholder outcomes can win (121).
>
> pm-edge builds every complete-set basket (YES+NO, split-condition pairs, all-YES and all-NO multi-outcome),
> checks each one against the source venue (Polymarket negRisk / negRiskAugmented, Kalshi mutually_exclusive,
> full outcome list), walks the live Jupiter order book of every leg, and sizes the trade net of Jupiter's fee
> schedule (reproduced exactly from the 18 published values) and the $5 per-leg minimum. It reports ROI and APR to
> close, and emits ready-to-sign `POST /prediction/v1/orders` bodies. It also measures whether Jupiter quotes
> track the native venues. Today they do: within ±1¢ on 100% of 80 sampled markets. The closest genuine set sits
> $0.43 under the fee floor, so `watch` mode exists to catch the moments when one venue moves first.
>
> Zero runtime dependencies, strict TypeScript, 32 tests (30 offline on recorded live payloads, 2 live), MIT.
> Read-only: it never touches keys.

**Links:** GitHub `<repo URL>` · demo video `<URL>` · live dashboard `<URL, after week 1>`
**Open-source disclosure:** pm-edge's scanner core was written before the build window opened and is MIT-licensed. Disclose this in the form and list the in-window work.

## 2-minute demo video script

1. (0:00) Problem: "Jupiter puts Polymarket and Kalshi behind one Solana wallet. Here is the classic arb, and why most of them are traps."
2. (0:20) Run `node src/cli.ts scan --integrity-sample 40 --out samples` and show the console summary.
3. (0:45) Open `report.html`: the trap table (AFC Asian Cup group F at $0.177 for $1, rejected as negRiskAugmented).
4. (1:10) The genuine sets table: book cost, fees, net, APR. Then integrity: ±1¢.
5. (1:30) `scan.json` → `orders` → `POST /prediction/v1/orders` → user signs. Show `npm test` green.
6. (1:50) Close on `watch` mode and the week-one roadmap.

## Exact steps for the user (about 2 minutes now, then on Dec 1)

1. Create a public GitHub repo, e.g. `pm-edge`, then from the box:
   ```bash
   cd /workspace/offchain/superteam-bounty/jup-pm-edge
   git remote add origin git@github.com:<you>/pm-edge.git   # or https://github.com/<you>/pm-edge.git
   git push -u origin main
   ```
   (The local repo is already initialised and committed.)
2. Go to https://hackathons.solana.com/hackathons/perps-and-prediction-markets, sign in (wallet or Google), and **Register**.
3. On/after **Dec 1, 2026**, click **Submit Project**: paste the name, one-liner, and description above, add the GitHub URL (plus video and dashboard links when ready), add the open-source disclosure, and select the main track.
4. Payout: the main track is paid by the Solana Foundation, which contacts winners through the site. Keep a dedicated Solana wallet ready for USDC.
