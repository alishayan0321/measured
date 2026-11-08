// One-shot: move the 19 inline <style> blocks into styles/*.css, preserving
// cascade order exactly. The deck/vinyl.css <link> sits between block 2 and
// block 3, so the split happens there: base.css (blocks 1-2), vinyl.css, app.css
// (blocks 3-19). Order is therefore byte-identical to the original document.
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
const blocks = [];
let m;
while ((m = re.exec(html))) blocks.push({ start: m.index, end: m.index + m[0].length, css: m[1] });

// Already extracted: refuse rather than overwrite styles/*.css with nothing.
if (blocks.length === 0) {
  console.log('no inline <style> blocks left - nothing to do');
  process.exit(0);
}

const LINK = '<link rel="stylesheet" href="deck/vinyl.css">';
const linkIdx = html.indexOf(LINK);
if (linkIdx < 0) throw new Error('vinyl link not found');

const base = blocks.filter((b) => b.start < linkIdx).map((b) => b.css).join('\n');
const app = blocks.filter((b) => b.start > linkIdx).map((b) => b.css).join('\n');

fs.mkdirSync('styles', { recursive: true });
fs.writeFileSync('styles/base.css', base);
fs.writeFileSync('styles/app.css', app);

let out = '';
let cursor = 0;
for (const b of blocks) {
  out += html.slice(cursor, b.start);
  cursor = b.end;
}
out += html.slice(cursor);

out = out.replace(
  LINK,
  '<link rel="stylesheet" href="styles/base.css">\n' + LINK + '\n<link rel="stylesheet" href="styles/app.css">',
);

fs.writeFileSync('index.html', out);

const orig = blocks.reduce((a, b) => a + b.css.length, 0);
console.log('blocks=' + blocks.length);
console.log('base=' + base.length + ' app=' + app.length + ' total=' + (base.length + app.length));
console.log('origTotal=' + orig);
console.log('styleTagsLeft=' + (out.match(/<style/g) || []).length);
console.log('htmlBytes=' + out.length);
