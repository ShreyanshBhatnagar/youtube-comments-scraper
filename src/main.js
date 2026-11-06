import { Actor, log } from 'apify';
import { YouTubeCommentsClient, parseVideoId } from './youtube.js';

// Pay-per-event price of the `comment-scraped` event on the FREE plan (see pricing.json).
// Used only to enforce the in-Actor maxTotalChargeUsd estimate cap; paid plans pay less
// per event, so this estimate is conservative (the run stops earlier, never later).
const FREE_PLAN_EVENT_PRICE_USD = 0.0009;
const CHARGE_EVENT = 'comment-scraped';
const REPLY_CONCURRENCY = 4;

await Actor.init();

const input = (await Actor.getInput()) || {};
const rawUrls = [
    ...(Array.isArray(input.videoUrls) ? input.videoUrls : []),
    ...(Array.isArray(input.startUrls) ? input.startUrls.map((u) => (typeof u === 'string' ? u : u?.url)) : []),
].filter(Boolean);

const maxCommentsPerVideo = input.maxCommentsPerVideo === 0
    ? 10000
    : Math.min(Math.max(1, input.maxCommentsPerVideo ?? 100), 10000);
const includeReplies = input.includeReplies !== false;
const maxRepliesPerComment = input.maxRepliesPerComment === 0
    ? 1000
    : Math.min(Math.max(0, input.maxRepliesPerComment ?? 10), 1000);
const sortBy = input.sortBy === 'newest' ? 'newest' : 'top';
const maxTotalChargeUsd = Number(input.maxTotalChargeUsd) > 0 ? Number(input.maxTotalChargeUsd) : 0;

const stats = {
    videosRequested: rawUrls.length,
    videosProcessed: 0,
    videosFailed: 0,
    commentsEmitted: 0,
    topLevelEmitted: 0,
    repliesEmitted: 0,
    estimatedChargeUsd: 0,
    stoppedByChargeCap: false,
};

let pendingCharges = 0;
async function chargeFor(n) {
    pendingCharges += n;
    stats.estimatedChargeUsd = +(stats.commentsEmitted * FREE_PLAN_EVENT_PRICE_USD).toFixed(4);
    if (pendingCharges >= 25) {
        const count = pendingCharges;
        pendingCharges = 0;
        try {
            await Actor.charge({ eventName: CHARGE_EVENT, count });
        } catch (err) {
            log.warning(`Actor.charge failed (ignored outside Apify platform): ${err.message}`);
        }
    }
}

function chargeCapReached() {
    return maxTotalChargeUsd > 0
        && (stats.commentsEmitted + 1) * FREE_PLAN_EVENT_PRICE_USD > maxTotalChargeUsd;
}

const client = await new YouTubeCommentsClient().init();

outer:
for (const rawUrl of rawUrls.slice(0, 50)) {
    const videoId = parseVideoId(rawUrl);
    if (!videoId) {
        stats.videosFailed++;
        await Actor.pushData({ videoUrl: rawUrl, error: 'Could not extract a YouTube video ID from this input.' });
        continue;
    }
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
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
    if (sortBy === 'newest' && !sortTokens.newest && opened.sectionToken) {
        log.warning(`Newest-first sort token not found for ${videoId}; falling back to default (Top) order.`);
    }
    if (!token) {
        stats.videosFailed++;
        await Actor.pushData({ videoId, videoUrl, error: 'No comments section found (comments may be disabled for this video).' });
        continue;
    }

    const video = { videoId, videoTitle, videoChannelName };
    let topLevelCount = 0;

    while (token && topLevelCount < maxCommentsPerVideo) {
        let page;
        try {
            page = await client.fetchPage(token);
        } catch (err) {
            log.error(`Failed to fetch comments page for ${videoId}: ${err.message}`);
            break;
        }
        token = page.nextToken;
        const threads = page.threads.slice(0, maxCommentsPerVideo - topLevelCount);
        if (threads.length === 0) break;

        // Fetch replies for this page's threads with bounded concurrency, emit in order.
        const repliesByIndex = new Map();
        if (includeReplies && maxRepliesPerComment > 0) {
            const jobs = [];
            threads.forEach((t, idx) => {
                const replyTotal = page.payloads.get(t.commentId)?.toolbar?.replyCount;
                const hasReplies = t.repliesToken && (replyTotal == null || Number(replyTotal) > 0 || t.viewRepliesCount);
                if (hasReplies) jobs.push({ idx, t });
            });
            for (let i = 0; i < jobs.length; i += REPLY_CONCURRENCY) {
                const batch = jobs.slice(i, i + REPLY_CONCURRENCY);
                const results = await Promise.all(batch.map(async ({ idx, t }) => {
                    try {
                        const replies = await client.fetchReplies({
                            token: t.repliesToken,
                            parentCommentId: t.commentId,
                            cap: maxRepliesPerComment,
                            video,
                        });
                        return { idx, replies };
                    } catch (err) {
                        log.warning(`Replies fetch failed for comment ${t.commentId}: ${err.message}`);
                        return { idx, replies: [] };
                    }
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
            const mapped = client.mapComment(page.payloads.get(t.commentId), t.legacy, { ...video, parentCommentId: null });
            if (mapped) {
                await Actor.pushData(mapped);
                stats.commentsEmitted++;
                stats.topLevelEmitted++;
                await chargeFor(1);
            }
            topLevelCount++;

            const replies = repliesByIndex.get(idx) || [];
            for (const reply of replies) {
                if (chargeCapReached()) {
                    stats.stoppedByChargeCap = true;
                    log.info(`Stopping: maxTotalChargeUsd cap (~$${maxTotalChargeUsd}) reached.`);
                    break outer;
                }
                await Actor.pushData(reply);
                stats.commentsEmitted++;
                stats.repliesEmitted++;
                await chargeFor(1);
            }
        }
    }
    stats.videosProcessed++;
    log.info(`Video ${videoId}: done (${topLevelCount} top-level comments this video).`);
}

if (pendingCharges > 0) {
    try {
        await Actor.charge({ eventName: CHARGE_EVENT, count: pendingCharges });
    } catch (err) {
        log.warning(`Actor.charge failed (ignored outside Apify platform): ${err.message}`);
    }
    pendingCharges = 0;
}

await Actor.setValue('OUTPUT', stats);
log.info(`Run finished: ${JSON.stringify(stats)}`);
await Actor.exit();
