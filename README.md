# Race Control

## Try it in 2 minutes (judges)

Requirements: **Node.js 22+**. The Codex CLI is optional: a logged-in `codex` enables the live Game Master and `!rule`. No Twitch app, OBS, or Codex login is required for the dare loop.

```sh
git clone https://github.com/Ramy888/race-control.git
cd race-control
npm install
npm run demo
```

Open **http://127.0.0.1:3000/demo** and press **Auto-play**. If 3000 is busy, use `PORT=3001 npm run demo` and open **http://127.0.0.1:3001/demo**. The launcher prints both page URLs; it does not open a browser.

- A generated dare (or labelled fallback sample), streamer approval, then six viewers voting and predicting.
- Simulated kills, a resolved dare, fan scores, and the agents' hand-offs in the live overlay.
- A compiled/audited rule and retroactive standings after adoption when Codex is available; otherwise a clear message explains that rule compilation needs Codex.

`npm run demo` starts fresh in **`.data/demo.jsonl`**, never the live `.data/ledger.jsonl`. **Reset demo** clears only that demo Ledger, cancels acceptance of old AI results, and starts a new loop. The vote lasts 10 seconds; the dare lasts 6 seconds per target kill, with a 20-second minimum. The Watcher stays off unless `WATCHER_SOURCE` is set. Missing CLI or authentication falls back to sample dares; a detected CLI may still need login/model access.

`npm test` runs all tests offline, with injected AI/OCR runners and localhost mock servers. No real Twitch, OBS, or Codex calls are needed.

Hosted demo: (coming soon)

Race Control is a local AI game master and referee for a solo Twitch streamer versus their chat. Chat votes on a dare, the streamer approves it, and the Watcher reads kills from the game's HUD through OBS. The Ledger records the result and derives fan standings by replay; the streamer can also adopt a Codex-compiled scoring rule after an independent audit. An OBS overlay shows the dare, predictions, standings, and agent hand-offs.

## Agents

| Agent | Role | Source |
| --- | --- | --- |
| Game Master | Generates a dare with Codex, with sample fallbacks. | [gamemaster.ts](src/gamemaster.ts) |
| Commissioner | The streamer approves/rerolls dares, adopts/rejects rules, and overrules results. | [dares.ts](src/dares.ts) |
| Rules Compiler | Compiles the streamer's scoring instructions into a JavaScript scoring hook. | [rules.ts](src/rules.ts) |
| Auditor | Independently compiles the same rule and compares examples, history, and synthetic cases. | [rules.ts](src/rules.ts) |
| Watcher | Reads the kill counter from OBS frames using local macOS Vision OCR. | [watcher.ts](src/watcher.ts), [ocr.swift](tools/ocr.swift) |
| Referee | Locks votes, resolves dares, and expires pending proposals. | [dares.ts](src/dares.ts) |
| Ledger | Appends events and replays history to derive state and fan scores. | [ledger.ts](src/ledger.ts) |

## Demo in 2 minutes

### Try it without Twitch

Run this demo when the live bot is not using the shared port and Ledger. The sample dare works offline; the final `!rule` step needs an installed, authenticated Codex CLI.

No Twitch registration, credentials, tokens, or Twitch CLI are needed. Install dependencies once with `npm install`, then:

```sh
BROADCASTER_LOGIN=streamer GAMEMASTER=off npm run mock
```

The mock server binds **127.0.0.1 only**, using `PORT` (default `3000`) and `BROADCASTER_LOGIN` (default `streamer`). Twitch config is ignored; `GAME` and `GAMEMASTER` still apply. Set `GAMEMASTER=off` for fully offline sample dares. Replies appear in the terminal prefixed with `[chat]`. Mock logins are normalized to lowercase, with `userId = login`.

In another terminal, request a dare as the streamer, approve the proposal, then invite the simulated crowd:

```sh
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!dare"}'
# Wait for the proposal, then approve it:
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!approve"}'
npm run crowd -- 20
```

`crowd` is a **simulator for demos without a live audience**. Each of 20 viewers sends a random `!pick N`, then `!yes` or `!no`, with small random delays. It can run before a dare, but those votes will be ignored; run it during the vote to see a tally. It uses `PORT` from `.env`. Repeating it reuses the same viewer identities, replacing their votes rather than adding extra voters.

With a fresh Ledger, the first sample has a **30-second vote**, then **90 seconds to get 3 kills**. Wait for “Vote locked”. With the Watcher configured, use the [Test HUD](#test-hud-for-demos-without-a-game) to add three kills after its baseline settles. Otherwise, run this manual correction three times (do not also count those kills through OCR):

```sh
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!kill"}'
```

The third kill resolves the dare early. Now change the scoring rule, wait for “Rule ready” and the before/after preview, then adopt it:

```sh
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!rule wrong calls lose a point"}'
# Wait for the matching audit before adopting:
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!adopt"}'
```

Every resolved dare is re-scored. To demonstrate a failure instead, let the dare deadline expire. After resolution, you can flip the result and recalculate fan scores:

```sh
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!overrule HUD reading was wrong"}'
```

If you configured a different broadcaster login or port, substitute it in the curl commands. Another `!dare` proposes the next sample: a 30-second vote, then 7:30 for 15 kills after approval. Samples alternate (including rerolls), with the next sample index recovered from the Ledger.

### Commands

| Command | Who | When |
| --- | --- | --- |
| `!ping`, `!race` | Anyone | Always |
| `!pick N`, bare `1`–`4`, or a unique option first word (e.g. `shotgun`) | Anyone | Voting; one current vote per user; later votes replace earlier ones |
| `!yes`, `!no` | Anyone | Voting or running; replaces that user's prediction |
| `!dare` | Broadcaster | Generate a proposal when idle/resolved; duplicates while thinking are ignored |
| `!approve` | Broadcaster | Approve the pending proposal and start voting |
| `!reroll` | Broadcaster | Replace the pending proposal; unavailable while thinking |
| `!kill` | Broadcaster | Running; adds one kill |
| `!overrule <reason>` | Broadcaster | Resolved; flips the result |
| `!rule` | Anyone | Show the current house rule |
| `!rule <text>` | Broadcaster | Compile a 3–200 character scoring rule; one compile/proposal at a time |
| `!adopt` | Broadcaster | Adopt a pending rule after a matching audit; replay every resolved dare |
| `!reject` | Broadcaster | Discard the pending rule |
| `!rule reset` | Broadcaster | Restore default +1 for correct predictions; no Codex call |

Broadcaster permission compares the login case-insensitively in both modes. Mock mode deliberately trusts the submitted login so a demo can act as the streamer. HTTP 200 means input was accepted; commands without permission or in the wrong phase are silently ignored. Invalid users and text longer than 500 characters return HTTP 400.

## AI Game Master and approval

With `GAMEMASTER=on` (default), install and authenticate the Codex CLI so `codex` is on PATH. `GAME` defaults to `Fortnite`. Both live and mock modes use the same generator. Only the broadcaster can approve or reroll.

`!dare` replies “Game Master is thinking…” and runs `codex exec` with `gpt-6-luna`, low reasoning effort, a read-only sandbox, ephemeral execution, and a JSON schema. Generation runs outside the command queue. The prompt contains only the configured game, solo mode, recent dare titles, and fixed safety/size limits—never viewer messages or overrule reasons. Output is strictly validated, and temporary output files are removed. A 25-second timeout, failed process, or invalid output uses the next sample marked as a fallback. `GAMEMASTER=off` always uses samples without starting Codex.

Review the proposed title, options, and stakes in chat or the overlay. `!approve` starts a **30-second vote**; `!reroll` requests a replacement. Proposals expire after **120 seconds**, including across restarts. Voting and predictions start only after approval. The running deadline is **target × 30 seconds**, clamped to 90–600 seconds; the model cannot set timings. Stakes are descriptive and manually honored by the streamer.

## Rules Compiler and Auditor

After some dares have resolved, try either of these in chat as the broadcaster:

```text
!rule underdogs score double: if fewer people picked your side, correct calls get 2
!rule wrong calls lose a point
```

Send one rule at a time. The bot replies “Rules Compiler is writing it…” while chat and dare timers continue. Two independent Codex calls run in parallel: `gpt-6-luna` compiles, and `gpt-6-sol` independently interprets the same rule without seeing the compiler's code. Both use low reasoning effort, a read-only sandbox, schema-constrained output, and a 40-second timeout. Rules require an authenticated Codex CLI in both modes; `GAMEMASTER=off` disables AI dares only.

The Auditor checks both sets of model-derived examples, every resolved prediction context in the Ledger, and a deduplicated grid of 2,304 synthetic contexts. A disagreement clears the proposal; invalid output or failed examples record a short fixed failure reason. Matching output produces an overlay preview of the top five before/after and a chat summary of up to three rank changes. Type `!adopt` to apply it or `!reject` to discard it. Pending rules expire after 120 seconds, and restart re-arms that deadline. If interrupted between proposal and audit writes, adoption stays disabled until rejection or expiry.

Adoption **re-scores the entire stream**, including earlier dares and overrules. One rule is active at a time. `!rule reset` clears it (and any pending proposal), cancels acceptance of an in-flight result, and restores the original +1/0 scoring without Codex. Replacing a rule always starts from Ledger history, never from previously accumulated points.

The only hook is `points(ctx)`: `{ correct, yes, success, overruled, yesCount, noCount, target, progress }`. The first four fields are booleans; the rest are integers. Counts refer to the final predictions on that dare; `target` is the kill target, not an object. No identities or text enter the scoring context. The body is limited to 600 characters, ban-list checked, compiled/cached once per rule, and evaluated in `node:vm` with a frozen input, disabled string/Wasm code generation, and a 50 ms timeout. Throws, timeouts, and results outside integer −10…10 score zero and log once per rule per process. Replay reports errors as data; logging happens outside replay.

`node:vm` is a demo shortcut, **not a security boundary**. Rules are broadcaster-only and Codex-generated, behind the ban-list and audit. Move execution to a worker or isolate before accepting rules from anyone else. The audit establishes agreement on the tested cases; the streamer still decides whether to adopt the interpretation.

## OBS setup

Start the local service in mock or live mode, then arrange these sources in OBS (top source renders above the others):

| Layer | Source | URL / settings |
| --- | --- | --- |
| Above | **Race Control overlay**, Browser Source | **http://127.0.0.1:3000/overlay**, Width **1920**, Height **1080** |
| Below | **Test HUD**, Browser Source, for demos without a game | **http://127.0.0.1:3000/hud-test?kills=0**, Width **1920**, Height **1080** |

For Fortnite, replace the Test HUD layer with your game capture at 1920×1080. Set `WATCHER_SOURCE` to **Test HUD** or the game capture's exact source name—not the combined scene or overlay. The Watcher screenshots that source by itself, so the overlay never blocks OCR.

The transparent overlay puts the dare and predictions on the left, fans and rules below the minimap on the right, and the latest three agent events in a small bottom-centre strip. It leaves Fortnite's top-right HUD, health/shields, inventory, and central action area clear. Smaller viewports retain the 1920×1080 scale-to-fit behaviour. The Test HUD's `?kills=N` sets its starting count (0–999), for example **http://127.0.0.1:3000/hud-test?kills=7**.

**Blank Browser Source on macOS:** untick **Settings → Advanced → Enable Browser Source Hardware Acceleration**, click **Apply**, and fully quit OBS with **⌘Q** before reopening it. Closing the window is not enough.

### OBS overlay

Snapshots arrive over `/overlay/ws` immediately, after Ledger writes, and once per second during active dares. Countdowns use server time. On a `tsx watch` restart the overlay reconnects automatically with backoff; a disconnected countdown freezes and shows a reconnect notice. Resolved dares retain their outcome and OVERRULED tag across restarts.

The snapshot includes only public aggregates and fan logins/scores, never user IDs or individual vote/prediction maps. Both modes bind to `127.0.0.1`; `/mock/chat` exists only in mock mode. Replace port 3000 if you configured another `PORT`.

The single HTML file uses the reference's Barlow Condensed, Inter, and JetBrains Mono fonts via Google Fonts, with local fallbacks if offline. No build step or frontend dependencies are needed.

## Watcher (OBS HUD)

The Watcher is optional and runs in both live and mock modes. It uses OBS screenshots and **macOS-only**, on-device Vision OCR: no paid API, cloud OCR, or new npm packages. Swift and the macOS command-line tools must be installed (`swiftc --version`; install the tools with `xcode-select --install` if needed). The Swift helper compiles to `.data/bin/ocr` on first use or when its source changes. On other operating systems, or if compilation fails, the Watcher stays off with one log line; manual `!kill` still works.

1. In OBS, open **Tools → WebSocket Server Settings**, enable the v5 server, and use port **4455**. If authentication is enabled, supply the matching `OBS_PASSWORD` in your local `.env`; leave it empty when authentication is off.
2. Set these values in your local `.env` (the checked-in `.env.example` documents them):

   ```dotenv
   OBS_URL=ws://127.0.0.1:4455
   OBS_PASSWORD=
   WATCHER_SOURCE=Test HUD
   HUD_REGION=0.85,0.1,0.1,0.1
   WATCHER_MS=2000
   ```

   Replace `Test HUD` with the exact isolated game-capture source name for a real game. Empty `WATCHER_SOURCE` disables the Watcher. Start/restart the service when you want these settings applied. It logs the selected source, region and interval, never the password. OBS can start later; the client retries lost connections with backoff.

### Test HUD for demos without a game

Add the **Test HUD** Browser Source as described in [OBS setup](#obs-setup). The page is a game-like test frame, not real game footage. Its numeric box is at `(1632,108)` with size `192×108`; the default `HUD_REGION` matches it, with the TEST HUD and ELIMINATIONS labels outside the crop.

Use OBS's **Interact** command on that source, click inside, then press **Space** or **K** to add a kill and **R** to reset. Interacting with a separate browser tab changes only that tab, not OBS's instance. Request and approve a dare as usual. After voting locks, leave the counter unchanged for two reads (roughly 4–6 seconds) to establish the baseline. Then add kills and let the counter remain stable long enough for two matching reads. The agent feed shows `HUD: kills N/target`, and reaching the target resolves the dare automatically. `GAMEMASTER=off` makes this demo use sample dares without Codex.

### Calibration for a real game

```sh
npm run hud:calibrate
```

This takes one screenshot of `WATCHER_SOURCE`, saves **`.data/hud.png`**, and prints OCR for the full frame and then the selected region. It needs OBS and macOS OCR, but does not need Twitch credentials or a running dare. Inspect the saved image and tighten `HUD_REGION=x,y,w,h` around only the digits of the kill counter. Coordinates are fractions of the source image with a **top-left origin**: divide horizontal pixels by image width and vertical pixels by height. Width/height must be positive and the whole rectangle must fit within 0–1. Repeat calibration until the region reads the intended number, then apply that region on your next bot restart. Images and the compiled binary stay in gitignored `.data/`.

Only a running dare is sampled. Polls never overlap; a slow screenshot/OCR read skips intervening poll ticks. Two matching readable samples establish a value; unreadable frames are skipped. A rise of 1–5 adds the difference; larger jumps are ignored and logged once per dare. A stable decrease (a new match) establishes a new baseline. Each new dare and each process restart starts with a fresh baseline, so kills during downtime are not reconstructed. `!kill` remains an additive manual correction—avoid manually adding a kill that OCR will also count. Both request and OCR execution time out after five seconds; screenshot temp files are removed after each read.

## Ledger and restart behavior

`.data/ledger.jsonl` stores `{ seq, at, agent, type, data }` records. State is derived only by pure `replay`: current dare and tallies, one-based winning option, progress, per-user fan scores, and the last 20 events. Ties (including no votes) select the lowest option number. By default a correct final prediction earns +1 per dare; an adopted house rule replaces that hook retroactively; overrules recalculate that score without double-crediting.

The run deadline starts after voting ends. `VOTE_SECONDS`, `SECONDS_PER_KILL`, and `MIN_DARE_SECONDS` accept integers 1–600 and default to 30, 30, and 90. The approve path clamps the running duration between the configured minimum and 600 seconds; the model cannot set timings. Restarting, including `tsx watch` reloads, replays history and restores timers. Expired dare and rule proposals are discarded; expired votes lock immediately; expired dares resolve immediately. A target reached before shutdown still resolves successfully after restart. Late commands never extend a deadline. Progress comes from the optional Watcher or the streamer's manual `!kill`.

Live and ordinary mock modes default to `.data/ledger.jsonl`; `LEDGER_PATH` can select another file. The judge demo always uses `.data/demo.jsonl`. Run only one process per Ledger file. To reset a demo, stop it and move that file aside as a backup before restarting. The writer does not silently discard corrupt or partial records; an incomplete final line needs repair before restart. Bot messages are best-effort and are not replayed as a delivery queue.

## Setup

1. Install Node.js 22 or newer, then run `npm install`.
2. Register an application at [the Twitch developer console](https://dev.twitch.tv/console). Use a **Confidential** client, the **Chat Bot** category, and this exact OAuth redirect URL: `http://localhost:3000/callback`. Generate a client secret.
3. Copy the example config:

   ```sh
   cp .env.example .env
   ```

   Fill in `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `BROADCASTER_LOGIN`, and `BOT_LOGIN`. Use account login names, without `@` or channel URLs. Keep the default redirect URI and `PORT=3000`. Use a separate Twitch account for the bot: Twitch does not show the Chat Bot badge for the broadcaster's own account, and the router ignores the bot's own messages.
4. Authorize the broadcaster:

   ```sh
   npm run auth -- broadcaster
   ```

   Open the printed URL in a browser signed into **the broadcaster's account** and approve `channel:bot`. The helper checks the account against `.env` before saving tokens, then exits.
5. Authorize the bot:

   ```sh
   npm run auth -- bot
   ```

   Use a separate browser profile/private window signed into **the bot's account**. Approve `user:read:chat user:write:chat user:bot`. Run the two auth commands sequentially; both use localhost port 3000.
6. Start the bot:

   ```sh
   npm run dev
   ```

   Wait for `Subscribed to channel.chat.message.` and `EventSub connected.`. Type `!ping` in the broadcaster's Twitch chat using an account other than the bot. It replies `pong`. `!race` replies `Race Control is online.` Unknown commands are ignored. Commands are exact and case-sensitive, with surrounding whitespace ignored; option-word votes are case-insensitive.

`npm start` runs once without watching files; both start scripts use `tsx`, so install development dependencies too. Press Ctrl+C to stop. `PORT` is used by the OAuth helper and, in mock mode, the local chat endpoint; the overlay is served in both modes. If changing the port, update both the redirect URI in `.env` and the Twitch app registration.

## Authentication and transport

- `.env` and `.data/` are gitignored. Never commit or share them. User access/refresh tokens and the app access token are stored in `.data/tokens.json`, replaced atomically with owner-only file permissions on POSIX systems. Run one bot process per token store, and stop it before reauthorizing.
- Startup validates account identities, client ID, and scopes, then obtains an app token using client credentials. Validation repeats hourly. Expired user tokens refresh automatically; rotated refresh tokens are saved. HTTP 401 triggers one renewal/retry. App tokens are replaced with a new grant because they have no refresh token. Failed hourly validation stops the bot; reauthorize revoked grants and restart.
- Chat subscriptions use the **bot's user token over EventSub WebSocket**. Outgoing chat uses the **app token** and the bot's sender ID, with broadcaster `channel:bot` permission. No moderator status is needed for this setup.
- A server-directed reconnect keeps the old socket open until the replacement welcomes it; subscriptions transfer automatically. Network loss or a keepalive timeout reconnects with exponential backoff (1–30 seconds) and resubscribes. Twitch does not replay events lost during an outage. Revocation is logged and stops the bot.
- Replies are queued in order, at most 20 HTTP send attempts per rolling 30 seconds and at least one second apart. Failed attempts and 401 retries count. This limit is per process; avoid other software sending as the same bot account. HTTP errors are reported without raw credential-bearing responses; HTTP 200 responses with `is_sent=false` log the drop reason. Failed/held messages are not automatically resent.
- App-token messages are explicitly restricted to the source channel in Shared Chat. The Chat Bot badge and the “Chat Bots” section of Users in Chat have different requirements: WebSocket readers do not qualify for that section, even when app-token sends qualify for the badge.

## Checks

```sh
npm run typecheck
npm test
```

Tests use `node:test`, mocked fetch/WebSockets, temporary token files, and controlled clocks. They do not contact Twitch, spawn Codex/Swift, require OBS, or require `.env`. OBS protocol tests use a mock WebSocket server bound to `127.0.0.1` on an OS-assigned port; the HUD route test also uses port 0. Rule tests inject the runner and use the real VM with synthetic contexts. Coverage includes config, commands and permissions, Ledger replay and persistence, fan scoring and overrules, dare deadlines and restart recovery, mock HTTP input, crowd simulation, OAuth callbacks, token rotation, HTTP requests, rate limiting, and EventSub lifecycle handling.

Real Twitch credentials are required to verify browser consent and callback delivery, both grants, live token refresh, EventSub chat delivery, actual chat replies and badge display, and Twitch-driven reconnects/revocations. A quick live check is to send `!ping`, `!race`, and an unknown command from a viewer account, confirm exactly two replies, then send `!ping` from the bot account and confirm no reply.

## Official references

- [Example chatbot](https://dev.twitch.tv/docs/chat/chatbot-guide/)
- [Sending and receiving messages](https://dev.twitch.tv/docs/chat/send-receive-messages/)
- [WebSocket lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)
- [OAuth flows](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Send Chat Message API](https://dev.twitch.tv/docs/api/reference/#send-chat-message)
- [Token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/) and [refresh](https://dev.twitch.tv/docs/authentication/refresh-tokens/)
- [Chat limits and badge requirements](https://dev.twitch.tv/docs/chat/)

## How Codex was used

Codex plays two roles: it built Race Control, and it runs inside it as three of the agents.

### 1. Codex built the app

All the code was written in one Codex CLI thread (`gpt-6-astra`), session `01a1731b-46b4-7161-97bd-ea0f9269fbcb`, from Oct 25 to Oct 27, one task per turn:

| Task | Effort | Commit |
| --- | --- | --- |
| Twitch chatbot skeleton, EventSub, Helix chat | high | `f42fd05` |
| Ledger, dare loop, mock mode, crowd simulator | medium | `f42fd05` |
| OBS overlay (live dare, predictions, agent feed) | medium | `d0b6818` |
| AI Game Master, streamer approval, easier voting | medium | `7f550af` |
| Rules Compiler and Auditor | high | `70c37d7` |
| Watcher (OBS frames + macOS Vision OCR) | medium | `507950c` |
| HUD-safe overlay layout and README | medium | `9999caa` |

Each task was a written brief covering scope, interfaces, safety rules, tests and the gates `npm run typecheck` and `npm test`. Codex wrote the code and the tests and ran the gates itself: about 2,100 lines of source and 1,900 lines of tests (90 tests). Standing repo rules told it to follow the official Twitch docs, never print secrets, test every non-trivial function, and never commit.

A human reviewed every diff and re-ran the gates before committing, with Claude Code as the reviewer. Live tests on Twitch and OBS found four problems, each fixed with a test that failed first:
- Generated rule code could reach the host's `Function` through the scoring context's prototype. The context now has a null prototype.
- The rule prompt let models put prose inside `code`. The prompt now defines every field, and a real compile then matched 2,304/2,304 cases.
- Vision's accurate mode drops a lone `0` on the HUD. The OCR helper now falls back to the fast mode.
- Local routes returned 404 when a URL had a query string, which OBS Browser Sources can add.

### 2. Codex runs inside the product

Three agents call `codex exec` at runtime. They pass the arguments as an array (no shell) and run with `--ignore-user-config --ephemeral -s read-only --skip-git-repo-check --output-schema …`. Each run has a timeout, its temporary output is deleted afterwards, and its JSON is validated strictly.

| Agent | Model | What Codex does |
| --- | --- | --- |
| Game Master | `gpt-6-luna`, low effort | Writes a dare (title, options, kill target, stakes) in about 6 s. The prompt holds only trusted context, never chat text. If the call fails, the dare falls back to a sample. The streamer approves or rerolls it. |
| Rules Compiler | `gpt-6-luna`, low effort | Turns the streamer's plain-English rule (e.g. "wrong calls lose a point") into a scoring function body plus worked examples. |
| Auditor | `gpt-6-sol`, low effort | Writes its own implementation of the same rule without seeing the compiler's. The two must agree on every past prediction in the Ledger and on 2,304 synthetic cases before the streamer can `!adopt` the rule. |

For example, for "underdogs score double", the two models wrote differently shaped code that agreed on all 2,304 cases. That agreement is what the overlay shows as "Audit passed 2304/2304".
