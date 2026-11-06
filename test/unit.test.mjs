import assert from 'node:assert/strict';
import { parseVideoId, parseCount, estimatePublishedAt, YouTubeCommentsClient } from '../src/youtube.js';

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log(`PASS ${name}`); pass++; }
    catch (e) { console.log(`FAIL ${name}: ${e.message}`); fail++; }
}
async function acheck(name, fn) {
    try { await fn(); console.log(`PASS ${name}`); pass++; }
    catch (e) { console.log(`FAIL ${name}: ${e.message}`); fail++; }
}

// --- parseVideoId ---
check('watch URL', () => assert.equal(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ'));
check('watch URL with extra params', () => assert.equal(parseVideoId('https://www.youtube.com/watch?t=42&v=aqz-KE-bpKQ&list=PL1'), 'aqz-KE-bpKQ'));
check('youtu.be URL', () => assert.equal(parseVideoId('https://youtu.be/dQw4w9WgXcQ?si=xyz'), 'dQw4w9WgXcQ'));
check('shorts URL', () => assert.equal(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ'));
check('live URL', () => assert.equal(parseVideoId('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share'), 'dQw4w9WgXcQ'));
check('raw ID', () => assert.equal(parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ'));
check('garbage -> null', () => assert.equal(parseVideoId('https://example.com/nothing'), null));
check('empty -> null', () => assert.equal(parseVideoId(''), null));
check('non-string -> null', () => assert.equal(parseVideoId(42), null));

// --- parseCount ---
check('plain int', () => assert.equal(parseCount('727'), 727));
check('K suffix', () => assert.equal(parseCount('570K'), 570000));
check('decimal K', () => assert.equal(parseCount('1.2K'), 1200));
check('M suffix', () => assert.equal(parseCount('3.4M'), 3400000));
check('commas', () => assert.equal(parseCount('1,234'), 1234));
check('null -> 0', () => assert.equal(parseCount(null), 0));
check('number passthrough', () => assert.equal(parseCount(42), 42));

// --- estimatePublishedAt ---
const now = Date.parse('2026-11-06T00:00:00Z');
check('days ago', () => assert.equal(estimatePublishedAt('3 days ago', now), '2026-11-03T00:00:00.000Z'));
check('hours ago (edited)', () => assert.equal(estimatePublishedAt('5 hours ago (edited)', now), '2026-11-05T19:00:00.000Z'));
check('unknown text -> null', () => assert.equal(estimatePublishedAt('a while ago', now), null));
check('null -> null', () => assert.equal(estimatePublishedAt(null, now), null));

// --- fetchReplies / parseCommentsPage / init (stubbed, no network) ---
function legacyReply(id) {
    return {
        commentId: id,
        contentText: { simpleText: `text ${id}` },
        authorText: { simpleText: 'someone' },
        publishedTimeText: { simpleText: '1 day ago' },
    };
}
function stubPage(ids, nextToken) {
    return {
        threads: ids.map((id) => ({ commentId: id, repliesToken: null, legacy: legacyReply(id) })),
        payloads: new Map(),
        nextToken,
    };
}
const stubVideo = { videoId: 'dQw4w9WgXcQ', videoTitle: null, videoChannelName: null };

await acheck('fetchReplies: repeated continuation token terminates (B2)', async () => {
    const client = new YouTubeCommentsClient();
    client.fetchPage = async () => stubPage([], 'SAME_TOKEN');
    const res = await client.fetchReplies({ token: 'SAME_TOKEN', parentCommentId: 'P', cap: 100, video: stubVideo });
    assert.equal(res.truncated, true);
    assert.match(res.errorMessage, /repeated/);
    assert.equal(res.replies.length, 0);
});

await acheck('fetchReplies: token cycle A->B->A terminates (B2)', async () => {
    const client = new YouTubeCommentsClient();
    client.fetchPage = async (tok) => (tok === 'A' ? stubPage(['r1'], 'B') : stubPage(['r2'], 'A'));
    const res = await client.fetchReplies({ token: 'A', parentCommentId: 'P', cap: 100, video: stubVideo });
    assert.equal(res.truncated, true);
    assert.deepEqual(res.replies.map((r) => r.commentId), ['r1', 'r2']);
});

await acheck('fetchReplies: mid-pagination error returns partial replies (M3)', async () => {
    const client = new YouTubeCommentsClient();
    let calls = 0;
    client.fetchPage = async () => {
        calls++;
        if (calls === 1) return stubPage(['r1', 'r2'], 'T2');
        throw new Error('HTTP 500');
    };
    const res = await client.fetchReplies({ token: 'T1', parentCommentId: 'P', cap: 100, video: stubVideo });
    assert.equal(res.truncated, true);
    assert.equal(res.errorMessage, 'HTTP 500');
    assert.deepEqual(res.replies.map((r) => r.commentId), ['r1', 'r2']);
});

await acheck('fetchReplies: duplicate replies across pages emitted once (M1)', async () => {
    const client = new YouTubeCommentsClient();
    client.fetchPage = async (tok) => (tok === 'T1' ? stubPage(['r1', 'r2'], 'T2') : stubPage(['r2', 'r3'], null));
    const res = await client.fetchReplies({ token: 'T1', parentCommentId: 'P', cap: 100, video: stubVideo });
    assert.equal(res.truncated, false);
    assert.deepEqual(res.replies.map((r) => r.commentId), ['r1', 'r2', 'r3']);
});

await acheck('fetchReplies: shouldStop halts before fetching (M4)', async () => {
    const client = new YouTubeCommentsClient();
    let calls = 0;
    client.fetchPage = async () => { calls++; return stubPage(['r1'], 'TX'); };
    const res = await client.fetchReplies({ token: 'T1', parentCommentId: 'P', cap: 100, video: stubVideo, shouldStop: () => true });
    assert.equal(calls, 0);
    assert.equal(res.truncated, true);
    assert.equal(res.replies.length, 0);
});

check('parseCommentsPage: first continuation token wins (m5)', () => {
    const client = new YouTubeCommentsClient();
    const resp = {
        onResponseReceivedEndpoints: [{
            appendContinuationItemsAction: {
                continuationItems: [
                    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'FIRST' } } } },
                    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'SECOND' } } } },
                ],
            },
        }],
    };
    assert.equal(client.parseCommentsPage(resp).nextToken, 'FIRST');
});

const KEY_HTML = '<html>"INNERTUBE_API_KEY":"TESTKEY123","INNERTUBE_CLIENT_VERSION":"2.20240111.09.00"</html>';
await acheck('init: retries 429 then succeeds (B1)', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        if (calls <= 2) return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
        return new Response(KEY_HTML, { status: 200 });
    };
    try {
        const client = await new YouTubeCommentsClient().init();
        assert.equal(client.apiKey, 'TESTKEY123');
        assert.equal(calls, 3);
    } finally { globalThis.fetch = realFetch; }
});

await acheck('init: falls back to a second source page when the first has no key (B1)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => (String(url).includes('aqz-KE-bpKQ')
        ? new Response(KEY_HTML, { status: 200 })
        : new Response('<html>consent wall</html>', { status: 200 }));
    try {
        const client = await new YouTubeCommentsClient().init();
        assert.equal(client.apiKey, 'TESTKEY123');
    } finally { globalThis.fetch = realFetch; }
});

await acheck('init: throws a descriptive error when every source is rate-limited (B1)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
    try {
        await assert.rejects(() => new YouTubeCommentsClient().init(), /Could not initialise a YouTube session/);
    } finally { globalThis.fetch = realFetch; }
});

console.log(`\nunit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
