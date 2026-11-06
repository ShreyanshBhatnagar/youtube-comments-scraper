import assert from 'node:assert/strict';
import { parseVideoId, parseCount, estimatePublishedAt } from '../src/youtube.js';

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log(`PASS ${name}`); pass++; }
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

console.log(`\nunit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
