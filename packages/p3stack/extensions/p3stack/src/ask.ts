import { Type } from "typebox";
import type { Context, Pi } from "./mode.ts";

const OTHER = "Other (type an answer)";
const text = (body: string) => ({ content: [{ type: "text", text: body }], details: {} });

export function registerAsk(pi: Pi) {
  pi.registerTool({
    name: "ask_user", label: "Ask the human",
    description: "Ask the human a product or preference question that no experiment can settle, with choices or free text. Without an interactive UI, apply the default you state and say so.",
    promptSnippet: "ask_user asks the human only for product or preference calls. Otherwise decide and report.",
    exposure: "model-only",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 12, description: "Choices. Omit for a free-text answer." })),
      allowOther: Type.Optional(Type.Boolean({ description: "Also offer a free-text answer beside the options." })),
      default: Type.Optional(Type.String({ maxLength: 500, description: "What you will do if nobody answers." })),
    }, { additionalProperties: false }),
    async execute(_call: string, args: { question: string; options?: string[]; allowOther?: boolean; default?: string }, signal: AbortSignal | undefined, _update: unknown, ctx: Context) {
      signal?.throwIfAborted();
      const fallback = args.default?.trim()
        ? `Apply your default (${args.default}) and say so in your reply.`
        : "Do not treat silence as approval. Take the option that changes least, or stop and say what is needed.";
      if (!ctx.hasUI) return text(`No one can be asked because this session has no interactive UI. ${fallback}`);
      const dismissed = `The human dismissed the question. ${fallback}`;
      if (args.options) {
        const options = args.allowOther && !args.options.includes(OTHER) ? [...args.options, OTHER] : args.options;
        const choice = await ctx.ui.select(args.question, options, { signal });
        signal?.throwIfAborted();
        if (choice === undefined) return text(dismissed);
        if (!args.allowOther || choice !== OTHER) return text(`The human chose: ${choice}`);
      }
      const answer = await ctx.ui.input(args.question, undefined, { signal });
      signal?.throwIfAborted();
      return text(answer?.trim() ? `The human answered: ${answer}` : dismissed);
    },
  });
}
