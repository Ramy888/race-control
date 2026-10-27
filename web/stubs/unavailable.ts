export function unavailable(): never { throw new Error('Not available in the browser demo'); }
export { unavailable as spawn, unavailable as mkdtemp, unavailable as readFile, unavailable as rm,
  unavailable as appendFile, unavailable as mkdir, unavailable as tmpdir, unavailable as join,
  unavailable as dirname, unavailable as fileURLToPath };
