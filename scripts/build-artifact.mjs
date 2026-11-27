// Packs the Vite build (dist/) into a single self-contained page for hosting:
//   artifact/index.html          page fragment with CSS + JS inlined (host adds doctype/head/body)
//   artifact/data/brookfield.json map data, fetched by relative URL (+ terrain, ground tiles, logos)
//     The host caps each text file at 16 MB, so a bigger map ships as data/brookfield.part{N}.json (each a slice of
//     the JSON text in {"t": "..."}), and a small fetch shim in the page joins them back into data/brookfield.json.
// Usage: npm run build:artifact
import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'artifact');

let html = await readFile(join(DIST, 'index.html'), 'utf8');

const scripts = [];
html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>\s*/g, (_, src) => {
  scripts.push(src);
  return '';
});
const styles = [];
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">\s*/g, (_, href) => {
  styles.push(href);
  return '';
});
if (scripts.length !== 1) throw new Error(`expected 1 entry script in dist/index.html, found ${scripts.length}`);

const js = (await readFile(join(DIST, scripts[0]), 'utf8')).replace(/<\/script/gi, '<\\/script');
const css = (await Promise.all(styles.map((s) => readFile(join(DIST, s), 'utf8')))).join('\n').replace(/<\/style/gi, '<\\/style');

const title = html.match(/<title>.*?<\/title>/s)[0];
const icon = html.match(/<link rel="icon"[^>]*>/s)?.[0] ?? '';
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].trim();

// split the map JSON when it is over the host's per-file limit
const mapText = await readFile(join(ROOT, 'public', 'data', 'brookfield.json'), 'utf8');
const PART = 12e6; // characters per part; leaves room for the escaping inside {"t": ...}
const parts = [];
if (mapText.length > 15e6) for (let i = 0; i * PART < mapText.length; i++) parts.push({ file: `brookfield.part${i}.json`, t: mapText.slice(i * PART, (i + 1) * PART) });
const shim = parts.length ? `<script>
(() => {
  const parts = ${JSON.stringify(parts.map((p) => p.file))};
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/(^|\\/)data\\/brookfield\\.json(\\?|$)/.test(url)) return orig(input, init);
    const dir = url.replace(/brookfield\\.json.*$/, '');
    return Promise.all(parts.map((p) => orig(dir + p).then((r) => { if (!r.ok) throw new Error('map part ' + p + ': HTTP ' + r.status); return r.json(); })))
      .then((list) => new Response(list.map((x) => x.t).join(''), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
})();
</script>
` : '';

const page = `${title}
${icon}
<style>
${css}
</style>
${body}
${shim}<script type="module">
${js}
</script>
`;

await mkdir(join(OUT, 'data'), { recursive: true });
await writeFile(join(OUT, 'index.html'), page);
await rm(join(OUT, 'data'), { recursive: true, force: true });
await mkdir(join(OUT, 'data'), { recursive: true });
if (parts.length) for (const p of parts) await writeFile(join(OUT, 'data', p.file), JSON.stringify({ t: p.t }));
else await copyFile(join(ROOT, 'public', 'data', 'brookfield.json'), join(OUT, 'data', 'brookfield.json'));
// artifacts don't serve .bin, so ship the terrain grid as base64 JSON (terrain.js falls back to it)
const terrainBin = await readFile(join(ROOT, 'public', 'data', 'terrain.bin'));
await writeFile(join(OUT, 'data', 'terrain.b64.json'), JSON.stringify({ data: terrainBin.toString('base64') }));
// stylized ground tiles + attribution logos are fetched by relative URL (old photo tiles removed)
await rm(join(OUT, 'aerial'), { recursive: true, force: true });
await rm(join(OUT, 'ground'), { recursive: true, force: true });
await cp(join(ROOT, 'public', 'ground'), join(OUT, 'ground'), { recursive: true });
await cp(join(ROOT, 'public', 'attribution'), join(OUT, 'attribution'), { recursive: true });
console.log(`artifact/index.html ${(page.length / 1024).toFixed(0)} KB (+ data/, ground/, attribution/)`);
if (parts.length) console.log(`  map split into ${parts.length} parts of <= ${PART / 1e6}M characters`);
