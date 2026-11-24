import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import p3stack from "../extensions/p3stack/index.ts";

p3stack satisfies ExtensionFactory;

function commandBoundary(pi: Parameters<typeof p3stack>[0]) {
  pi.registerCommand("type-check", {
    description: "Type check only",
    handler: async (_args, ctx) => {
      // @ts-expect-error Pi gives executeTool only to tool handlers, not commands.
      await ctx.executeTool("p3stack_roles", {});
    },
  });
}
