// YouTube innertube comments client — plain HTTPS, no API key, no login, no browser.
// Built against the live innertube shapes observed on 2026-11-06:
//  - POST /youtubei/v1/next {videoId} -> comments-section continuation + sort-menu tokens
//  - continuation pages arrive as reloadContinuationItemsCommand / appendContinuationItemsAction
//    with commentThreadRenderer items whose commentViewModel carries the commentId,
//    while the actual comment data lives in frameworkUpdates.entityBatchUpdate.mutations
//    as commentEntityPayload entries. A legacy commentRenderer fallback is included
//    so older response shapes still parse.

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function parseVideoId(input) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    const patterns = [
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/,
    ];
    for (const re of patterns) {
        const m = s.match(re);
        if (m) return m[1];
    }
    return null;
}

export function parseCount(text) {
    if (text == null) return 0;
    if (typeof text === 'number') return Math.round(text);
    const t = String(text).replace(/[,\s]/g, '');
    const m = t.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) {
        const n = parseInt(t, 10);
        return Number.isNaN(n) ? 0 : n;
    }
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
}

const REL_UNITS = {
    second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5,
    month: 2592e6, year: 31536e6,
};

export function estimatePublishedAt(publishedTimeText, nowMs = Date.now()) {
    if (!publishedTimeText) return null;
    const m = String(publishedTimeText).match(/(\d+)\s+(second|minute|hour|day|week|month|year)/i);
    if (!m) return null;
    const unit = REL_UNITS[m[2].toLowerCase()];
    if (!unit) return null;
    return new Date(nowMs - parseInt(m[1], 10) * unit).toISOString();
}

async function fetchText(url, { method = 'GET', body } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers: {
                    'User-Agent': UA,
                    'Accept-Language': 'en-US,en;q=0.9',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(30000),
            });
            if (res.status === 429 || res.status >= 500) {
                throw new Error(`HTTP ${res.status}`);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        }
    }
    throw lastErr;
}

function* walk(node) {
    if (!node || typeof node !== 'object') return;
    yield node;
    if (Array.isArray(node)) {
        for (const v of node) yield* walk(v);
    } else {
        for (const v of Object.values(node)) yield* walk(v);
    }
}

/** First continuationCommand token found anywhere in a subtree. */
function findContinuationToken(node) {
    for (const n of walk(node)) {
        const tok = n.continuationCommand?.token;
        if (typeof tok === 'string' && tok) return tok;
    }
    return null;
}

function runsText(node) {
    if (!node) return null;
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
    if (typeof node.content === 'string') return node.content;
    return null;
}

export class YouTubeCommentsClient {
    constructor() {
        this.apiKey = null;
        this.clientVersion = null;
        this.visitorData = null;
    }

    async init() {
        const html = await fetchText('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
        const ver = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
        if (!key) throw new Error('Could not extract INNERTUBE_API_KEY from youtube.com');
        this.apiKey = key[1];
        this.clientVersion = ver ? ver[1] : '2.20240111.09.00';
        return this;
    }

    context() {
        const client = {
            clientName: 'WEB',
            clientVersion: this.clientVersion,
            hl: 'en',
            gl: 'US',
        };
        if (this.visitorData) client.visitorData = this.visitorData;
        return { context: { client } };
    }

    async next(body) {
        const text = await fetchText(
            `https://www.youtube.com/youtubei/v1/next?key=${this.apiKey}&prettyPrint=false`,
            { method: 'POST', body: { ...this.context(), ...body } },
        );
        return JSON.parse(text);
    }

    /**
     * Load the watch-next payload for a video and locate:
     *  - the comments-section continuation token (default "Top" sort)
     *  - the sort-menu continuation tokens ({ top, newest })
     *  - video title / channel name (best effort)
     */
    async openVideo(videoId) {
        const resp = await this.next({ videoId });
        const vd = resp?.responseContext?.visitorData;
        if (vd && !this.visitorData) this.visitorData = vd;

        let sectionToken = null;
        let sortTokens = {};
        let videoTitle = null;
        let videoChannelName = null;

        for (const node of walk(resp)) {
            if (node.targetId === 'comments-section' && Array.isArray(node.contents)) {
                for (const item of node.contents) {
                    const tok = item?.continuationItemRenderer ? findContinuationToken(item.continuationItemRenderer) : null;
                    if (tok) sectionToken = tok;
                }
            }
            if (node.sortFilterSubMenuRenderer) {
                for (const item of node.sortFilterSubMenuRenderer.subMenuItems || []) {
                    const tok = item?.serviceEndpoint?.continuationCommand?.token;
                    const title = (item?.title || '').toLowerCase();
                    if (!tok) continue;
                    if (title.includes('new')) sortTokens.newest = tok;
                    else if (title.includes('top')) sortTokens.top = tok;
                }
            }
            if (node.videoPrimaryInfoRenderer && !videoTitle) {
                videoTitle = runsText(node.videoPrimaryInfoRenderer.title);
            }
            if (node.videoOwnerRenderer && !videoChannelName) {
                videoChannelName = runsText(node.videoOwnerRenderer.title);
            }
        }
        // The comments section can also live inside the engagement panel copy.
        if (!sectionToken) {
            for (const node of walk(resp)) {
                if (node.continuationItemRenderer && node.continuationItemRenderer.continuationEndpoint) {
                    // Only accept tokens from an itemSectionRenderer that owns the comments header.
                    // Fallback handled by caller-visible flag; keep null to avoid wrong sections.
                }
            }
        }
        return { sectionToken, sortTokens, videoTitle, videoChannelName };
    }

    /** Parse one continuation response into threads, payloads and the next token. */
    parseCommentsPage(resp) {
        const payloads = new Map();
        for (const node of walk(resp)) {
            const p = node.commentEntityPayload;
            if (p?.properties?.commentId) payloads.set(p.properties.commentId, p);
        }

        const threads = [];
        let nextToken = null;
        const seenThread = new Set();

        const collectItems = (items) => {
            for (const item of items || []) {
                const thread = item.commentThreadRenderer;
                if (thread) {
                    const vm = thread.commentViewModel?.commentViewModel || thread.commentViewModel;
                    const legacy = thread.comment?.commentRenderer;
                    const commentId = vm?.commentId || legacy?.commentId;
                    if (commentId && !seenThread.has(commentId)) {
                        seenThread.add(commentId);
                        let repliesToken = null;
                        let viewRepliesCount = null;
                        const replies = thread.replies?.commentRepliesRenderer;
                        if (replies) {
                            for (const c of replies.contents || []) {
                                const tok = c?.continuationItemRenderer ? findContinuationToken(c.continuationItemRenderer) : null;
                                if (tok) repliesToken = tok;
                            }
                            viewRepliesCount = runsText(replies.viewReplies?.buttonRenderer?.text);
                        }
                        threads.push({ commentId, repliesToken, viewRepliesCount, legacy: legacy || null, raw: thread });
                    }
                    continue;
                }
                const legacyTop = item.commentRenderer;
                if (legacyTop?.commentId && !seenThread.has(legacyTop.commentId)) {
                    seenThread.add(legacyTop.commentId);
                    threads.push({ commentId: legacyTop.commentId, repliesToken: null, viewRepliesCount: null, legacy: legacyTop, raw: legacyTop });
                    continue;
                }
                // Replies pages return bare commentViewModel items (no thread wrapper).
                const bareVm = item.commentViewModel?.commentViewModel || item.commentViewModel;
                if (bareVm?.commentId && !seenThread.has(bareVm.commentId)) {
                    seenThread.add(bareVm.commentId);
                    threads.push({ commentId: bareVm.commentId, repliesToken: null, viewRepliesCount: null, legacy: null, raw: item });
                    continue;
                }
                const cont = item.continuationItemRenderer;
                if (cont) {
                    // Token lives under continuationEndpoint on section pages, but under
                    // button.buttonRenderer.command on "Show more replies" items.
                    const tok = findContinuationToken(cont);
                    if (tok) nextToken = tok;
                }
            }
        };

        for (const ep of resp?.onResponseReceivedEndpoints || []) {
            const cmd = ep.reloadContinuationItemsCommand || ep.appendContinuationItemsAction;
            if (cmd?.continuationItems) collectItems(cmd.continuationItems);
        }
        // Fallback: some shapes nest continuationItems elsewhere.
        if (threads.length === 0) {
            for (const node of walk(resp)) {
                if (Array.isArray(node.continuationItems)) collectItems(node.continuationItems);
            }
        }
        return { threads, payloads, nextToken };
    }

    async fetchPage(token) {
        const resp = await this.next({ continuation: token });
        return this.parseCommentsPage(resp);
    }

    mapComment(payload, legacy, { videoId, videoTitle, videoChannelName, parentCommentId }) {
        const now = Date.now();
        if (payload) {
            const props = payload.properties || {};
            const author = payload.author || {};
            const toolbar = payload.toolbar || {};
            const channelPath = author.channelCommand?.innertubeCommand?.browseEndpoint?.canonicalBaseUrl
                || (author.channelId ? `/channel/${author.channelId}` : null);
            const likeText = toolbar.likeCountNotliked || toolbar.likeCountLiked || null;
            return {
                commentId: props.commentId,
                text: props.content?.content ?? '',
                authorName: author.displayName || props.authorButtonA11y || null,
                authorChannelId: author.channelId || null,
                authorChannelUrl: channelPath ? `https://www.youtube.com${channelPath}` : null,
                authorIsVerified: Boolean(author.isVerified),
                authorIsChannelOwner: Boolean(author.isCreator),
                likeCount: parseCount(likeText),
                likeCountText: likeText,
                replyCount: toolbar.replyCount != null ? parseCount(toolbar.replyCount) : null,
                publishedTimeText: props.publishedTime || null,
                publishedAtEstimate: estimatePublishedAt(props.publishedTime, now),
                isPinned: /"pinned"|pinnedCommentBadge/i.test(JSON.stringify(payload)),
                isHearted: Boolean(toolbar.heartActiveTooltip),
                isReply: (props.replyLevel || 0) > 0 || Boolean(parentCommentId),
                parentCommentId: parentCommentId || null,
                videoId,
                videoTitle: videoTitle || null,
                videoChannelName: videoChannelName || null,
                commentUrl: `https://www.youtube.com/watch?v=${videoId}&lc=${props.commentId}`,
                scrapedAt: new Date(now).toISOString(),
            };
        }
        if (legacy) {
            return {
                commentId: legacy.commentId,
                text: runsText(legacy.contentText) || '',
                authorName: runsText(legacy.authorText) || null,
                authorChannelId: legacy.authorEndpoint?.browseEndpoint?.browseId || null,
                authorChannelUrl: legacy.authorEndpoint?.browseEndpoint?.browseId
                    ? `https://www.youtube.com/channel/${legacy.authorEndpoint.browseEndpoint.browseId}`
                    : null,
                authorIsVerified: Boolean(legacy.authorCommentBadge),
                authorIsChannelOwner: Boolean(legacy.authorIsChannelOwner),
                likeCount: parseCount(runsText(legacy.voteCount)),
                likeCountText: runsText(legacy.voteCount),
                replyCount: legacy.replyCount ?? null,
                publishedTimeText: runsText(legacy.publishedTimeText),
                publishedAtEstimate: estimatePublishedAt(runsText(legacy.publishedTimeText), now),
                isPinned: Boolean(legacy.pinnedCommentBadge),
                isHearted: false,
                isReply: Boolean(parentCommentId),
                parentCommentId: parentCommentId || null,
                videoId,
                videoTitle: videoTitle || null,
                videoChannelName: videoChannelName || null,
                commentUrl: `https://www.youtube.com/watch?v=${videoId}&lc=${legacy.commentId}`,
                scrapedAt: new Date(now).toISOString(),
            };
        }
        return null;
    }

    /**
     * Fetch up to `cap` replies for one parent comment.
     * Returns mapped comment objects in page order.
     */
    async fetchReplies({ token, parentCommentId, cap, video }) {
        const out = [];
        let next = token;
        while (next && out.length < cap) {
            const page = await this.fetchPage(next);
            for (const t of page.threads) {
                if (out.length >= cap) break;
                const mapped = this.mapComment(page.payloads.get(t.commentId), t.legacy, {
                    ...video,
                    parentCommentId,
                });
                if (mapped) out.push(mapped);
            }
            next = page.nextToken;
        }
        return out;
    }
}
