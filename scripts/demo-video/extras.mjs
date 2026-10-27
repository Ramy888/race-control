// Renders the two inserted clips (real Twitch chat, Codex build log) frame by frame from extras.html.
// Needs out/extras/twitch-url.png and twitch-chat.png (crops of a live-test screenshot; gitignored).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch } from './cdp.mjs';

const DIR = new URL('./out/extras/', import.meta.url).pathname;
const FPS = 30;
const SCENES = { twitch: 14, codex: 16 }; // seconds

const b = await launch({ width: 1920, height: 1080, port: 9366 });
await b.goto(new URL('./extras.html', import.meta.url).href, 1500);
await b.evaluate(`document.querySelectorAll('#rec-cursor, #rec-ripple').forEach((e) => e.remove())`); // no pointer in these clips
for (const [scene, seconds] of Object.entries(SCENES)) {
  const frames = DIR + scene + '/';
  rmSync(frames, { recursive: true, force: true }); mkdirSync(frames);
  for (let i = 0; i < seconds * FPS; i++) {
    await b.evaluate(`render(${JSON.stringify(scene)}, ${i / FPS})`);
    const r = await b.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(frames + String(i).padStart(4, '0') + '.png', Buffer.from(r.result.data, 'base64'));
  }
  // same stream shape as race-control-silent.mp4: 1920x1080, 30 fps, yuvj420p, h264
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', frames + '%04d.png',
    '-vf', 'format=yuvj420p', '-c:v', 'libx264', '-crf', '18', '-r', String(FPS), DIR + scene + '.mp4']);
  console.log(scene, seconds, 's');
}
b.close();
process.exit(0);
