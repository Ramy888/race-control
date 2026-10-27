import { BrowserSession } from './session.js';
const session = new BrowserSession();
Object.assign(globalThis, { raceDemo: session });
setInterval(session.tick, 1000);
