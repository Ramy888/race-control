import 'dotenv/config';
import { freshDemo } from './demo.js';

Object.assign(process.env, await freshDemo(process.env));
await import('./main.js');
