// Builds the signed MEASURED APK.
//   node build.cjs          full build (ships every song)
//   node build.cjs --fast   links/signs without the songs (toolchain smoke test)
//
// Pipeline: stage assets → aapt2 compile → aapt2 link → javac → d8 → append
// classes.dex → zipalign → apksigner (self-signed, 30y).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
const PLAYER = path.join(HERE, '..');
const BUILD = path.join(PLAYER, 'build');
const JDK = path.join(BUILD, 'jdk', 'jdk-17.0.20.1+1');
const SDK = path.join(BUILD, 'sdk');
const BT = path.join(SDK, 'build-tools', '34.0.0');
const ANDROID_JAR = path.join(SDK, 'platforms', 'android-34', 'android.jar');
const SONGS = process.env.MEASURED_SONGS || path.join(HERE, '..', '..', 'songs');

const OUT = path.join(HERE, 'out');
const ASSETS = path.join(HERE, 'assets');
const GEN = path.join(HERE, 'gen');
const CLASSES = path.join(HERE, 'classes');
const DEX = path.join(HERE, 'dex');

const FAST = process.argv.includes('--fast');
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
for (const p of [JDK, BT, ANDROID_JAR]) {
  if (!fs.existsSync(p)) {
    console.error('missing toolchain: ' + p);
    process.exit(1);
  }
}
console.log(`MEASURED android build  ${FAST ? '(fast, no songs)' : '(full)'}`);

// ── 1. stage assets ──────────────────────────────────────────────────────────
rm(ASSETS); rm(GEN); rm(CLASSES); rm(DEX); fs.mkdirSync(OUT, { recursive: true });

const WEB = ['index.html', 'api.js', 'deck', 'lib', 'thumbs', 'fingerprints.js', 'library.json'];
const webDir = path.join(ASSETS, 'player');
fs.mkdirSync(webDir, { recursive: true });
for (const name of WEB) {
  const src = path.join(PLAYER, name);
  if (!fs.existsSync(src)) { console.log(`  ~ skip ${name} (not built yet)`); continue; }
  const dst = path.join(webDir, name);
  if (fs.statSync(src).isDirectory()) copyTree(src, dst, (p, n) => !n.endsWith('.cjs'));
  else fs.copyFileSync(src, dst);
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
  '--version-code', '2',
  '--version-name', '2.0.0',
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
if (!fs.existsSync(keystore)) {
  run('keytool', jdkBin('keytool'), [
    '-genkeypair', '-keystore', keystore, '-alias', 'measured',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
    '-storepass', 'measured2026', '-keypass', 'measured2026',
    '-dname', 'CN=MEASURED, O=MEASURED, C=US',
  ]);
}

const apk = path.join(OUT, 'MEASURED.apk');
rm(apk);
javaJar('apksigner', SIGNER_JAR, [
  'sign', '--ks', keystore, '--ks-key-alias', 'measured',
  '--ks-pass', 'pass:measured2026', '--key-pass', 'pass:measured2026',
  '--out', apk, aligned,
]);
javaJar('apksigner verify', SIGNER_JAR, ['verify', '--verbose', apk]);

const mb = (fs.statSync(apk).size / 1048576).toFixed(1);
console.log(`\nAPK ready: ${apk}  (${mb} MB)`);
