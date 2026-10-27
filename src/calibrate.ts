import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WatcherConfig } from './config.js';
import type { Ocr } from './ocr.js';

export async function calibrate(
  config: WatcherConfig, screenshot: (source: string) => Promise<Buffer>, ocr: Ocr, output = '.data/hud.png',
) {
  if (!config.source) throw new Error('Set WATCHER_SOURCE before calibrating.');
  const png = await screenshot(config.source);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, png, { mode: 0o600 });
  return { full: await ocr(output, [0, 0, 1, 1]), region: await ocr(output, config.region) };
}
