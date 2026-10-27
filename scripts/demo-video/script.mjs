// Turns out/cues.json + narration.json into the timed script narrate.py reads (out/narration-en.json).
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = new URL('./out/', import.meta.url).pathname;
const { facts, cues } = JSON.parse(readFileSync(DIR + 'cues.json', 'utf8'));
const text = JSON.parse(readFileSync(new URL('./narration.json', import.meta.url), 'utf8'));
const cases = Number(facts.cases).toLocaleString('en-US');
const say = id => text[id].replaceAll('{cases}', cases);
const segments = cues.flatMap((cue, i) => {
  const start = cue.at + 0.3, end = (i + 1 < cues.length ? cues[i + 1].at : facts.end) - 0.3;
  const extra = text[`${cue.id}+`];
  // a long beat gets its follow-up line once the main line is done (the cloned voice speaks about 15 characters per second)
  const split = start + say(cue.id).length / 15 + 1.2;
  if (!extra || end - split < extra.length / 13 + 0.5) return [{ start: +start.toFixed(2), end: +end.toFixed(2), text: say(cue.id) }];
  return [{ start: +start.toFixed(2), end: +(split - 0.3).toFixed(2), text: say(cue.id) }, { start: +split.toFixed(2), end: +end.toFixed(2), text: extra }];
});
for (const s of segments) {
  const rate = s.text.length / (s.end - s.start);
  console.log(`${s.start.toFixed(1).padStart(6)}–${s.end.toFixed(1).padEnd(6)} ${rate.toFixed(1)} ch/s  ${s.text}`);
}
writeFileSync(DIR + 'narration-en.json', JSON.stringify({ language: 'en', video: 'race-control-silent.mp4', segments }, null, 1));
