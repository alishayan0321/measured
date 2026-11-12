/* Stage test: every local file index.html asks for must exist in both packaged
 * outputs. The desktop and Android builds keep separate file lists, and each has
 * silently shipped a 404 before — styles/ on Android, embeddings.json on both —
 * so this walks the page's own references instead of trusting those lists.
 * Run: node test/stage.test.cjs */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');

/* Local = no scheme, no protocol-relative host, no bare fragment. Anything with
 * a scheme (https:, data:, mailto:) is fetched from outside the bundle, and a
 * bare '#' is an in-page anchor. Query strings and fragments are stripped
 * because the staged file is the path alone. */
function localTargets(source) {
  const found = new Set();
  const patterns = [
    /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    /\bfetch\(\s*["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const raw = m[1].trim();
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
      found.add(raw.split(/[?#]/)[0]);
    }
  }
  return [...found].sort();
}

const targets = localTargets(html);

/* Stage into a throwaway directory. Both scripts honour MEASURED_STAGE_OUT so a
 * test run never clobbers rust/desktop/dist or android/assets. */
function stage(label, script, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `measured-stage-${label}-`));
  try {
    execFileSync(process.execPath, [script, ...args], {
      cwd: repo,
      env: { ...process.env, MEASURED_STAGE_OUT: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim();
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`${label} staging failed: ${out.slice(-2000) || e.message}`);
  }
  return dir;
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + ': ' + e.message); }
}

// The regex is the test's own blind spot: if index.html ever stops spelling the
// boot fetch as a literal, this assertion is what notices the coverage gap.
t('index.html references embeddings.json', () => {
  assert.ok(targets.includes('embeddings.json'), 'boot fetch not found — parser or page changed');
});

t('index.html references at least the core assets', () => {
  for (const must of ['api.js', 'styles/app.css', 'styles/base.css', 'lib/recommend.js']) {
    assert.ok(targets.includes(must), `missing ${must} from parsed targets`);
  }
});

const desktop = stage('desktop', path.join(repo, 'rust', 'stage-ui.cjs'), []);
const android = stage('android', path.join(repo, 'android', 'build.cjs'), ['--stage-only']);

t('desktop bundle has every local target', () => {
  const missing = targets.filter((f) => !fs.existsSync(path.join(desktop, f)));
  assert.deepStrictEqual(missing, [], 'missing from rust/desktop/dist: ' + missing.join(', '));
});

t('android bundle has every local target', () => {
  const missing = targets.filter((f) => !fs.existsSync(path.join(android, 'player', f)));
  assert.deepStrictEqual(missing, [], 'missing from android/assets/player: ' + missing.join(', '));
});

t('desktop bundle ships no node-only helpers', () => {
  const lib = path.join(desktop, 'lib');
  const cjs = fs.existsSync(lib) ? fs.readdirSync(lib).filter((f) => f.endsWith('.cjs')) : [];
  assert.deepStrictEqual(cjs, [], 'lib/*.cjs leaked into the bundle: ' + cjs.join(', '));
});

fs.rmSync(desktop, { recursive: true, force: true });
fs.rmSync(android, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
