import 'dotenv/config';
import { loadWatcherConfig } from './config.js';
import { prepareOcr } from './ocr.js';
import { ObsClient } from './obs.js';
import { calibrate } from './calibrate.js';

let obs: ObsClient | undefined;
try {
  const config = loadWatcherConfig(process.env);
  if (!config.source) throw new Error('Set WATCHER_SOURCE before calibrating.');
  const ocr = await prepareOcr();
  if (!ocr) process.exitCode = 1;
  else {
    obs = new ObsClient(config.obsUrl, config.obsPassword);
    const result = await calibrate(config, source => obs!.screenshot(source), ocr);
    console.log(`Saved .data/hud.png\nFull frame OCR:\n${result.full}\nHUD_REGION OCR:\n${result.region}`);
  }
} catch { console.error('HUD calibration failed. Check WATCHER_SOURCE, OBS connection, and HUD_REGION.'); process.exitCode = 1; }
finally { obs?.stop(); }
