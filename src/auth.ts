import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { authorizationUrl, callbackHandler } from './oauth.js';
import { TokenManager } from './tokens.js';

try {
  const role = process.argv[2];
  if (role !== 'broadcaster' && role !== 'bot') throw new Error('Usage: npm run auth -- broadcaster|bot');
  const config = loadConfig(process.env);
  const tokens = new TokenManager(config);
  const state = randomBytes(32).toString('hex');
  const server = createServer();
  const finish = (error?: Error) => {
    clearTimeout(timeout);
    server.close();
    if (error) { console.error(error.message); process.exitCode = 1; }
    else console.log(`${role} authorization saved to .data/tokens.json.`);
  };
  server.on('request', callbackHandler(state, code => tokens.authorize(role, code), finish));
  server.on('error', () => finish(new Error(`Cannot listen on localhost:${config.port}. Stop other auth helpers or services using that port.`)));
  const timeout = setTimeout(() => finish(new Error('Authorization timed out. Run the auth command again.')), 5 * 60_000);
  // Bind only to loopback; the redirect hostname is also localhost.
  server.listen(config.port, 'localhost', () => {
    console.log(`Sign in as ${role === 'bot' ? config.botLogin : config.broadcasterLogin}, then open:\n${authorizationUrl(config, role, state)}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Authorization failed.');
  process.exitCode = 1;
}
