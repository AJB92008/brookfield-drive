// Packs the Vite build (dist/) into a single self-contained page for hosting:
//   artifact/index.html          page fragment with CSS + JS inlined (host adds doctype/head/body)
//   artifact/data/brookfield.json map data, fetched by relative URL (+ terrain, ground tiles, logos)
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

const page = `${title}
${icon}
<style>
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;

await mkdir(join(OUT, 'data'), { recursive: true });
await writeFile(join(OUT, 'index.html'), page);
await copyFile(join(ROOT, 'public', 'data', 'brookfield.json'), join(OUT, 'data', 'brookfield.json'));
// artifacts don't serve .bin, so ship the terrain grid as base64 JSON (terrain.js falls back to it)
const terrainBin = await readFile(join(ROOT, 'public', 'data', 'terrain.bin'));
await writeFile(join(OUT, 'data', 'terrain.b64.json'), JSON.stringify({ data: terrainBin.toString('base64') }));
// stylized ground tiles + attribution logos are fetched by relative URL (old photo tiles removed)
await rm(join(OUT, 'aerial'), { recursive: true, force: true });
await rm(join(OUT, 'ground'), { recursive: true, force: true });
await cp(join(ROOT, 'public', 'ground'), join(OUT, 'ground'), { recursive: true });
await cp(join(ROOT, 'public', 'attribution'), join(OUT, 'attribution'), { recursive: true });
console.log(`artifact/index.html ${(page.length / 1024).toFixed(0)} KB (+ data/, ground/, attribution/)`);
