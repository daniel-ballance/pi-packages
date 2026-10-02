import { createRequire } from 'node:module';
import { getAgentDir, VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const loadNative = createRequire(import.meta.url)('./native-loader.cjs') as () => Promise<typeof import('../../src/pi/extension.js')>;
export default async function durableSubagents(pi: ExtensionAPI) {
  if (!/^(0\.99\.2|1\.0\.\d+)$/.test(VERSION))
    throw new Error(`durable-subagents supports Pi 0.99.2 and 1.0.x; found ${VERSION}. Use a supported isolated Pi runtime; no global version switch is required.`);
  let native: Awaited<ReturnType<typeof loadNative>>;
  try { native = await loadNative(); }
  catch (error) {
    if (/Cannot find (?:module|package).*(@durable-subagents\/|@earendil-works\/(?:pi-durable|chord))/.test(String(error)))
      throw new Error('durable-subagents runtime dependencies are missing. In the pi-packages repository root run npm ci --ignore-scripts (or pnpm install --frozen-lockfile --ignore-scripts), then restart Pi. Git pull and Pi registration of a local directory do not install its npm dependencies.', { cause: error });
    throw error;
  }
  const { registerDurableSubagents } = native;
  registerDurableSubagents(pi, getAgentDir);
}
