import { RequestError } from "@agentclientprotocol/sdk";

const SIGN_IN = "Sign in with Google by running `agy` or `agy acp --login`, then retry in Pi.";
const AUTH_REQUIRED = RequestError.authRequired().code;

export function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === AUTH_REQUIRED || /auth(?:entication)? required|not (?:signed|logged) in|login required/i.test(text) ? `${text}. ${SIGN_IN}` : text;
}

export function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
