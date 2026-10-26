import 'dotenv/config';
import { loadConfig } from './config.js';
import { simulateCrowd } from './simulator.js';

try {
  const config = loadConfig({ ...process.env, MOCK: '1' });
  await simulateCrowd(Number(process.argv[2]), config.port);
  console.log('Demo crowd finished. Votes count only while a dare is open.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Crowd simulator failed. Start npm run mock first.');
  process.exitCode = 1;
}
