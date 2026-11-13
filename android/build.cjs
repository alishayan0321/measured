// Builds the signed MEASURED APK.
//   node build.cjs               full build (ships every song)
//   node build.cjs --fast        links/signs without the songs (toolchain smoke test)
//   node build.cjs --stage-only  stage the web assets and stop (used by test/stage.test.cjs)
//
// Pipeline: stage assets → aapt2 compile → aapt2 link → javac → d8 → append
// classes.dex → zipalign → apksigner (self-signed, 30y).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const HERE = __dirname;
const PLAYER = path.join(HERE, '..');

// Toolchain roots. The defaults are the layout this workspace ships with
// (build/jdk + build/sdk); MEASURED_BUILD relocates both at once, and the two
// specific variables win over it so a machine with a system JDK and a
// separately downloaded SDK can mix them.
const BUILD = process.env.MEASURED_BUILD
  ? path.resolve(process.env.MEASURED_BUILD)
  : path.join(PLAYER, 'build');
const JDK = process.env.MEASURED_JAVA_HOME
  ? path.resolve(process.env.MEASURED_JAVA_HOME)
  : path.join(BUILD, 'jdk', 'jdk-17.0.20.1+1');
const SDK = process.env.MEASURED_ANDROID_SDK
  ? path.resolve(process.env.MEASURED_ANDROID_SDK)
  : path.join(BUILD, 'sdk');
const BT = path.join(SDK, 'build-tools', '34.0.0');
const ANDROID_JAR = path.join(SDK, 'platforms', 'android-34', 'android.jar');
const SONGS = process.env.MEASURED_SONGS || path.join(HERE, '..', '..', 'songs');

const OUT = path.join(HERE, 'out');
// MEASURED_STAGE_OUT redirects the staged web assets so the stage test can
// build a throwaway tree instead of overwriting android/assets.
const ASSETS = process.env.MEASURED_STAGE_OUT
  ? path.resolve(process.env.MEASURED_STAGE_OUT)
  : path.join(HERE, 'assets');
const GEN = path.join(HERE, 'gen');
const CLASSES = path.join(HERE, 'classes');
const DEX = path.join(HERE, 'dex');

const FAST = process.argv.includes('--fast');
const STAGE_ONLY = process.argv.includes('--stage-only');

// Single source of truth for the shipped version: the desktop Tauri config is
// bumped at release time, so the APK follows it instead of drifting behind.
// (v2.0.3 once shipped an APK whose manifest still claimed 2.0.0 / code 2.)
function readVersion() {
  try {
    const conf = JSON.parse(
      fs.readFileSync(path.join(PLAYER, 'rust', 'desktop', 'tauri.conf.json'), 'utf8'),
    );
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(conf.version || '');
    if (m) {
      return {
        name: conf.version,
        code: Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]),
      };
    }
  } catch {
    // fall through to the pinned fallback below
  }
  console.warn('version: tauri.conf.json unreadable, pinning 2.0.0 (code 2)');
  return { name: '2.0.0', code: 2 };
}
const VERSION = readVersion();
const env = {
  ...process.env,
  JAVA_HOME: JDK,
  PATH: path.join(JDK, 'bin') + ';' + (process.env.PATH || ''),
};

const exe = (name) => path.join(BT, name + '.exe');
const jdkBin = (name) => path.join(JDK, 'bin', name + '.exe');
// Calling the jars through java avoids Windows .bat spawning (EINVAL) and keeps
// long paths with spaces intact.
const javaJar = (label, jar, args) => run(label, jdkBin('java'), ['-jar', jar, ...args]);
const javaClass = (label, cp, mainClass, args) =>
  run(label, jdkBin('java'), ['-cp', cp, mainClass, ...args]);
const D8_JAR = path.join(BT, 'lib', 'd8.jar');
// third-party jars (NewPipeExtractor + its deps) live in android/libs
const LIBS_DIR = path.join(HERE, 'libs');
const LIBS = fs.existsSync(LIBS_DIR)
  ? fs.readdirSync(LIBS_DIR).filter((f) => f.endsWith('.jar')).map((f) => path.join(LIBS_DIR, f))
  : [];
const SIGNER_JAR = path.join(BT, 'lib', 'apksigner.jar');

function run(label, file, args, extra = {}) {
  const t0 = Date.now();
  try {
    execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env, ...extra });
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim();
    console.error(`\n[FAIL] ${label}\n${out.slice(-4000) || e.message}`);
    process.exit(1);
  }
  console.log(`  ${label}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyTree(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { copyTree(src, dst, filter); continue; }
    if (filter && !filter(src, e.name)) continue;
    fs.copyFileSync(src, dst);
  }
}

// ── 0. sanity ────────────────────────────────────────────────────────────────
// javac has to be 17 exactly. d8/R8 does not reject a newer class-file major
// with a clear error; it dies of an NPE deep inside dexing, after aapt2 has
// already compiled and linked the whole app. Probing the version up front turns
// that opaque late crash into one line before anything is written.
const REQUIRED_JAVAC_MAJOR = 17;

// 'javac 17.0.20.1' -> 17, 'javac 21.0.1' -> 21, legacy 'javac 1.8.0_511' -> 8.
function javacMajorVersion(banner) {
  const m = /javac\s+([\d._]+)/i.exec(banner);
  if (!m) return null;
  const parts = m[1].split(/[._]/);
  const major = Number(parts[0] === '1' ? parts[1] : parts[0]);
  return Number.isInteger(major) ? major : null;
}

function assertJavac17() {
  const javac = jdkBin('javac');
  // Both streams are read: older JDKs print -version to stderr, and a
  // 'Picked up JAVA_TOOL_OPTIONS' notice can arrive on stderr ahead of the
  // banner, so the line is searched for rather than assumed to be first.
  const probe = spawnSync(javac, ['-version'], { encoding: 'utf8', env });
  const lines = `${probe.stdout || ''}${probe.stderr || ''}`
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const banner = lines.find((l) => /javac\s+[\d._]+/i.test(l)) || lines[0] || '';
  const major = javacMajorVersion(banner);
  if (major === REQUIRED_JAVAC_MAJOR) return;
  console.error(
    `[FAIL] javac ${major ?? 'unknown'} found at ${javac} (${banner || probe.error?.message || 'no -version output'}); ` +
      `this build requires javac ${REQUIRED_JAVAC_MAJOR} and d8 fails with an R8 NPE on any other major — ` +
      `point MEASURED_JAVA_HOME at a JDK 17.`,
  );
  process.exit(1);
}

// --stage-only never touches the toolchain, so it must not demand one.
if (!STAGE_ONLY) {
  for (const p of [JDK, BT, ANDROID_JAR]) {
    if (!fs.existsSync(p)) {
      console.error('missing toolchain: ' + p);
      process.exit(1);
    }
  }
  assertJavac17();
}
console.log(
  `MEASURED android build  ${STAGE_ONLY ? '(stage only)' : FAST ? '(fast, no songs)' : '(full)'}`,
);

// ── 1. stage assets ──────────────────────────────────────────────────────────
// 'styles' is load-bearing: since 2.0.2 the interface's CSS lives in
// styles/app.css and styles/base.css instead of an inline <style> block, so an
// APK built without it installs a completely unstyled player.
// 'embeddings.json' is fetched by index.html at boot; without it the
// recommender's embedding feature 404s on the phone exactly as it did on
// desktop. 'icon.png' is the page's <link rel="icon">.
const WEB = [
  'index.html',
  'app.js',
  'api.js',
  'deck',
  'lib',
  'styles',
  'thumbs',
  'fingerprints.js',
  'library.json',
  'embeddings.json',
  'icon.png',
];
const webDir = path.join(ASSETS, 'player');

function stageWeb() {
  fs.mkdirSync(webDir, { recursive: true });
  for (const name of WEB) {
    const src = path.join(PLAYER, name);
    if (!fs.existsSync(src)) { console.log(`  ~ skip ${name} (not built yet)`); continue; }
    const dst = path.join(webDir, name);
    if (fs.statSync(src).isDirectory()) copyTree(src, dst, (p, n) => !n.endsWith('.cjs'));
    else fs.copyFileSync(src, dst);
  }
}

rm(ASSETS);
if (!STAGE_ONLY) {
  rm(GEN); rm(CLASSES); rm(DEX); fs.mkdirSync(OUT, { recursive: true });
}
stageWeb();
if (STAGE_ONLY) {
  console.log(`staged web assets -> ${webDir}`);
  process.exit(0);
}

const AUDIO = /\.(mp3|webm|flac|m4a|ogg|opus|wav|aac)$/i;
if (!FAST) {
  const songsDir = path.join(ASSETS, 'songs');
  fs.mkdirSync(songsDir, { recursive: true });
  // aapt2 cannot open asset paths containing | : * ? " < > — pack the sanitised
  // names make-assets.cjs already wrote into library.json.
  const nameMap = path.join(PLAYER, 'asset-names.json');
  const names = fs.existsSync(nameMap)
    ? new Map(JSON.parse(fs.readFileSync(nameMap, 'utf8')).map((r) => [r.from, r.to]))
    : null;
  const files = fs.readdirSync(SONGS).filter((f) => AUDIO.test(f));
  let bytes = 0;
  for (const f of files) {
    const staged = names && names.get(f) ? names.get(f) : f;
    const src = path.join(SONGS, f);
    const dst = path.join(songsDir, staged);
    fs.copyFileSync(src, dst);
    bytes += fs.statSync(dst).size;
  }
  console.log(`  staged ${files.length} songs  ${(bytes / 1048576).toFixed(0)} MB`);
}

// ── 2. resources ─────────────────────────────────────────────────────────────
const compiled = path.join(HERE, 'res.zip');
rm(compiled);
run('aapt2 compile', exe('aapt2'), ['compile', '--dir', path.join(HERE, 'res'), '-o', compiled]);

const unsigned = path.join(OUT, 'unsigned.apk');
rm(unsigned);
run('aapt2 link', exe('aapt2'), [
  'link', '-o', unsigned,
  '-I', ANDROID_JAR,
  '--manifest', path.join(HERE, 'AndroidManifest.xml'),
  '-A', ASSETS,
  compiled,                       // positional = base resource table (‑R means overlay)
  '--java', GEN,
  '--min-sdk-version', '24',
  '--target-sdk-version', '34',
  '--version-code', String(VERSION.code),
  '--version-name', VERSION.name,
  '-0', '.webm',
  '-0', '.mp3',
  '-0', '.jpg',
]);

// ── 2b. asset paths: aapt2 writes Windows separators on Windows ──────────────
run('fix asset names', process.execPath, [path.join(HERE, 'fix-asset-names.cjs'), unsigned]);

// ── 3. java ──────────────────────────────────────────────────────────────────
const javaSrc = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.java')) javaSrc.push(p);
  }
})(path.join(HERE, 'java'));
if (fs.existsSync(path.join(GEN, 'com', 'measured', 'player', 'R.java'))) {
  javaSrc.push(path.join(GEN, 'com', 'measured', 'player', 'R.java'));
}

fs.mkdirSync(CLASSES, { recursive: true });
run('javac', jdkBin('javac'), [
  '-source', '8', '-target', '8', '-nowarn', '-encoding', 'UTF-8',
  '-bootclasspath', ANDROID_JAR,
  '-classpath', [ANDROID_JAR, ...LIBS].join(path.delimiter),
  '-d', CLASSES, ...javaSrc,
]);

const classFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.class')) classFiles.push(p);
  }
})(CLASSES);

fs.mkdirSync(DEX, { recursive: true });
javaClass('d8', D8_JAR, 'com.android.tools.r8.D8', [
  '--lib', ANDROID_JAR, '--min-api', '24', '--output', DEX, ...classFiles, ...LIBS,
]);

// ── 4. classes.dex into the apk (stored, so the audio stays uncompressed) ────
const dexPath = path.join(DEX, 'classes.dex');
run('append classes.dex', process.execPath, [path.join(HERE, 'zip-append.cjs'), unsigned, dexPath]);

// ── 5. align + sign ──────────────────────────────────────────────────────────
const aligned = path.join(OUT, 'aligned.apk');
rm(aligned);
run('zipalign', exe('zipalign'), ['-p', '-f', '4', unsigned, aligned]);

const keystore = path.join(HERE, 'measured.keystore');
const KS_PASS_FILE = path.join(HERE, 'measured.keystore.pass');

// The signing password must not live in the source tree: anyone holding it
// could sign a look-alike build that Android accepts as an update. Resolution
// order is MEASURED_KS_PASS → the gitignored sidecar file → a freshly generated
// random password written to that file. An existing keystore with no known
// password is a hard error, because quietly generating a new one would sign the
// APK with a different key than the build already installed on a phone.
function keystorePassword(keystoreExists) {
  if (process.env.MEASURED_KS_PASS) return process.env.MEASURED_KS_PASS;
  try {
    const saved = fs.readFileSync(KS_PASS_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // no sidecar yet — fall through to generate one
  }
  if (keystoreExists) {
    console.error(
      `\n[FAIL] ${keystore} exists but its password is unknown.\n` +
        `Set MEASURED_KS_PASS, write the password to ${KS_PASS_FILE}, ` +
        `or delete the keystore to generate a new one.`,
    );
    process.exit(1);
  }
  const generated = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(KS_PASS_FILE, generated + '\n', { mode: 0o600 });
  console.log(`  keystore password generated -> ${KS_PASS_FILE} (gitignored)`);
  return generated;
}

const KS_PASS = keystorePassword(fs.existsSync(keystore));
// Hand the secret to the tools through the child environment rather than argv,
// so it never shows up in a process listing.
env.MEASURED_KS_PASS = KS_PASS;

if (!fs.existsSync(keystore)) {
  run('keytool', jdkBin('keytool'), [
    '-genkeypair', '-keystore', keystore, '-alias', 'measured',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
    '-storepass:env', 'MEASURED_KS_PASS', '-keypass:env', 'MEASURED_KS_PASS',
    '-dname', 'CN=MEASURED, O=MEASURED, C=US',
  ]);
}

const apk = path.join(OUT, 'MEASURED.apk');
rm(apk);
javaJar('apksigner', SIGNER_JAR, [
  'sign', '--ks', keystore, '--ks-key-alias', 'measured',
  '--ks-pass', 'env:MEASURED_KS_PASS', '--key-pass', 'env:MEASURED_KS_PASS',
  '--out', apk, aligned,
]);
javaJar('apksigner verify', SIGNER_JAR, ['verify', '--verbose', apk]);

const mb = (fs.statSync(apk).size / 1048576).toFixed(1);
console.log(`\nAPK ready: ${apk}  (${mb} MB)`);
