# Apify Actor — niche pick & plan

**Pick: YouTube Comments Scraper — cheaper, faster, replies included, hard cost caps.**
**Date picked:** 2026-11-06 · **Method:** report §3 Top‑1 step 1 — mine incumbent Store Actors'
stats, pricing and complaints; target the exact gap. All Store numbers below were read live on
2026-11-06 from Apify's public API (`api.apify.com/v2/store` search + `api.apify.com/v2/acts/{actor}`),
not from blog posts.

## Demand evidence (proven, platform data)

YouTube data is one of the Store's biggest proven money categories:

| Incumbent | Users (30d) | Total runs | Rating | Price (FREE plan) |
|---|---|---|---|---|
| `streamers/youtube-comments-scraper` | **3,935** | 1,073,075 | 4.9 (42 reviews) | **$2.40 / 1,000 comments** (tiered FREE $0.0024; use-apify's 2026‑09‑10 snapshot: $2.00) |
| `apidojo/youtube-comments-scraper` | 1,256 | 1,299,153 | 4.84 (12 reviews) | pay-per-event |
| `supreme_coder/youtube-comment-scraper` | 243 | 15,908 | 5.0 | pay-per-event |
| `solidcode/youtube-comments-scraper` | 207 | 11,097 | 5.0 | pay-per-event |
| `streamers/youtube-scraper` (adjacent, video data) | 17,359 | — | 4.81 | $4.00 / 1,000 videos |

Category total ≈ **5,700 monthly active users** on comment Actors alone, with the leader holding
23,000+ total users. This is not imagined demand — it is a running market with a dominant,
premium-priced incumbent.

## The underserved gaps (what incumbents get complained about)

1. **Price.** A tested third-party comparison (marketerrakib.com, hands-on run) lists the
   incumbent's cost as its main con: *"You pay per result ($1.80 for 1,000 comments), so the cost
   can add up for high-volume scraping."* For calibration, app-review Actors doing comparable
   HTTP work charge **$0.09–$0.50 per 1,000 items** — YouTube comments are priced 4–25× higher.
2. **Speed.** The same hands-on test: the incumbent scraped **75 comments in 57 seconds
   (~1.3 comments/sec)**. The underlying YouTube innertube API returns ~20 comments per request
   in ~1 s, so 10–20 comments/sec is achievable with plain HTTP and modest parallelism.
3. **Cost control / limit respect.** A recurring complaint pattern against Store Actors
   (documented at length in G2 reviews of a major Twitter Actor): limits configured but not
   respected, over-fetching billed to the user, no cost safeguard. A competitor in the app-review
   niche (hiver, dev.to) markets `max_total_charge_usd` as a *headline feature* — buyers
   demonstrably select on hard caps.
4. **Reply threads.** The comment-mining use case (dev.to, "Comment mining for customer
   research") stresses keeping reply threads intact with parent linkage, plus pinned/hearted
   flags and top/newest sorting. Incumbents gate or surcharge pieces of this.

## The wedge (what we ship)

- **$0.90 per 1,000 comments** on the FREE plan — 55–62% under the leader — with volume tiers
  down to $0.35 (see `pricing.json`). Pay-per-event only, **no start fee** (a rival removed
  theirs in Oct 2026 and advertised it; it's a proven selling point).
- **Replies included at the same per-item rate** — one event type (`comment-scraped`), no
  separate reply surcharge; every row carries `parentCommentId` so threads stay intact.
- **Exact limits, enforced in code:** never emit or charge beyond `maxCommentsPerVideo`
  (top-level) / `maxRepliesPerComment`; `maxTotalChargeUsd` input stops the run before the
  estimated bill passes the cap.
- **Full field set at base price:** text, author + channel URL, like count, reply count,
  pinned/hearted/creator-heart flags, author-is-creator, relative + estimated publish time,
  comment URL, video title/channel.
- **Speed:** HTTP-only (innertube API), no browser, no user API key, no login; parallel reply
  fetching.

## Feasibility — verified before building

From this VM on 2026-11-06 (plain HTTPS, no proxies, no cookies):
- `youtube.com/watch?v=dQw4w9WgXcQ` → 1.4 MB page, `INNERTUBE_API_KEY` + comment continuation
  tokens extracted — **PASS**
- `POST youtubei/v1/next` with the comments continuation → 260 KB payload containing the
  comments section — **PASS**

Run-cost sanity: 1,000 comments ≈ 50 innertube page calls ≈ a few seconds of compute
(~$0.002–0.006 platform cost at $0.20/CU) against $0.90 list revenue. After Apify's 20% margin
and platform usage, the unit economics hold with wide headroom — which is exactly why the
incumbent can charge $2.40; we take share on price instead.

## Honest expectations & risks

- Modal outcome for a new Store Actor is still ~$0 (report §1a: mean ≈ $300/mo across ~5,600
  devs, heavily skewed, most tools earn close to nothing). This is a low-cost ticket in a proven
  market, not a promise.
- YouTube can rate-limit datacenter IPs under heavy volume and changes innertube shapes
  periodically → retries/backoff built in; maintenance loop = re-run the live test in `test/`
  and patch the parser (it is written as a generic recursive extractor to survive layout drift).
- Store discoverability is the real bottleneck after launch: README carries the comparison
  table above; the same repo doubles as the free GitHub distribution asset (report step 3).

## Pricing config

See `pricing.json` (pay-per-event, event `comment-scraped`, tiered by buyer plan).
Applied in Apify Console → Monetization at publish time (pricing is server-side on Apify,
not in `actor.json`).

## Outcome (2026-11-06)

- **Built & tested:** unit suite 20/20 PASS; live end-to-end suite 15/15 PASS
  (107 rows from one video incl. reply integrity; newest sort + error row;
  in-actor charge cap stopped at 11 rows on a $0.01 budget).
- **GitHub:** local repo committed (`827f6ca`); remote push blocked — the Muse
  GitHub App integration returns HTTP 403 on repository creation.
- **Apify publish:** blocked at account creation (OAuth signup in his name — out
  of scope for this task). Verified from Apify's own docs that no paid plan is
  required to publish/monetize and this Actor needs no KYC to publish; KYC +
  billing details are payout-stage only. Full details: `PUBLISH.md`.
