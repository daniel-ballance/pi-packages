// A helper extension for the live suite: writes every raw Agent SDK message the provider
// streams to the JSONL file named by CS_LIVE_SDK_LOG, one object per line. The suite reads
// it back to see what Claude Code did (how many processes served a run, what limits it
// reported) where Pi's own events cannot say.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function recordSdkMessages(pi: ExtensionAPI) {
  const file = process.env.CS_LIVE_SDK_LOG;
  if (!file) return;
  pi.on("provider_stream_event", event => {
    appendFileSync(file, `${JSON.stringify(event.data)}\n`);
  });
}
