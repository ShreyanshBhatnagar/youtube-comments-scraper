# Publish state — YouTube Comments Scraper (checked 2026-11-06)

## Status: publish-ready, blocked at the account step

Everything that does not require Shreyansh's identity is done:

- ✅ Actor built and tested locally (unit 20/20, live 15/15 — see PLAN.md)
- ✅ README, input schema, output schema, pricing values (pricing.json)
- ✅ Local git repo initialised, initial commit `827f6ca`, clean tree

## Wall 1 — GitHub remote (repo creation)

The Muse GitHub App integration can read/search/push to existing repos but
**cannot create repositories**: `create_repository` → HTTP 403
"Resource not accessible by integration" (verified 2026-11-06, after
user confirmation of the call).

Unblock (one-time, ~30 seconds, human): create an **empty** public repo named
`youtube-comments-scraper` under github.com/ShreyanshBhatnagar, then the
content goes up in a single snapshot push (`push_files`) and the repo becomes
the Apify build source. Alternatives if repo creation is ever enabled for the
integration: nothing else changes — just retry the push.

## Wall 2 — Apify account (the publish step itself)

Every remaining publish step happens inside an Apify account
(Console → Development → My Actors → Publishing → Publish on Store).
Creating that account is a GitHub/Google OAuth signup **in his name**, which
this task forbids. Stopped there; no account was created.

Once an account exists, the remaining steps are mechanical and free:
connect this GitHub repo (or `apify push` with the account's API token),
build, run once, fill the Publishing tab from the files in this repo
(README renders automatically; monetization values in `pricing.json`),
click **Publish on Store**.

## Verified publish requirements (Apify's own docs, read 2026-11-06)

Sources: docs.apify.com/actors/publishing/publish, /actors/monetize,
/actors/monetize/monthly-payouts, /actors/monetize/set-up-monetization.

- **No paid plan is required to publish or monetize.** The publishing doc's
  prerequisites are only: accept the Store Publishing Terms, build + run the
  Actor at least once, README, input + output schemas.
- **The $1/mo Creator plan is optional** — it only grants $500 of prepaid
  usage to test your own Actors during the first 6 months. It is NOT a
  publish gate. (This settles the question the research report left open;
  the free plan — $0, $5/mo usage, no card — can publish.)
- **Identity verification is NOT required to publish this Actor**: KYC is
  required only if an Actor needs full permissions or you publish >10
  Actors. This Actor uses limited permissions (plain HTTPS fetches).
- **KYC + billing details are required only at payout**: legal name matching
  a photo ID, payment method. Payouts are monthly (invoices on the 11th,
  paid days 21–25), minimums **$20 PayPal/Wise, $100 bank**; earnings roll
  over month to month until verified/threshold met. Apify keeps 20%; PPE
  platform-usage costs are deducted from the payout with the month's profit
  floored at $0 (you can never owe Apify).
- Optional later step: developer KYC also unlocks agentic (x402) payments
  eligibility for PPE Actors with limited permissions.
- Pricing changes that increase prices / add paid events are limited to
  once per month with user notice — the launch prices in pricing.json are
  set to stay.
