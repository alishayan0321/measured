/* Filename parsing must satisfy the shared contract in test/parse-vectors.json.
 * rust/core/src/scan.rs runs the same vectors from cargo test, so a divergence
 * between the two parsers fails one side or the other.
 * Run: node test/parse.test.cjs */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../lib/parse-name.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + ': ' + e.message); }
}

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'parse-vectors.json'), 'utf8')).cases;

t('fixture is loaded', () => {
  assert.ok(vectors.length >= 25, 'expected at least 25 vectors, got ' + vectors.length);
});

for (const v of vectors) {
  t('parse ' + v.file, () => {
    const got = P.parseName(v.file);
    assert.strictEqual(got.artist, v.artist, 'artist');
    assert.strictEqual(got.title, v.title, 'title');
    assert.strictEqual(got.videoId, v.videoId, 'videoId');
  });
}

t('video id survives keyFor', () => {
  assert.strictEqual(P.keyFor('Tycho - Awake [dQw4w9WgXcQ].mp3', null), 'dQw4w9WgXcQ');
  assert.strictEqual(P.keyFor('Tycho - Awake.mp3', null), null);
});

t('extensions are classified', () => {
  assert.ok(P.isAudio('x.aiff'));
  assert.ok(!P.isNative('x.aiff'), 'aiff needs conversion, so it is not native');
  assert.ok(P.isNative('x.webm'));
  assert.ok(!P.isAudio('x.txt'));
});

console.log(pass + '/' + (pass + fail) + ' parse tests pass');
process.exitCode = fail ? 1 : 0;
