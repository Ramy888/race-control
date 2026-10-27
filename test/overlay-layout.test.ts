import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('declared overlay bounds leave Fortnite HUD and central action zones clear', async () => {
  const html = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const reserved = [
    { name: 'minimap', x: 1480, y: 0, w: 440, h: 380 },
    { name: 'health', x: 0, y: 900, w: 720, h: 180 },
    { name: 'inventory', x: 1240, y: 880, w: 680, h: 200 },
    { name: 'action', x: 660, y: 340, w: 600, h: 400 },
  ];
  for (const selector of ['.left', '.right', 'footer']) {
    const block = css.match(new RegExp(`(?:^|[}\\s])${selector.replace('.', '\\.')}\\{([^}]+)\\}`))?.[1];
    assert.ok(block, `${selector} has explicit layout declarations`);
    const px = (property: string) => {
      const match = block.match(new RegExp(`(?:^|;)${property}:(\\d+)px(?:;|$)`));
      return match ? Number(match[1]) : undefined;
    };
    const w = px('width'), h = px('height') ?? px('max-height');
    assert.ok(w && h, `${selector} declares bounded dimensions`);
    const x = px('left') ?? (1920 - px('right')! - w);
    const y = px('top') ?? (1080 - px('bottom')! - h);
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    assert.ok(x >= 0 && y >= 0 && x + w <= 1920 && y + h <= 1080);
    assert.match(block, /overflow:hidden/, 'content cannot paint beyond the declared box');
    for (const zone of reserved) {
      const overlaps: boolean = x < zone.x + zone.w && x + w > zone.x && y < zone.y + zone.h && y + h > zone.y;
      assert.equal(overlaps, false, `${selector} must not cover ${zone.name}`);
    }
    if (selector === '.left') { assert.equal(x, 36); assert.equal(y, 36); assert.ok(y + h < 880); }
    if (selector === '.right') { assert.equal(px('right'), 36); assert.equal(y, 400); }
    if (selector === 'footer') { assert.equal(x, 740); assert.equal(x + w, 1180); assert.equal(px('bottom'), 24); }
  }
  assert.match(css, /\.agent:nth-last-child\(n\+4\)\{display:none\}/, 'only the latest three feed rows are visible');
});
