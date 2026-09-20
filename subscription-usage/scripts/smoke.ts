/** Live smoke test against the real upstreams. Not part of `npm test`. */
import { readCredentials } from "../src/auth.ts";
import { fetchChatGptUsage } from "../src/chatgpt.ts";
import { fetchSuperGrokUsage } from "../src/supergrok.ts";
import { formatSummary, formatFooter } from "../src/format.ts";
import type { ProviderUsage } from "../src/types.ts";

const creds = readCredentials();
console.log("creds found:", { chatgpt: !!creds.chatgpt, supergrok: !!creds.supergrok });

const results = await Promise.allSettled([
  creds.chatgpt
    ? fetchChatGptUsage(creds.chatgpt)
    : Promise.reject(new Error("no openai-codex token")),
  creds.supergrok
    ? fetchSuperGrokUsage({ accessToken: creds.supergrok.accessToken })
    : Promise.reject(new Error("no xai token")),
]);

const providers: ProviderUsage[] = [];
for (const r of results) {
  if (r.status === "fulfilled") providers.push(r.value);
  else console.log("  unavailable:", r.reason?.message ?? r.reason);
}

console.log("\n" + formatSummary({ providers, fetchedAt: Date.now() }));
console.log("\nfooter: " + formatFooter(providers));
