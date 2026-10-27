import recorded from '../recorded.json' with { type: 'json' };
const codes = new Set(['return ctx.correct ? 1 : 0;', ...recorded.rules.flatMap(rule => [rule.compiler.code, rule.auditor.code])]);
export class Script {
  private readonly points: (ctx: unknown) => unknown;
  constructor(source: string) {
    const code = source.match(/^Date = undefined; Math.random = undefined; \(function points\(ctx\) \{ "use strict";\n([\s\S]*)\n\}\)\(ctx\)$/)?.[1];
    // Only recorded rule bodies (and the default) run here, after the shared ban-list check.
    // This is NOT a sandbox: never accept arbitrary code. Do not mutate the browser's Date/Math.
    if (!code || !codes.has(code)) throw new Error('Only recorded rules are available in the browser demo');
    this.points = new Function('ctx', '"use strict";\n' + code) as (ctx: unknown) => unknown;
  }
  runInNewContext({ ctx }: { ctx: unknown }) { return this.points(ctx); }
}
