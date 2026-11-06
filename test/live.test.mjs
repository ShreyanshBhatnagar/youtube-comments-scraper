// Live end-to-end test: runs the Actor (node src/main.js) against the real
// youtube.com from this machine, then asserts on the produced dataset files.
// Run: node test/live.test.mjs   (requires npm install first)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { console.log(`PASS ${name}`); pass++; }
    else { console.log(`FAIL ${name} ${extra}`); fail++; }
}

function runActor(label, input) {
    const dir = join(root, 'test', `.tmp-${label}`);
    rmSync(dir, { recursive: true, force: true });
    const kvs = join(dir, 'key_value_stores', 'default');
    mkdirSync(kvs, { recursive: true });
    writeFileSync(join(kvs, 'INPUT.json'), JSON.stringify(input));
    const t0 = Date.now();
    const proc = spawnSync('node', ['src/main.js'], {
        cwd: root,
        env: { ...process.env, CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir },
        timeout: 420000,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const dsDir = join(dir, 'datasets', 'default');
    const items = existsSync(dsDir)
        ? readdirSync(dsDir).filter((f) => f.endsWith('.json')).sort()
            .map((f) => JSON.parse(readFileSync(join(dsDir, f), 'utf-8')))
        : [];
    const outFile = join(kvs, 'OUTPUT.json');
    const output = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf-8')) : null;
    console.log(`--- run "${label}": exit=${proc.status} in ${secs}s, ${items.length} dataset items`);
    if (proc.status !== 0) console.log((proc.stdout || '') + '\n' + (proc.stderr || ''));
    return { proc, items, output, secs };
}

// ---------- Run A: top sort, replies on ----------
const A = runActor('runA', {
    videoUrls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    maxCommentsPerVideo: 30,
    includeReplies: true,
    maxRepliesPerComment: 3,
    sortBy: 'top',
});
const aTop = A.items.filter((i) => !i.error && !i.isReply);
const aReplies = A.items.filter((i) => !i.error && i.isReply);
check('A exit code 0', A.proc.status === 0);
check('A exactly 30 top-level (hard cap respected)', aTop.length === 30, `got ${aTop.length}`);
check('A replies present', aReplies.length >= 1, `got ${aReplies.length}`);
check('A per-parent reply cap <= 3', aReplies.every((r) => aReplies.filter((x) => x.parentCommentId === r.parentCommentId).length <= 3));
check('A every reply parent is in dataset', aReplies.every((r) => aTop.some((t) => t.commentId === r.parentCommentId)));
check('A commentIds unique', new Set(A.items.filter((i) => i.commentId).map((i) => i.commentId)).size === A.items.filter((i) => i.commentId).length);
check('A rows have text/author/likes/url', aTop.every((i) => typeof i.text === 'string' && i.authorName && typeof i.likeCount === 'number' && i.commentUrl?.includes(i.commentId)));
check('A stats.output matches dataset', A.output && A.output.commentsEmitted === A.items.filter((i) => !i.error).length, JSON.stringify(A.output));
console.log(`A detail: ${aTop.length} top-level + ${aReplies.length} replies = ${A.items.length} rows in ${A.secs}s (${(A.items.length / A.secs).toFixed(1)} rows/s)`);
if (aTop[0]) console.log('A sample row:', JSON.stringify(aTop[0], null, 1).slice(0, 700));

// ---------- Run B: newest sort, replies off, second video + invalid input ----------
const B = runActor('runB', {
    videoUrls: ['aqz-KE-bpKQ', 'https://example.com/not-a-video'],
    maxCommentsPerVideo: 15,
    includeReplies: false,
    sortBy: 'newest',
});
const bTop = B.items.filter((i) => !i.error);
const bErrors = B.items.filter((i) => i.error);
check('B exit code 0', B.proc.status === 0);
check('B exactly 15 top-level', bTop.length === 15, `got ${bTop.length}`);
check('B no replies when includeReplies=false', B.items.every((i) => !i.isReply));
check('B exactly 1 error row for invalid input', bErrors.length === 1, `got ${bErrors.length}`);
const recent = bTop.filter((i) => /\b(minute|hour|day|week)s? ago/.test(i.publishedTimeText || ''));
check('B newest sort returns recent comments (>=8 of 15 within a week)', recent.length >= 8, `got ${recent.length}; sample times: ${bTop.slice(0, 5).map((i) => i.publishedTimeText).join(' | ')}`);

// ---------- Run C: charge cap stops the run ----------
const C = runActor('runC', {
    videoUrls: ['dQw4w9WgXcQ'],
    maxCommentsPerVideo: 500,
    includeReplies: false,
    maxTotalChargeUsd: 0.01,
});
const cRows = C.items.filter((i) => !i.error);
check('C charge cap stops run (rows*0.0009 <= ~0.01 + 1)', cRows.length > 0 && cRows.length <= 12, `got ${cRows.length}`);
check('C stats flag stoppedByChargeCap', C.output?.stoppedByChargeCap === true, JSON.stringify(C.output));

console.log(`\nlive: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
