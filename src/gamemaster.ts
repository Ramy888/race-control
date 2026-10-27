import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DareContent {
  title: string;
  options: string[];
  target: { stat: 'kills'; count: number };
  stakes: string;
  source: 'ai' | 'fallback' | 'sample';
}
export const sampleDares: DareContent[] = [
  { title: "3 kills with chat's pick", options: ['SHOTGUN · no armor', 'SNIPER · no scope', 'KNIFE ONLY'], target: { stat: 'kills', count: 3 }, stakes: 'Win: streamer picks next loadout. Lose: chat picks.', source: 'sample' },
  { title: "15 kills with chat's pick", options: ['SHOTGUN · no armor', 'SNIPER · no scope', 'KNIFE ONLY'], target: { stat: 'kills', count: 15 }, stakes: 'Lose: give chat a victory salute. Win: take a bow.', source: 'sample' },
];
export type Runner = (args: string[]) => Promise<void>;
export function runCodex(args: string[], launch = spawn, timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = launch('codex', args, { stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Game Master timed out.')); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Game Master exited unsuccessfully.')); });
  });
}
export function validateDare(value: unknown): Omit<DareContent, 'source'> {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const string = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\r\n\x00-\x1f]/.test(v);
  if (!object(value) || Object.keys(value).sort().join() !== 'options,stakes,target,title' ||
      !string(value.title, 45) || !string(value.stakes, 80) || !Array.isArray(value.options) ||
      value.options.length < 2 || value.options.length > 4 || !value.options.every(v => string(v, 24)) ||
      !object(value.target) || Object.keys(value.target).sort().join() !== 'count,stat' || value.target.stat !== 'kills' ||
      !Number.isInteger(value.target.count) || Number(value.target.count) < 3 || Number(value.target.count) > 15) {
    throw new Error('Invalid Game Master dare.');
  }
  return { title: value.title, options: [...value.options], stakes: value.stakes, target: { stat: 'kills', count: Number(value.target.count) } };
}
export interface MasterContext { game: string; previousTitles: string[]; sampleIndex: number; enabled: boolean }
export async function generateDare(context: MasterContext, runner: Runner = runCodex): Promise<DareContent> {
  const sample = structuredClone(sampleDares[context.sampleIndex % sampleDares.length]!);
  if (!context.enabled) return sample;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'race-gamemaster-'));
    const output = join(directory, 'out.json');
    // This context is server-owned: never add chat messages, reasons, or logins.
    const prompt = `Generate one fun, fair solo streamer vs chat dare. Nothing hateful or unsafe. Return only the schema JSON. Title <=45 characters, 2–4 options each <=24 characters, integer kill target 3–15, stakes <=80 characters. All strings must be trimmed. Avoid repeating these recent titles. Trusted context: ${JSON.stringify({ game: context.game, mode: 'solo', previousTitles: context.previousTitles.slice(-5) })}`;
    await runner(['exec', '--ignore-user-config', '--ephemeral', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low', '-s', 'read-only', '--skip-git-repo-check', '--output-schema', fileURLToPath(new URL('./gamemaster.schema.json', import.meta.url)), '-o', output, prompt]);
    return { ...validateDare(JSON.parse(await readFile(output, 'utf8'))), source: 'ai' };
  } catch {
    return { ...sample, source: 'fallback' };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
