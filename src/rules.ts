import { Script } from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { runCodex, type Runner } from './gamemaster.js';

export interface RuleContext {
  correct: boolean; yes: boolean; success: boolean; overruled: boolean;
  yesCount: number; noCount: number; target: number; progress: number;
}
export interface RuleExample { ctx: RuleContext; expected: number }
export interface RuleOutput { code: string; examples: RuleExample[] }
export interface RuleSpec extends RuleOutput { ruleId: string; text: string }
export interface Audit {
  cases: number; mismatches: number;
  firstMismatch?: { ctx: RuleContext; compiler: number; auditor: number };
}
export interface PendingRule extends RuleSpec { expiresAt: string; audit?: Audit }
export const defaultCode = 'return ctx.correct ? 1 : 0;';
const banned = /\b(this|constructor|prototype|__proto__|globalThis|process|require|import|eval|Function|while|for)\b/;
const fields = 'correct:boolean, yes:boolean, success:boolean, overruled:boolean, yesCount:integer, noCount:integer, target:integer, progress:integer';
const booleanKeys = ['correct', 'yes', 'success', 'overruled'] as const;
const integerKeys = ['yesCount', 'noCount', 'target', 'progress'] as const;
const cache = new Map<string, { code: string; script: Script; results: Map<string, { points: number; valid: boolean }> }>();

export function compilePoints(ruleId: string, code: string) {
  if (typeof code !== 'string' || !code.trim() || code.length > 600) throw new Error('invalid output');
  if (banned.test(code)) throw new Error('banned code');
  const cached = cache.get(ruleId);
  if (cached?.code === code) return cached;
  // shortcut: node:vm is not a security boundary; input is broadcaster-only and Codex-generated, behind a ban-list and audit. Upgrade to a worker or isolate before accepting rules from anyone else.
  const script = new Script(`Date = undefined; Math.random = undefined; (function points(ctx) { "use strict";\n${code}\n})(ctx)`);
  const compiled = { code, script, results: new Map<string, { points: number; valid: boolean }>() };
  cache.set(ruleId, compiled);
  return compiled;
}

export function evaluate(ruleId: string, code: string, context: RuleContext): { points: number; valid: boolean } {
  try {
    const compiled = compilePoints(ruleId, code);
    // Copy only the contract's primitives into a null-prototype object: a host prototype would hand the VM the host Function.
    const ctx = Object.freeze(Object.assign(Object.create(null), Object.fromEntries([...booleanKeys, ...integerKeys].map(key => [key, context[key]]))));
    const key = JSON.stringify(ctx);
    const previous = compiled.results.get(key);
    if (previous) return previous;
    let result: { points: number; valid: boolean };
    try {
      const value: unknown = compiled.script.runInNewContext({ ctx }, {
        timeout: 50, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
      });
      const valid = typeof value === 'number' && Number.isInteger(value) && value >= -10 && value <= 10;
      result = { points: valid ? value as number : 0, valid };
    } catch { result = { points: 0, valid: false }; }
    compiled.results.set(key, result);
    return result;
  } catch { return { points: 0, valid: false }; }
}

export function validateRule(value: unknown): RuleOutput {
  if (!value || typeof value !== 'object') throw new Error('invalid output');
  const output = value as RuleOutput;
  if (Object.keys(output).sort().join() !== 'code,examples' || typeof output.code !== 'string' ||
      !output.code.trim() || output.code.length > 600 || !Array.isArray(output.examples) ||
      output.examples.length < 3 || output.examples.length > 6) throw new Error('invalid output');
  for (const example of output.examples) {
    if (!example || Object.keys(example).sort().join() !== 'ctx,expected' || !example.ctx ||
        Object.keys(example.ctx).sort().join() !== [...booleanKeys, ...integerKeys].sort().join() ||
        !booleanKeys.every(key => typeof example.ctx[key] === 'boolean') ||
        !integerKeys.every(key => Number.isSafeInteger(example.ctx[key]) && example.ctx[key] >= 0) ||
        !Number.isInteger(example.expected) || example.expected < -10 || example.expected > 10) throw new Error('invalid output');
  }
  return structuredClone(output);
}

export async function compileRule(text: string, runner: Runner = args => runCodex(args, undefined, 40_000)) {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'race-rules-'));
    const contract = `Return JSON {code, examples}. "code" is ONLY the JavaScript statements of the body of function points(ctx): no prose, no examples, no comments, <=600 chars, returning an integer -10..10. "examples" holds 3–6 {ctx, expected} cases. ctx fields (${fields}): correct = the fan's prediction matched the dare result; yes = the fan predicted the streamer wins; success = the dare was won; overruled = the streamer overruled the result; yesCount/noCount = how many fans predicted yes/no on that dare; target = kills needed; progress = kills made. Default rule (+1 per correct call): ${defaultCode} If the rule is ambiguous, pick the most natural reading; never ask questions. No randomness, time, async, or external state. Forbidden words: ${banned.source}. Broadcaster rule: ${JSON.stringify(text)}`;
    const compile = async (model: string, instruction: string, filename: string) => {
      const output = join(directory!, filename);
      await runner(['exec', '--ignore-user-config', '--ephemeral', '-m', model, '-c', 'model_reasoning_effort=low', '-s', 'read-only', '--skip-git-repo-check', '--output-schema', fileURLToPath(new URL('./rules.schema.json', import.meta.url)), '-o', output, `${instruction}\n${contract}`]);
      return validateRule(JSON.parse(await readFile(output, 'utf8')));
    };
    // Wait for both children even if one fails, before removing their output directory.
    const results = await Promise.allSettled([
      compile('gpt-6-luna', 'You are the Rules Compiler. Implement the intended fan scoring rule.', 'compiler.json'),
      compile('gpt-6-sol', 'Independently interpret this scoring policy as an Auditor. Derive your own implementation and examples; no other implementation is available.', 'auditor.json'),
    ]);
    if (results[0].status === 'rejected' || results[1].status === 'rejected') throw new Error('compilation failed');
    return { compiler: results[0].value, auditor: results[1].value };
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

export function syntheticContexts(): RuleContext[] {
  const cases: RuleContext[] = [];
  for (const correct of [false, true]) for (const yes of [false, true])
    for (const success of [false, true]) for (const overruled of [false, true])
      for (const yesCount of [0, 1, 3, 10]) for (const noCount of [0, 1, 3, 10])
        for (const target of [3, 8, 15]) for (const progress of [0, target - 1, target]) {
          cases.push({ correct, yes, success, overruled, yesCount, noCount, target, progress });
        }
  return cases;
}

export async function auditRule(ruleId: string, compiler: RuleOutput, auditor: RuleOutput, contexts: RuleContext[]): Promise<Audit> {
  compilePoints(ruleId, compiler.code); compilePoints(`${ruleId}:auditor`, auditor.code);
  for (const example of [...compiler.examples, ...auditor.examples]) {
    for (const [id, code] of [[ruleId, compiler.code], [`${ruleId}:auditor`, auditor.code]] as const) {
      const result = evaluate(id, code, example.ctx);
      if (!result.valid || result.points !== example.expected) throw new Error('failed examples');
    }
  }
  const key = (ctx: RuleContext) => [...booleanKeys, ...integerKeys].map(field => ctx[field]).join(',');
  const cases = new Map([...contexts, ...syntheticContexts()].map(ctx => [key(ctx), ctx]));
  const audit: Audit = { cases: cases.size, mismatches: 0 };
  let index = 0;
  for (const ctx of cases.values()) {
    const a = evaluate(ruleId, compiler.code, ctx), b = evaluate(`${ruleId}:auditor`, auditor.code, ctx);
    if (!a.valid || !b.valid || a.points !== b.points) {
      audit.mismatches++;
      audit.firstMismatch ??= { ctx: structuredClone(ctx), compiler: a.points, auditor: b.points };
    }
    if (++index % 32 === 0) await yieldTurn(); // Keep chat and deadlines responsive during VM work.
  }
  return audit;
}

export type FanScores = Record<string, { login: string; score: number }>;
export function rankedFans(scores: FanScores) {
  return Object.entries(scores).map(([id, fan]) => ({ id, ...fan }))
    .sort((a, b) => b.score - a.score || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
}
export function rankChanges(before: FanScores, after: FanScores): string[] {
  const old = new Map(rankedFans(before).map((fan, index) => [fan.id, index + 1]));
  return rankedFans(after).flatMap((fan, index) => old.get(fan.id) !== index + 1 ? [`${fan.login} ${old.get(fan.id)}→${index + 1}`] : []).slice(0, 3);
}
