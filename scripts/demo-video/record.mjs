// Records the demo video in headless Chrome against a real mock-mode server on :3100 with its own Ledger.
// Real Codex calls (Game Master, Rules Compiler, Auditor); the Watcher reads a real OBS Browser Source.
// Needs OBS running with its WebSocket server on :4455. Run: node scripts/demo-video/record.mjs
// Then (inside scripts/demo-video/out/): ffmpeg -f concat -safe 0 -i list.txt -vf "format=yuv420p" -r 30 -c:v libx264 -crf 18 race-control-silent.mp4
import { launch, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const REPO = new URL('../../', import.meta.url).pathname;
const DIR = new URL('./out/', import.meta.url).pathname;
const RUN = DIR + 'run/';
const PORT = 3100, BASE = `http://127.0.0.1:${PORT}`, SOURCE = 'Demo HUD';
const LEDGER = RUN + '.data/ledger.jsonl';
rmSync(DIR + 'frames', { recursive: true, force: true });
rmSync(RUN + '.data/ledger.jsonl', { force: true });
mkdirSync(DIR + 'frames', { recursive: true }); mkdirSync(RUN + '.data', { recursive: true });

// --- seed three earlier dares, so the rule replay has standings to move
// mock mode uses userId = login, so seeded fans must too
const history = [
  { title: 'Win a fight in Tilted Towers', success: true, yes: ['pixelpanda', 'lootgoblin', 'gg_karim'], no: ['nightowl_tv', 'stormchaser', 'boxfort_bea'] },
  { title: 'Pistols only for 4 kills', success: false, yes: ['lootgoblin', 'stormchaser', 'boxfort_bea'], no: ['pixelpanda', 'sniperella', 'quietmike'] },
  { title: 'No builds, 3 eliminations', success: true, yes: ['lootgoblin', 'boxfort_bea', 'sniperella'], no: ['stormchaser', 'nightowl_tv', 'gg_karim'] },
];
{
  const events = []; let at = Date.now() - 45 * 60_000;
  const add = (agent, type, data) => { at += 20_000; events.push({ seq: events.length + 1, at: new Date(at).toISOString(), agent, type, data }); };
  for (const dare of history) {
    const dareId = randomUUID(), count = 3;
    add('GameMaster', 'dare_opened', { dareId, title: dare.title, options: ['SHOTGUN ONLY', 'SNIPER · no scope', 'PICKAXE START'], target: { stat: 'kills', count },
      voteEndsAt: new Date(at + 30_000).toISOString(), dareEndsAt: new Date(at + 120_000).toISOString() });
    for (const login of dare.yes) add('Chat', 'prediction_cast', { dareId, userId: login, login, yes: true });
    for (const login of dare.no) add('Chat', 'prediction_cast', { dareId, userId: login, login, yes: false });
    add('Referee', 'vote_locked', { dareId, winner: 1 });
    add('Referee', 'progress', { dareId, stat: 'kills', delta: dare.success ? count : 1 });
    add('Referee', 'dare_resolved', { dareId, success: dare.success });
  }
  writeFileSync(LEDGER, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}
const ledger = () => existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const waitFor = async (test, ms, label) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const hit = ledger().findLast(test); if (hit) return hit; }
  throw new Error(`timed out waiting for ${label}`);
};

// --- OBS: a Browser Source the Watcher reads, on top of the scene while recording (OBS renders covered browser sources late)
const obs = (requestType, requestData = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:4455');
  ws.on('error', reject);
  ws.on('message', raw => {
    const { op, d } = JSON.parse(raw);
    if (op === 0) ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } }));
    else if (op === 2) ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: '1', requestData } }));
    else if (op === 7) { ws.close(); resolve(d); }
  });
});
const scene = (await obs('GetCurrentProgramScene')).responseData.currentProgramSceneName;
const hudUrl = n => `${BASE}/hud-test?kills=${n}`;
if (!(await obs('GetInputList')).responseData.inputs.some(i => i.inputName === SOURCE))
  await obs('CreateInput', { sceneName: scene, inputName: SOURCE, inputKind: 'browser_source', inputSettings: { url: hudUrl(0), width: 1920, height: 1080 } });
else await obs('SetInputSettings', { inputName: SOURCE, inputSettings: { url: hudUrl(0) } });
{
  const { sceneItemId } = (await obs('GetSceneItemId', { sceneName: scene, sourceName: SOURCE })).responseData;
  const top = (await obs('GetSceneItemList', { sceneName: scene })).responseData.sceneItems.length - 1;
  await obs('SetSceneItemIndex', { sceneName: scene, sceneItemId, sceneItemIndex: top });
}

// --- the real server, in mock mode
const server = spawn(`${REPO}node_modules/.bin/tsx`, [`${REPO}src/main.ts`], {
  cwd: RUN, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MOCK: '1', PORT: String(PORT), BROADCASTER_LOGIN: 'streamer', GAME: 'Fortnite', GAMEMASTER: 'on',
    WATCHER_SOURCE: SOURCE, HUD_REGION: '0.85,0.1,0.1,0.1', WATCHER_MS: '2000' },
});
let ready = false; const botLines = [];
const onLine = line => {
  console.log('  server:', line);
  if (line.startsWith('Watcher:')) ready = true;
  if (line.startsWith('[chat] ')) botLines.push(line.slice(7));
};
let buffer = '';
server.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { onLine(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
server.stderr.on('data', chunk => console.error('  server!', String(chunk).trim()));
for (let i = 0; i < 120 && !ready; i++) await sleep(250);
if (!ready) throw new Error('server did not start');
for (let i = 0; ; i++) {
  const shot = await obs('GetSourceScreenshot', { sourceName: SOURCE, imageFormat: 'png', imageWidth: 320 });
  if (shot.requestStatus.result) break;
  if (i === 20) throw new Error('OBS cannot capture ' + SOURCE + ': ' + shot.requestStatus.comment);
  await sleep(500);
}
await obs('PressInputPropertiesButton', { inputName: SOURCE, propertyName: 'refreshnocache' });

const b = await launch({ width: 1920, height: 1080, port: 9355 });
const cues = [];
const cue = id => { cues.push({ id, at: b.mark() }); console.log(b.mark().toFixed(1), id); };
const say = (who, text, kind = '') => b.evaluate(`chat(${JSON.stringify(who)}, ${JSON.stringify(text)}, ${JSON.stringify(kind)})`);
const caption = (step, title, sub) => b.evaluate(`caption(${JSON.stringify(step)}, ${JSON.stringify(title)}, ${JSON.stringify(sub)})`);
const post = async (user, text) => {
  await say(user, text, user === 'streamer' ? 'host' : '');
  const r = await fetch(BASE + '/mock/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, text }) });
  if (!r.ok) throw new Error(`mock chat ${r.status}`);
};
// bot replies printed by the server appear in the chat column
let muted = false; const held = []; // lines from a paused compile wait; failures and retries stay off camera
const pump = setInterval(() => { while (botLines.length) { const line = botLines.shift(); if (muted) held.push(line); else void say('RaceControl', line, 'bot'); } }, 100);
// each beat lasts long enough for its narration (about 13 characters per second)
const NARRATION = JSON.parse(readFileSync(new URL('./narration.json', import.meta.url), 'utf8'));
const hold = async id => {
  const start = cues.findLast(c => c.id === id).at, need = NARRATION[id].replaceAll('{cases}', 'two thousand three hundred and four').length / 13 + 0.9;
  while (b.mark() - start < need) await sleep(100);
};
const setKills = async n => { await obs('SetInputSettings', { inputName: SOURCE, inputSettings: { url: hudUrl(n) } }); await b.evaluate(`setKills(${n})`); };

await b.goto(`file://${new URL('./stage.html', import.meta.url).pathname}`, 1500);
await b.evaluate(`setup(${JSON.stringify(BASE)})`);
await sleep(4000);
await b.startRec();

cue('intro');
await caption('RACE CONTROL', 'An AI referee and game master for Twitch', 'Solo mode: one streamer against their own chat. Every agent hand-off shows on the overlay.');
await hold('intro');

cue('dare');
await caption('1 · GAME MASTER', 'The streamer asks for a dare', 'A live Codex call (gpt-6-luna) writes it for this game. Chat text never reaches the prompt.');
await sleep(1200); await post('streamer', '!dare'); await sleep(1800);
b.pause();
const proposal = await waitFor(e => e.type === 'dare_proposed', 60_000, 'proposal');
await sleep(800); await b.resume(); await sleep(1500);
await hold('dare');

cue('approve');
await caption('2 · COMMISSIONER', 'The streamer stays in charge', 'Nothing goes live without !approve. !reroll asks the Game Master for another dare.');
await sleep(2200); await post('streamer', '!approve'); await sleep(1500);
await hold('approve');

cue('vote');
await caption('3 · CHAT VOTES', 'Chat picks the loadout and predicts the result', 'Vote with a number, the option’s first word, or !pick N. !yes / !no predicts whether the streamer makes it.');
const options = proposal.data.options, words = options.map(o => o.split(/\s+/)[0].toLowerCase());
const word = i => (words.filter(w => w === words[i]).length === 1 ? words[i] : String(i + 1));
const second = Math.min(1, options.length - 1), third = Math.min(2, options.length - 1);
const crowd = [
  ['pixelpanda', '1'], ['lootgoblin', word(second)], ['gg_karim', `!pick ${second + 1}`], ['sniperella', '1'], ['nightowl_tv', 'lets gooo'],
  ['boxfort_bea', String(second + 1)], ['stormchaser', `!pick ${third + 1}`], ['nightowl_tv', word(second)], ['quietmike', '1'],
  ['lootgoblin', '!yes'], ['pixelpanda', '!no'], ['stormchaser', '!yes'], ['gg_karim', '!yes'], ['quietmike', '!no'],
  ['boxfort_bea', '!yes'], ['sniperella', '!no'], ['nightowl_tv', '!yes'],
];
for (const [user, text] of crowd) { await post(user, text); await sleep(650); }
await hold('vote');
b.pause();
const opened = await waitFor(e => e.type === 'dare_opened', 5_000, 'dare');
await waitFor(e => e.type === 'vote_locked' && e.data.dareId === opened.data.dareId, 60_000, 'vote lock');
await sleep(600); await b.resume();

cue('locked');
await caption('4 · REFEREE', 'Vote locked. From here, nobody types kills', `${opened.data.target.count} kills to win. The Referee holds the clock.`);
await sleep(1500);
await hold('locked');

cue('watcher');
await caption('5 · WATCHER', 'Kills come from the game HUD, not from chat', 'A test HUD stands in for the game here. OBS frames + on-device macOS Vision OCR; two matching reads per kill.');
const target = opened.data.target.count, step = target <= 6 ? 1 : Math.ceil(target / 5);
const progress = () => ledger().filter(e => e.type === 'progress' && e.data.dareId === opened.data.dareId).reduce((s, e) => s + e.data.delta, 0);
await sleep(4500); // the Watcher's baseline: two stable reads of 0
for (let k = step; ; k = Math.min(target, k + step)) {
  await setKills(k);
  for (const end = Date.now() + 12_000; Date.now() < end && progress() < k; ) await sleep(200);
  await sleep(700);
  if (k >= target) break;
}
await waitFor(e => e.type === 'dare_resolved' && e.data.dareId === opened.data.dareId, 30_000, 'dare result');
await hold('watcher');

cue('won');
await caption('6 · LEDGER', 'Dare won. Fans who called it score', 'Every score is derived by replaying an append-only Ledger.');
await sleep(1500);
await hold('won');

cue('rule');
await caption('7 · RULES COMPILER', 'The streamer changes the rules, in plain English', '!rule wrong calls lose a point');
await sleep(1200); await post('streamer', '!rule wrong calls lose a point'); await sleep(1500);
await hold('rule');

cue('audit');
await caption('8 · AUDITOR', 'Two Codex models write it independently', 'Rules Compiler: gpt-6-luna. Auditor: gpt-6-sol. Neither sees the other’s code; both must pass every case.');
await sleep(1500);
b.pause();
let audit;
muted = true;
for (let attempt = 1; ; attempt++) {
  const after = ledger().length;
  if (attempt > 1) { held.length = 0; await fetch(BASE + '/mock/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'streamer', text: '!rule wrong calls lose a point' }) }); }
  audit = await waitFor(e => e.seq > (attempt > 1 ? after : 0) && (e.type === 'rule_audited' || e.type === 'rule_failed'), 90_000, 'audit');
  await sleep(1500);
  if (audit.type === 'rule_audited' && !audit.data.mismatches) break;
  console.log('compile attempt', attempt, 'failed:', JSON.stringify(audit.data));
  if (attempt === 3) throw new Error('audit did not pass');
}
muted = false;
for (const line of held.splice(0)) if (!/Rule failed|is writing/.test(line)) await say('RaceControl', line, 'bot');
await sleep(1200); await b.resume(); await sleep(1500);
await hold('audit');

cue('adopt');
await caption('9 · COMMISSIONER', `Audit passed ${audit.data.cases}/${audit.data.cases}`, 'The streamer sees the re-scored standings first, then adopts the rule.');
await sleep(3500); await post('streamer', '!adopt'); await sleep(1200);
await hold('adopt');

cue('replay');
await caption('10 · REPLAY', 'The whole stream is re-scored', 'Standings are replayed from the Ledger under the new house rule.');
await sleep(1500);
await hold('replay');

cue('outro');
await caption('BUILT WITH CODEX', 'One Codex thread built it. Codex runs three of its agents live.', 'Game Master · Rules Compiler · Auditor, with the Watcher, Referee, Commissioner and Ledger.');
await hold('outro'); await sleep(1500);

const { frames, end } = await b.stopRec();
clearInterval(pump); b.close(); server.kill('SIGINT');
await obs('RemoveInput', { inputName: SOURCE });

// frames -> constant 30 fps: each output slot shows the newest frame captured by then
const FPS = 30, start = frames[0].t, slots = Math.ceil((end - start) * FPS);
const list = []; let j = 0; const written = new Map();
for (let s = 0; s < slots; s++) {
  const t = start + s / FPS;
  while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
  if (!written.has(j)) { const name = `frames/${String(j).padStart(5, '0')}.jpg`; writeFileSync(DIR + name, Buffer.from(frames[j].data, 'base64')); written.set(j, name); }
  list.push(`file '${written.get(j)}'`, `duration ${(1 / FPS).toFixed(6)}`);
}
list.push(list[list.length - 2]);
writeFileSync(DIR + 'list.txt', list.join('\n') + '\n');
const facts = { cases: audit.data.cases, target, title: opened.data.title, source: opened.data.source, end: end - start };
writeFileSync(DIR + 'cues.json', JSON.stringify({ facts, cues: cues.map(c => ({ id: c.id, at: Math.max(0, c.at - start) })) }, null, 1));
console.log(`frames ${frames.length}, length ${(end - start).toFixed(1)} s`, facts);
process.exit(0);
