// Packs the Vite build (dist/) into a single self-contained page for hosting:
//   artifact/index.html          page fragment with CSS + JS inlined (host adds doctype/head/body)
//   artifact/data/brookfield.json map data, fetched by relative URL
// Usage: npm run build:artifact
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
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
console.log(`artifact/index.html ${(page.length / 1024).toFixed(0)} KB (+ data/brookfield.json)`);
