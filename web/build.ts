import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const alias = Object.fromEntries(Object.entries({
  'node:crypto': 'crypto', 'node:vm': 'vm', 'node:timers/promises': 'timers',
  'node:child_process': 'unavailable', 'node:fs/promises': 'unavailable',
  'node:os': 'unavailable', 'node:path': 'unavailable', 'node:url': 'unavailable',
}).map(([name, file]) => [name, resolve(`web/stubs/${file}.ts`)]));
export async function buildWeb() {
  await mkdir('web/dist', { recursive: true });
  await build({ entryPoints: ['web/browser.ts'], outfile: 'web/dist/bundle.js', bundle: true,
    platform: 'browser', format: 'iife', target: 'es2022', alias, minify: true,
    define: { 'import.meta.url': '"https://browser.invalid/"' } });
  const html = await readFile('public/demo.html', 'utf8');
  await writeFile('web/dist/index.html', html.replace('<script>', '<script src="./bundle.js"></script>\n<script>')
    .replace('class="playground-banner" hidden', 'class="playground-banner"')
    .replace('src="/hud-test?embed=1"', 'src="./hud-test.html?embed=1"')
    .replace('src="/overlay"', 'src="./overlay.html?browser=1"'));
  await writeFile('web/dist/hud-test.html', await readFile('public/hud-test.html', 'utf8'));
  await writeFile('web/dist/overlay.html', await readFile('public/overlay.html', 'utf8'));
}
if (process.argv[1]?.endsWith('/web/build.ts')) await buildWeb();
