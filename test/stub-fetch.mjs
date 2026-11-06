// Preload stub for test/stub.test.mjs — loaded with `node --import` BEFORE
// src/main.js, it replaces global fetch for youtube.com URLs with canned
// innertube fixtures so the full Actor can be verified end-to-end while the
// real youtube.com is rate-limiting this network. Non-YouTube URLs delegate
// to the real fetch. Scenario is chosen via YTC_STUB_SCENARIO.
const scenario = process.env.YTC_STUB_SCENARIO || 'overlap';
const realFetch = globalThis.fetch.bind(globalThis);

const KEY_HTML = '<html>"INNERTUBE_API_KEY":"STUBKEY","INNERTUBE_CLIENT_VERSION":"2.20240111.09.00"</html>';
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tooMany = () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });

function payload(id, text, replyCount = 0) {
    return {
        commentEntityPayload: {
            properties: { commentId: id, content: { content: text }, publishedTime: '2 days ago' },
            author: { displayName: `Author ${id}`, channelId: `UC${id}`, isVerified: false, isCreator: false },
            toolbar: { replyCount, likeCountNotliked: '5' },
        },
    };
}

function thread(id, repliesToken = null) {
    const t = { commentViewModel: { commentViewModel: { commentId: id } } };
    if (repliesToken) {
        t.replies = {
            commentRepliesRenderer: {
                contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: repliesToken } } } }],
            },
        };
    }
    return { commentThreadRenderer: t };
}

function bareReply(id) {
    return { commentViewModel: { commentViewModel: { commentId: id } } };
}

function contItem(token) {
    return { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } };
}

function pageResp(items, payloads, nextToken) {
    return {
        onResponseReceivedEndpoints: [{
            appendContinuationItemsAction: {
                continuationItems: nextToken ? [...items, contItem(nextToken)] : items,
            },
        }],
        frameworkUpdates: { entityBatchUpdate: { mutations: payloads.map((p) => ({ payload: p })) } },
    };
}

const openVideoResp = {
    responseContext: { visitorData: 'STUBVD' },
    contents: [{
        itemSectionRenderer: {
            targetId: 'comments-section',
            contents: [contItem('PAGE1')],
        },
    }],
    sortPanel: {
        sortFilterSubMenuRenderer: {
            subMenuItems: [
                { title: 'Top comments', serviceEndpoint: { continuationCommand: { token: 'PAGE1' } } },
                { title: 'Newest first', serviceEndpoint: { continuationCommand: { token: 'PAGE1' } } },
            ],
        },
    },
    videoPrimaryInfoRenderer: { title: { simpleText: 'Stub Video' } },
    videoOwnerRenderer: { title: { simpleText: 'Stub Channel' } },
};

function handleNext(body) {
    if (body.videoId) return json(openVideoResp);
    switch (body.continuation) {
        case 'PAGE1':
            if (scenario === 'initretry') {
                return json(pageResp(
                    [thread('C1'), thread('C2'), thread('C3')],
                    [payload('C1', 'one'), payload('C2', 'two'), payload('C3', 'three')],
                    null,
                ));
            }
            return json(pageResp(
                [thread('C1', 'RT1'), thread('C2')],
                [payload('C1', 'first', 2), payload('C2', 'second')],
                'PAGE2',
            ));
        case 'PAGE2':
            // C2 repeats from page 1 (top-sort overlap); C3 is new; no next page.
            return json(pageResp(
                [thread('C2'), thread('C3')],
                [payload('C2', 'second'), payload('C3', 'third')],
                null,
            ));
        case 'RT1':
            // Replies page re-serves its own continuation token: the Actor
            // must detect the repeat and stop instead of looping forever.
            return json(pageResp(
                [bareReply('RP1'), bareReply('RP2')],
                [payload('RP1', 'reply one'), payload('RP2', 'reply two')],
                'RT1',
            ));
        default:
            return json(pageResp([], [], null));
    }
}

let getCount = 0;
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('youtube.com')) return realFetch(url, opts);
    if (u.includes('/youtubei/v1/next')) {
        return handleNext(JSON.parse(opts.body));
    }
    // Any GET (watch page / embed page) is an init() source.
    getCount++;
    if (scenario === 'initfail') return tooMany();
    if (scenario === 'initretry' && getCount <= 2) return tooMany();
    return new Response(KEY_HTML, { status: 200 });
};
