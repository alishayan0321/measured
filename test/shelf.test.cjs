/* Shelf tests: no network, no audio device. fetch and Audio are faked, so this
 * checks the rules (download gate, the 20% rule, buffer discipline), not Apple's
 * uptime. */
'use strict';
const assert = require('assert');
const S = require('../lib/shelf.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('>  FAIL ' + name + '\n         ' + (e && e.message)); fail++; }
}

const JSON_FIXTURE = {
  results: [
    { trackId: 1, previewUrl: 'https://x/1.m4a', trackName: 'One', artistName: 'A', collectionName: 'LP', releaseDate: '2021-03-01T00:00:00Z' },
    { trackId: 2, previewUrl: 'https://x/2.m4a', trackName: 'Two', artistName: 'B' },
    { trackId: 3, artistName: 'NoPreview' }                       // dropped
  ]
};

function mk(over) {
  over = over || {};
  const calls = [];
  const shelf = S.create({
    now: () => 1700000000000,
    fetchJson: (u) => { calls.push(u); return Promise.resolve(over.json || JSON_FIXTURE); },
    makeAudio: (src) => ({ src: src, preload: 'auto', paused: true })
  });
  return { shelf, calls };
}

t('search URL is the itunes search endpoint with an encoded term', () => {
  const { shelf } = mk();
  const u = shelf.url('Daddy Mummy & co');
  assert.ok(u.startsWith('https://itunes.apple.com/search?term='));
  assert.ok(u.includes('Daddy%20Mummy%20%26%20co'));
  assert.ok(u.includes('entity=song'));
});

t('parse keeps only clips that actually have a preview', () => {
  const { shelf } = mk();
  const list = shelf.parse(JSON_FIXTURE);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, 'it1');
  assert.strictEqual(list[0].year, '2021');
});

t('seeds prefer the most played, then liked, and never repeat an artist', () => {
  const { shelf } = mk();
  const stats = { per: {
    a: { artist: 'Katy', plays: 9, liked: false },
    b: { artist: 'Katy', plays: 2, liked: true },
    c: { artist: 'Doja', plays: 1, liked: true },
    d: { artist: 'Nobody', plays: 0, liked: false }
  } };
  const seeds = shelf.seedsFrom(stats, 3);
  assert.strictEqual(seeds[0], 'Katy');
  assert.strictEqual(seeds.filter((x) => x === 'Katy').length, 1);
  assert.ok(seeds.includes('Doja'));
});

t('search buffers at most the pool size and next() only returns a ready clip', async () => {
  const { shelf } = mk();
  await shelf.search('A');
  await shelf.search('A');                       // a second page must not overfill
  assert.strictEqual(shelf.poolSize(), 3);
  assert.strictEqual(shelf.next(), null);        // nothing buffered yet
  shelf.markReady('it1', true);
  const got = shelf.next();
  assert.strictEqual(got.id, 'it1');
  assert.strictEqual(shelf.poolSize(), 2);       // consumed one, topped back up from queue
});

t('a banned clip is never handed out again', async () => {
  const { shelf } = mk();
  await shelf.search('A');
  shelf.markReady('it1', true);
  shelf.noteEnd('it1', 1, 30);                   // 3% on the first attempt
  assert.ok(shelf.isBanned('it1'));
  shelf.markReady('it2', true);
  assert.strictEqual(shelf.next().id, 'it2');
});

t('a download needs a like or three listens in one sitting', () => {
  const { shelf } = mk();
  assert.strictEqual(shelf.downloadGate('it9', false).ok, false);
  shelf.noteListen('it9', 29, 30);               // one full listen
  shelf.noteListen('it9', 29, 30);
  assert.strictEqual(shelf.downloadGate('it9', false).ok, false);
  shelf.noteListen('it9', 29, 30);
  const g = shelf.downloadGate('it9', false);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(shelf.downloadGate('fresh', true).ok, true);   // liking is enough
});

t('a half listen does not count toward a download', () => {
  const { shelf } = mk();
  shelf.noteListen('it5', 12, 30);               // 40%
  shelf.noteListen('it5', 12, 30);
  shelf.noteListen('it5', 12, 30);
  assert.strictEqual(shelf.downloadGate('it5', false).ok, false);
});

t('the 20% rule: one low skip bans a track that never got going', () => {
  const { shelf } = mk();
  assert.strictEqual(shelf.noteEnd('n1', 6, 30), 'ban');   // 20%, first attempt
  assert.strictEqual(shelf.isBanned('n1'), true);
});

t('the 20% rule: a track that already played through earns one second chance', () => {
  const { shelf } = mk();
  shelf.noteListen('n2', 29, 30);                 // it has been heard properly once
  assert.strictEqual(shelf.noteEnd('n2', 3, 30), 'strike');   // 10%, not banned yet
  assert.strictEqual(shelf.isBanned('n2'), false);
});

t('above 20% is not a verdict', () => {
  const { shelf } = mk();
  assert.strictEqual(shelf.noteEnd('n3', 9, 30), 'ok');       // 30%
  assert.strictEqual(shelf.noteEnd('n4', 6.06, 30), 'ok');    // just over 20%
  assert.strictEqual(shelf.isBanned('n3'), false);
});

t('two low skips with a listen in between still ban', () => {
  const { shelf } = mk();
  shelf.noteListen('n5', 29, 30);                 // it played through once
  assert.strictEqual(shelf.noteEnd('n5', 3, 30), 'strike');
  assert.strictEqual(shelf.isBanned('n5'), false);
  assert.strictEqual(shelf.noteEnd('n5', 3, 30), 'ban');
  assert.strictEqual(shelf.isBanned('n5'), true);
});

t('a clip with no duration cannot be judged', () => {
  const { shelf } = mk();
  assert.strictEqual(shelf.noteEnd('n6', 0, 0), 'ok');
  assert.strictEqual(shelf.isBanned('n6'), false);
});

t('reset clears bans, buffered clips and download marks', async () => {
  const { shelf } = mk();
  await shelf.search('A');
  shelf.markReady('it1', true);
  shelf.noteEnd('it1', 1, 30);
  shelf.noteDownload('it1');
  shelf.reset();
  assert.strictEqual(shelf.poolSize(), 0);
  assert.strictEqual(shelf.isBanned('it1'), false);
  assert.deepStrictEqual(shelf.stats().downloads, []);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
