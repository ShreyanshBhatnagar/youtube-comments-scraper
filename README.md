# YouTube Comments Scraper — Fast, Replies Included, Hard Cost Cap

Extract comments **and full reply threads** from any public YouTube video — at **$0.90 per 1,000 comments**, with exact limits and a hard cost cap on every run.

No browser. No YouTube API key. No login. Plain HTTP against the same endpoints the YouTube website uses, so runs start instantly. Pagination is sequential — roughly one page of ~20 comments per request — so wall-clock time scales with page latency and reply volume rather than browser overhead.

## Why this Actor (honest comparison)

Numbers for the leading Store Actor (`streamers/youtube-comments-scraper`, 3,935 monthly users) read from Apify's public API on 2026-11-06; speed figure from an independent hands-on test.

| | This Actor | Leading incumbent |
|---|---|---|
| Price per 1,000 comments (free plan) | **$0.90** | $2.40 |
| Actor start fee | **None** | — |
| Replies | Included, same rate, linked to parent | Extra step / separate handling |
| Limit enforcement | Hard cap — never returns or charges beyond your max | — |
| Cost cap | Built-in `maxTotalChargeUsd` input | Console setting only |
| Speed | Sequential HTTP pagination, ~20 comments per request, no browser overhead | ~1.3 comments/sec (independent test: 75 comments in 57 s) |
| Pinned / hearted / creator flags | Included in every row | Partial |

## Input

| Field | Default | Notes |
|---|---|---|
| `videoUrls` | — (required) | Watch URLs, `youtu.be`, Shorts/live links, or bare video IDs. Up to 50 videos per run. |
| `maxCommentsPerVideo` | 100 | **Hard** cap on top-level comments per video. `0` = up to 10,000. |
| `includeReplies` | `true` | Turn off for top-level comments only. |
| `maxRepliesPerComment` | 10 | `0` = all available replies (safety ceiling 1,000). |
| `sortBy` | `top` | `top` (YouTube's relevance order) or `newest`. |
| `maxTotalChargeUsd` | 0 (off) | Run stops *before* the estimated charge passes this amount (estimated at the free-plan rate, so it is conservative on paid plans). |

```json
{
  "videoUrls": ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  "maxCommentsPerVideo": 500,
  "includeReplies": true,
  "maxRepliesPerComment": 20,
  "sortBy": "top",
  "maxTotalChargeUsd": 1
}
```

## What you get

One dataset row per comment or reply, with thread structure preserved:

| Field | Meaning |
|---|---|
| `commentId` | YouTube's unique comment ID |
| `text` | Full comment text |
| `authorName` | Commenter's handle (e.g. `@Oatman69`) |
| `authorChannelId` / `authorChannelUrl` | Commenter's channel |
| `authorIsVerified` | Verified-channel badge |
| `authorIsChannelOwner` | True when the video's creator wrote the comment |
| `likeCount` / `likeCountText` | Like count (numeric + YouTube's raw display string) |
| `replyCount` | Number of replies on a top-level comment |
| `publishedTimeText` | YouTube's relative time (`6 years ago`) |
| `publishedAtEstimate` | ISO timestamp estimated from the relative time |
| `isPinned` | Best-effort pinned detection |
| `isHearted` | Creator gave the comment a heart |
| `isReply` / `parentCommentId` | Thread linkage — replies point at their parent |
| `videoId` / `videoTitle` / `videoChannelName` | Source video |
| `commentUrl` | Direct link that opens YouTube scrolled to the comment |
| `scrapedAt` | ISO timestamp of the scrape |

## Pricing

Pay per event — you pay only for rows actually written to your dataset:

- **`comment-scraped`: $0.0009 per comment or reply** on the free plan ($0.90 per 1,000), with volume tiers down to $0.00035 on higher plans (see `pricing.json`).
- **No Actor-start fee.** Error rows (bad URL, disabled comments) are **never charged**.
- Filtered by your caps = never fetched = never charged. The Actor enforces limits in code, before fetching — you will not pay for over-fetching.

Usage from the API:

```python
from apify_client import ApifyClient

client = ApifyClient("<YOUR_API_TOKEN>")
run = client.actor("<username>/youtube-comments-scraper").call(run_input={
    "videoUrls": ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    "maxCommentsPerVideo": 200,
    "includeReplies": True,
    "maxTotalChargeUsd": 1,
})
for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(item["authorName"], item["text"])
```

## Limits & honesty

- YouTube shows comments in pages of ~20; a video's full history can be very long. Your caps decide how deep the run goes — it never exceeds them.
- `publishedAtEstimate` is computed from YouTube's relative display time (YouTube does not publish exact timestamps), so treat it as approximate to the stated unit.
- `likeCount` is parsed from YouTube's display value (`570K` → `570000`); `likeCountText` keeps the raw string.
- Comments disabled on a video, or a deleted/private video, produce one error row (free) and the run continues with the next video.
- Very large runs can hit YouTube rate limits; the Actor retries with backoff. If a page ultimately fails, the run keeps everything collected so far.

## Use cases

- **Audience & product research** — mine questions, complaints and feature requests from your niche's videos, threads intact.
- **Competitor monitoring** — schedule daily runs on launch videos; new-comment spikes surface in your dataset.
- **Comment moderation sampling** — pull newest-first comments for review queues.
- **Dataset building** — sentiment/NLP corpora with authors, likes and thread structure.

## Data & legality

This Actor reads only **public** comments that YouTube shows to logged-out visitors — no accounts, no cookies, no personal data beyond what is publicly displayed next to each comment. Use the output in line with YouTube's Terms of Service and your local privacy laws (comment authors are people; don't republish personal data without a lawful basis). Not affiliated with YouTube or Google.

## Support & maintenance

Issues are tracked on this repository. The parser is written as a generic extractor over YouTube's response structure (not fixed screen positions), and the live test in `test/` is re-run against YouTube on every release to catch upstream changes early.
