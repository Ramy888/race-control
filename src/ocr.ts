import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { HudRegion } from './config.js';

const execute = promisify(execFile);
export type Execute = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
export type Ocr = (png: string, region: HudRegion) => Promise<string>;
export async function prepareOcr(
  options: { platform?: string; source?: string; binary?: string; execute?: Execute; log?: (message: string) => void } = {},
): Promise<Ocr | undefined> {
  const log = options.log ?? console.error;
  if ((options.platform ?? process.platform) !== 'darwin') { log('Watcher off: macOS Vision OCR requires macOS.'); return; }
  const source = options.source ?? fileURLToPath(new URL('../tools/ocr.swift', import.meta.url));
  const binary = options.binary ?? resolve('.data/bin/ocr');
  const run = options.execute ?? execute;
  const temporary = `${binary}.${process.pid}.tmp`;
  try {
    const sourceTime = (await stat(source)).mtimeMs;
    const binaryTime = await stat(binary).then(s => s.mtimeMs, () => -Infinity);
    if (binaryTime < sourceTime) {
      await mkdir(dirname(binary), { recursive: true });
      try {
        await run('swiftc', ['-O', source, '-o', temporary], { timeout: 60_000 });
        await rename(temporary, binary);
      } finally { await rm(temporary, { force: true }); }
    }
  } catch { log('Watcher off: Swift OCR compilation failed. Install the macOS command-line tools.'); return; }
  return async (png, region) => (await run(binary, [png, ...region.map(String)], { timeout: 5000 })).stdout;
}
