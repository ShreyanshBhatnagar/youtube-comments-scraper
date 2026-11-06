// Stubbed end-to-end test: runs the real Actor (node --import test/stub-fetch.mjs
// src/main.js) against canned innertube fixtures and asserts on the dataset.
// This verifies the audit fixes (B1 init degradation, B2 reply-loop break,
// M1 dedup, M5 traces) without depending on youtube.com, which rate-limits
// this network. Run: node test/stub.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stubUrl = pathToFileURL(join(root, 'test', 'stub-fetch.mjs')).href;
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { console.log(`PASS ${name}`); pass++; }
    else { console.log(`FAIL ${name} ${extra}`); fail++; }
}

function runActor(label, scenario, input) {
    const dir = join(root, 'test', `.tmp-stub-${label}`);
    rmSync(dir, { recursive: true, force: true });
    const kvs = join(dir, 'key_value_stores', 'default');
    mkdirSync(kvs, { recursive: true });
    writeFileSync(join(kvs, 'INPUT.json'), JSON.stringify(input));
    const proc = spawnSync('node', ['--import', stubUrl, 'src/main.js'], {
        cwd: root,
        env: {
            ...process.env,
            CRAWLEE_STORAGE_DIR: dir,
            APIFY_LOCAL_STORAGE_DIR: dir,
            YTC_STUB_SCENARIO: scenario,
        },
        timeout: 120000,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });
    const dsDir = join(dir, 'datasets', 'default');
    const items = existsSync(dsDir)
        ? readdirSync(dsDir).filter((f) => f.endsWith('.json')).sort()
            .map((f) => JSON.parse(readFileSync(join(dsDir, f), 'utf-8')))
        : [];
    const outFile = join(kvs, 'OUTPUT.json');
    const output = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf-8')) : null;
    console.log(`--- run "${label}" (${scenario}): exit=${proc.status}, ${items.length} dataset items`);
    if (proc.status !== 0) console.log((proc.stdout || '') + '\n' + (proc.stderr || ''));
    return { proc, items, output };
}

// ---------- S1: overlapping pages + repeating reply token + duplicate input ----------
const S1 = runActor('s1', 'overlap', {
    videoUrls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ'],
    maxCommentsPerVideo: 30,
    includeReplies: true,
    maxRepliesPerComment: 10,
    sortBy: 'top',
});
const s1Rows = S1.items.filter((i) => !i.error);
const s1Top = s1Rows.filter((i) => !i.isReply);
const s1Replies = s1Rows.filter((i) => i.isReply);
check('S1 exit code 0 (repeating reply token did not hang the run)', S1.proc.status === 0);
check('S1 exactly 3 unique top-level (page overlap deduplicated)', s1Top.length === 3, `got ${s1Top.length}: ${s1Top.map((i) => i.commentId).join(',')}`);
check('S1 exactly 2 replies', s1Replies.length === 2, `got ${s1Replies.length}`);
check('S1 every reply parent is in dataset', s1Replies.length > 0 && s1Replies.every((r) => s1Top.some((t) => t.commentId === r.parentCommentId)));
check('S1 commentIds unique', new Set(s1Rows.map((i) => i.commentId)).size === s1Rows.length);
check('S1 OUTPUT written with stats', S1.output && S1.output.commentsEmitted === 5, JSON.stringify(S1.output));
check('S1 duplicatesSkipped >= 1', (S1.output?.duplicatesSkipped ?? 0) >= 1, JSON.stringify(S1.output));
check('S1 duplicate input URL skipped (videosSkipped=1)', S1.output?.videosSkipped === 1, JSON.stringify(S1.output));
check('S1 reply truncation recorded (repliesTruncated >= 1)', (S1.output?.repliesTruncated ?? 0) >= 1, JSON.stringify(S1.output));

// ---------- S2: init rate-limited on every source -> graceful degradation ----------
const S2 = runActor('s2', 'initfail', {
    videoUrls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    maxCommentsPerVideo: 10,
});
const s2Errors = S2.items.filter((i) => i.error);
check('S2 exit code 0 despite total init failure (B1)', S2.proc.status === 0);
check('S2 exactly 1 error row', s2Errors.length === 1 && S2.items.length === 1, `got ${S2.items.length} items`);
check('S2 OUTPUT written, initFailed=true, videosFailed=1',
    S2.output?.initFailed === true && S2.output?.videosFailed === 1, JSON.stringify(S2.output));

// ---------- S3: init succeeds after 429 retries ----------
const S3 = runActor('s3', 'initretry', {
    videoUrls: ['dQw4w9WgXcQ'],
    maxCommentsPerVideo: 10,
    includeReplies: false,
});
const s3Rows = S3.items.filter((i) => !i.error);
check('S3 exit code 0', S3.proc.status === 0);
check('S3 3 comments scraped after init retries', s3Rows.length === 3, `got ${s3Rows.length}`);
check('S3 initFailed=false', S3.output?.initFailed === false, JSON.stringify(S3.output));

console.log(`\nstub: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
