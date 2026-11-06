import { Actor, log } from 'apify';
import { YouTubeCommentsClient, parseVideoId } from './youtube.js';

// Pay-per-event price of the `comment-scraped` event on the FREE plan (see pricing.json).
// Used only to enforce the in-Actor maxTotalChargeUsd estimate cap; paid plans pay less
// per event, so this estimate is conservative (the run stops earlier, never later).
const FREE_PLAN_EVENT_PRICE_USD = 0.0009;
const CHARGE_EVENT = 'comment-scraped';
const REPLY_CONCURRENCY = 4;
const MAX_VIDEOS = 50;
// Actor.charge only works on the Apify platform; locally it always throws.
// Use the run-id env var (set on every platform run) to tell a real charge
// failure apart from the expected local one.
const ON_PLATFORM = Boolean(process.env.APIFY_ACTOR_RUN_ID);

await Actor.init();

const input = (await Actor.getInput()) || {};
const rawUrls = [
    ...(Array.isArray(input.videoUrls) ? input.videoUrls : []),
    ...(Array.isArray(input.startUrls) ? input.startUrls.map((u) => (typeof u === 'string' ? u : u?.url)) : []),
].filter(Boolean);

// Coerce numeric inputs defensively: API callers can pass strings or junk,
// and NaN comparisons would silently turn a video into an empty "success".
function numOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
const maxCommentsRaw = numOr(input.maxCommentsPerVideo, 100);
const maxCommentsPerVideo = maxCommentsRaw === 0
    ? 10000
    : Math.min(Math.max(1, Math.floor(maxCommentsRaw)), 10000);
const includeReplies = input.includeReplies !== false;
const maxRepliesRaw = numOr(input.maxRepliesPerComment, 10);
const maxRepliesPerComment = maxRepliesRaw === 0
    ? 1000
    : Math.min(Math.max(0, Math.floor(maxRepliesRaw)), 1000);
const sortBy = input.sortBy === 'newest' ? 'newest' : 'top';
const maxTotalChargeUsd = numOr(input.maxTotalChargeUsd, 0) > 0 ? numOr(input.maxTotalChargeUsd, 0) : 0;

const stats = {
    videosRequested: rawUrls.length,
    videosProcessed: 0,
    videosFailed: 0,
    videosSkipped: 0,
    videosTruncated: 0,
    commentsEmitted: 0,
    topLevelEmitted: 0,
    repliesEmitted: 0,
    duplicatesSkipped: 0,
    repliesTruncated: 0,
    sortFallbacks: 0,
    initFailed: false,
    estimatedChargeUsd: 0,
    stoppedByChargeCap: false,
    stoppedByChargeError: false,
};

let pendingCharges = 0;
let chargeHalt = false;

async function flushCharges() {
    if (pendingCharges <= 0) return;
    const count = pendingCharges;
    try {
        await Actor.charge({ eventName: CHARGE_EVENT, count });
        pendingCharges = 0;
    } catch (err) {
        if (!ON_PLATFORM) {
            log.warning(`Actor.charge failed outside the Apify platform (ignored): ${err.message}`);
            pendingCharges = 0;
            return;
        }
        // A real on-platform failure (platform cap reached, transient API
        // error): retry once, then stop emitting rather than keep delivering
        // rows that will never be charged.
        log.warning(`Actor.charge failed on platform, retrying once: ${err.message}`);
        try {
            await Actor.charge({ eventName: CHARGE_EVENT, count });
            pendingCharges = 0;
        } catch (err2) {
            log.error(`Actor.charge failed twice (${err2.message}); stopping the run to avoid uncharged delivery.`);
            chargeHalt = true;
            stats.stoppedByChargeError = true;
        }
    }
}

async function chargeFor(n) {
    pendingCharges += n;
    stats.estimatedChargeUsd = +(stats.commentsEmitted * FREE_PLAN_EVENT_PRICE_USD).toFixed(4);
    if (pendingCharges >= 25) await flushCharges();
}

function chargeCapReached() {
    return maxTotalChargeUsd > 0
        && (stats.commentsEmitted + 1) * FREE_PLAN_EVENT_PRICE_USD > maxTotalChargeUsd;
}

function stopRequested() {
    return chargeHalt || chargeCapReached();
}

// Initialise the innertube session. If this fails (YouTube rate-limiting the
// very first request is the common case), the run must NOT die: degrade to
// one error row per video, still write OUTPUT, and exit cleanly.
let client = null;
let initError = null;
try {
    client = await new YouTubeCommentsClient().init();
} catch (err) {
    initError = err;
    stats.initFailed = true;
    log.error(`YouTube session initialisation failed: ${err.message}. All videos will be reported as error rows.`);
}

const videoUrls = rawUrls.slice(0, MAX_VIDEOS);
if (rawUrls.length > MAX_VIDEOS) {
    stats.videosSkipped += rawUrls.length - MAX_VIDEOS;
    log.warning(`Input has ${rawUrls.length} URLs; only the first ${MAX_VIDEOS} are processed (${stats.videosSkipped} skipped).`);
}
const seenInputVideoIds = new Set();

outer:
for (const rawUrl of videoUrls) {
    const videoId = parseVideoId(rawUrl);
    if (!videoId) {
        stats.videosFailed++;
        await Actor.pushData({ videoUrl: rawUrl, error: 'Could not extract a YouTube video ID from this input.' });
        continue;
    }
    if (seenInputVideoIds.has(videoId)) {
        stats.videosSkipped++;
        log.info(`Skipping duplicate input video ${videoId}.`);
        continue;
    }
    seenInputVideoIds.add(videoId);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    if (!client) {
        stats.videosFailed++;
        await Actor.pushData({ videoId, videoUrl, error: `Failed to initialise YouTube session: ${initError.message}` });
        continue;
    }
    let opened;
    try {
        opened = await client.openVideo(videoId);
    } catch (err) {
        stats.videosFailed++;
        log.error(`Failed to open video ${videoId}: ${err.message}`);
        await Actor.pushData({ videoId, videoUrl, error: `Failed to load video: ${err.message}` });
        continue;
    }
    const { sortTokens, videoTitle, videoChannelName } = opened;
    let token = (sortBy === 'newest' && sortTokens.newest) || opened.sectionToken || sortTokens.top;
    if (sortBy === 'newest' && !sortTokens.newest) {
        stats.sortFallbacks++;
        log.warning(`Newest-first sort token not found for ${videoId}; falling back to default (Top) order.`);
    }
    if (!token) {
        stats.videosFailed++;
        await Actor.pushData({ videoId, videoUrl, error: 'No comments section found (comments may be disabled for this video).' });
        continue;
    }

    const video = { videoId, videoTitle, videoChannelName };
    // IDs of every row emitted for this video (parents and replies). Pages
    // overlap under "top" sort, so anything already in this set is skipped
    // before emit AND before charge — duplicates are never charged.
    const emittedIds = new Set();
    const seenPageTokens = new Set();
    let topLevelCount = 0;
    let emittedThisVideo = 0;
    let videoFailed = false;

    while (token && topLevelCount < maxCommentsPerVideo) {
        if (chargeCapReached()) {
            stats.stoppedByChargeCap = true;
            log.info(`Stopping: maxTotalChargeUsd cap (~$${maxTotalChargeUsd}) reached.`);
            break outer;
        }
        if (chargeHalt) break outer;
        if (seenPageTokens.has(token)) {
            log.warning(`Comments page token repeated for ${videoId}; stopping pagination for this video.`);
            stats.videosTruncated++;
            await Actor.pushData({ videoId, videoUrl, error: `Truncated after ${emittedThisVideo} rows: comments page token repeated.` });
            break;
        }
        seenPageTokens.add(token);
        let page;
        try {
            page = await client.fetchPage(token);
        } catch (err) {
            log.error(`Failed to fetch comments page for ${videoId}: ${err.message}`);
            // Leave a trace: a marker row when partial data exists, a plain
            // error row (and a failed count) when nothing was collected.
            if (emittedThisVideo > 0) {
                stats.videosTruncated++;
                await Actor.pushData({ videoId, videoUrl, error: `Truncated after ${emittedThisVideo} rows: ${err.message}` });
            } else {
                videoFailed = true;
                await Actor.pushData({ videoId, videoUrl, error: `Failed to load comments: ${err.message}` });
            }
            break;
        }
        token = page.nextToken;
        const threads = page.threads.slice(0, maxCommentsPerVideo - topLevelCount);
        if (threads.length === 0) break;

        // Fetch replies for this page's threads with bounded concurrency, emit in order.
        // The charge cap is consulted BEFORE any reply fetching starts, between
        // batches, and inside fetchReplies before every reply page.
        const repliesByIndex = new Map();
        if (includeReplies && maxRepliesPerComment > 0 && !stopRequested()) {
            const jobs = [];
            threads.forEach((t, idx) => {
                const replyTotal = page.payloads.get(t.commentId)?.toolbar?.replyCount;
                const hasReplies = t.repliesToken && (replyTotal == null || Number(replyTotal) > 0 || t.viewRepliesCount);
                if (hasReplies) jobs.push({ idx, t });
            });
            for (let i = 0; i < jobs.length; i += REPLY_CONCURRENCY) {
                if (stopRequested()) break;
                const batch = jobs.slice(i, i + REPLY_CONCURRENCY);
                const results = await Promise.all(batch.map(async ({ idx, t }) => {
                    const res = await client.fetchReplies({
                        token: t.repliesToken,
                        parentCommentId: t.commentId,
                        cap: maxRepliesPerComment,
                        video,
                        shouldStop: stopRequested,
                    });
                    if (res.truncated) {
                        stats.repliesTruncated++;
                        log.warning(`Replies for comment ${t.commentId} truncated: ${res.errorMessage}`);
                    }
                    return { idx, replies: res.replies };
                }));
                for (const { idx, replies } of results) repliesByIndex.set(idx, replies);
            }
        }

        for (let idx = 0; idx < threads.length; idx++) {
            const t = threads[idx];
            if (chargeCapReached()) {
                stats.stoppedByChargeCap = true;
                log.info(`Stopping: maxTotalChargeUsd cap (~$${maxTotalChargeUsd}) reached.`);
                break outer;
            }
            if (chargeHalt) break outer;
            const mapped = client.mapComment(page.payloads.get(t.commentId), t.legacy, { ...video, parentCommentId: null });
            let parentAvailable = false;
            if (mapped) {
                if (emittedIds.has(mapped.commentId)) {
                    stats.duplicatesSkipped++;
                    parentAvailable = true; // emitted on an earlier page; its replies still belong to it
                } else {
                    await Actor.pushData(mapped);
                    emittedIds.add(mapped.commentId);
                    stats.commentsEmitted++;
                    stats.topLevelEmitted++;
                    emittedThisVideo++;
                    topLevelCount++;
                    parentAvailable = true;
                    await chargeFor(1);
                }
            } else {
                // Never emit a thread's replies without its parent row: the
                // dataset would contain orphans pointing at a missing parent.
                log.warning(`Comment ${t.commentId} could not be mapped; skipping it and its replies to keep threads intact.`);
            }
            if (!parentAvailable) continue;

            const replies = repliesByIndex.get(idx) || [];
            for (const reply of replies) {
                if (chargeCapReached()) {
                    stats.stoppedByChargeCap = true;
                    log.info(`Stopping: maxTotalChargeUsd cap (~$${maxTotalChargeUsd}) reached.`);
                    break outer;
                }
                if (chargeHalt) break outer;
                if (emittedIds.has(reply.commentId)) {
                    stats.duplicatesSkipped++;
                    continue;
                }
                await Actor.pushData(reply);
                emittedIds.add(reply.commentId);
                stats.commentsEmitted++;
                stats.repliesEmitted++;
                emittedThisVideo++;
                await chargeFor(1);
            }
        }
    }
    if (videoFailed) {
        stats.videosFailed++;
    } else {
        stats.videosProcessed++;
        log.info(`Video ${videoId}: done (${topLevelCount} top-level comments this video).`);
    }
}

await flushCharges();

await Actor.setValue('OUTPUT', stats);
log.info(`Run finished: ${JSON.stringify(stats)}`);
await Actor.exit();
