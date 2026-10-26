# Race Control

A local Twitch chatbot and the starting point for an AI referee/game master for streams. The chatbot now includes an append-only Ledger, a manual dare loop, and a local mock audience. OBS, the overlay, AI Game Master, and Rules Compiler come later.

## Try it without Twitch

No Twitch registration, credentials, tokens, or Twitch CLI are needed. Install dependencies once with `npm install`, then:

```sh
npm run mock
```

The mock server binds **127.0.0.1 only**, using `PORT` (default `3000`) and `BROADCASTER_LOGIN` (default `streamer`). All other config is ignored. Replies appear in the terminal prefixed with `[chat]`. Mock logins are normalized to lowercase, with `userId = login`.

In another terminal, open a dare as the streamer, then invite the simulated crowd:

```sh
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!dare"}'
npm run crowd -- 20
```

`crowd` is a **simulator for demos without a live audience**. Each of 20 viewers sends a random `!pick N`, then `!yes` or `!no`, with small random delays. It can run before a dare, but those votes will be ignored; run it during the vote to see a tally. It uses `PORT` from `.env`. Repeating it reuses the same viewer identities, replacing their votes rather than adding extra voters.

The first dare has a **30-second vote**, then **90 seconds to get 3 kills**. Wait for “Vote locked” in the mock terminal, then run this command three times:

```sh
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!kill"}'
```

The third kill resolves the dare early. To demonstrate a failure, let the 90 seconds expire. Then flip the result and recalculate fan scores:

```sh
curl -s http://127.0.0.1:3000/mock/chat -H 'Content-Type: application/json' \
  -d '{"user":"streamer","text":"!overrule HUD reading was wrong"}'
```

If you configured a different broadcaster login or port, substitute it in the curl commands. Another `!dare` opens the next sample: a 60-second vote, then 10 minutes for 15 kills. Samples alternate, with the next sample index recovered from the Ledger.

| Command | Who | When |
| --- | --- | --- |
| `!ping`, `!race` | Anyone | Always |
| `!pick 1` through `!pick 3` | Anyone | Voting; one current vote per user |
| `!yes`, `!no` | Anyone | Voting or running; replaces that user's prediction |
| `!dare` | Broadcaster | No dare yet, or previous dare resolved |
| `!kill` | Broadcaster | Running; adds one kill |
| `!overrule <reason>` | Broadcaster | Resolved; flips the result |

Broadcaster permission compares the login case-insensitively in both modes. Mock mode deliberately trusts the submitted login so a demo can act as the streamer. HTTP 200 means input was accepted; commands without permission or in the wrong phase are silently ignored. Invalid users and text longer than 500 characters return HTTP 400.

## Ledger and restart behavior

`.data/ledger.jsonl` stores `{ seq, at, agent, type, data }` records. State is derived only by pure `replay`: current dare and tallies, one-based winning option, progress, per-user fan scores, and the last 20 events. Ties (including no votes) select the lowest option number. A correct final prediction earns +1 per dare; overrules recalculate that score without double-crediting.

The run deadline starts after voting ends. Restarting, including `tsx watch` reloads, replays history and restores timers. Expired votes lock immediately; expired dares resolve immediately. A target reached before shutdown still resolves successfully after restart. Late commands never extend a deadline. Progress comes only from the streamer's manual `!kill` for now.

Both modes share `.data/ledger.jsonl`. Run only one process at a time. To reset a demo, stop it and move that file aside as a backup before restarting. The writer does not silently discard corrupt or partial records; an incomplete final line needs repair before restart. Bot messages are best-effort and are not replayed as a delivery queue.

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

   Wait for `Subscribed to channel.chat.message.` and `EventSub connected.`. Type `!ping` in the broadcaster's Twitch chat using an account other than the bot. It replies `pong`. `!race` replies `Race Control is online.` Unknown commands are ignored. Commands are exact and case-sensitive, with surrounding whitespace ignored.

`npm start` runs once without watching files; both start scripts use `tsx`, so install development dependencies too. Press Ctrl+C to stop. `PORT` is used by the OAuth helper and, in mock mode, the local chat endpoint; no overlay or web UI is served yet. If changing the port, update both the redirect URI in `.env` and the Twitch app registration.

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

Tests use `node:test`, mocked fetch/WebSockets, temporary token files, and controlled clocks. They do not contact Twitch or require `.env`. Coverage includes config, commands and permissions, Ledger replay and persistence, fan scoring and overrules, dare deadlines and restart recovery, mock HTTP input, crowd simulation, OAuth callbacks, token rotation, HTTP requests, rate limiting, and EventSub lifecycle handling.

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

TODO
