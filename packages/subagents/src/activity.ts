import type { Packet } from "./rpc.js";

export interface ToolActivity { id: string; time: string; name: string; args: string; output?: string; status: "running" | "completed" | "error" }
export interface LiveActivity { tools: readonly ToolActivity[]; text: string; phase?: string }
const tail = (text: string) => text.length > 12000 ? "[Earlier text omitted]\n" + text.slice(-12000) : text;
const resultText = (result: Packet | undefined): string => (Array.isArray(result?.content) ? result.content : [])
  .filter((part: Packet) => part?.type === "text" && typeof part.text === "string").map((part: Packet) => part.text).join("\n");

/** Ephemeral, bounded presentation data. Never persisted or used for report receipts. */
export class ActivityFeed {
  private tools: ToolActivity[] = [];
  private text = "";
  private phase?: string;
  accept(packet: Packet, time = new Date().toISOString()) {
    switch (packet.type) {
      case "agent_start": case "message_start":
        this.text = ""; this.phase = undefined; break;
      case "message_update": {
        const event = packet.assistantMessageEvent;
        if (event?.type === "text_delta" && typeof event.delta === "string") { this.text = tail(this.text + event.delta); this.phase = "Writing"; }
        else if (event?.type === "thinking_delta") this.phase = "Thinking";
        break;
      }
      case "tool_execution_start":
        this.tools.push({ id: packet.toolCallId, time, name: packet.toolName,
          args: tail(JSON.stringify(packet.args ?? {})), status: "running" });
        this.tools = this.tools.slice(-40);
        this.phase = `Tool: ${packet.toolName}`;
        break;
      case "tool_execution_end": {
        const tool = this.tools.find(t => t.id === packet.toolCallId);
        if (tool) { tool.status = packet.isError ? "error" : "completed"; tool.output = tail(resultText(packet.result)); }
        this.phase = undefined;
        break;
      }
      case "message_end":
        if (packet.message?.role === "assistant") { this.text = ""; this.phase = undefined; }
        break;
      case "agent_settled":
        this.text = ""; this.phase = undefined; break;
    }
  }
  snapshot(): LiveActivity { return { tools: this.tools, text: this.text, phase: this.phase }; }
}
