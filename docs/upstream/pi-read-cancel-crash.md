# Draft issue for Pi: a cancelled `read` can end the process

Not filed. Found on 2026-11-24 while isolating why a rejected `Promise.all` in a codemode script ended Pi sessions. Until Pi fixes it, scripts that batch tool calls use `Promise.allSettled`. The first reproduction below needs a driver that is not in this repository; the second is self-contained.

**Title:** Pi 1.5.2: cancelling a built-in text `read` during setup emits an unhandled ReadStream `'error'` and exits Pi

**Measured — environment and impact:** Linux x64. Standalone Pi 1.5.2 (Bun 1.4.4) and `@earendil-works/pi-coding-agent` / `@earendil-works/pi-codemode` 1.5.2 on Node 26.13.1. In a real RPC session with a deterministic in-memory provider and no extra extensions, one script doing `await Promise.all([tools.read({path: existing}), tools.read({path: absent})])` reports ENOENT, cancels its sibling and can terminate the entire RPC process, code 1 / no signal. Stdin is still open. **Expected:** the tool fails; the process can answer the next prompt.

**Measured — reproduce the full RPC case:** With Pi 1.5.2 and Node on PATH, extract the attached `pi-read-repro.tar.gz` in a scratch directory and run `node probe.mjs --style plain --n 1 --bytes 1`. No credentials or server required. This exact small shape failed in five consecutive trials here; it is a race. `--n 12 --bytes 524288` also exercises pending reads. `--join allSettled` is a survival control.

**Measured — deterministic reduced repro, independent of the RPC attachment:** From any project with `@earendil-works/pi-coding-agent@1.5.2` installed, run the following in a shell. The model getter is only a test scheduling seam: it queues cancellation when the real tool has finished checking access and is taking the local text path. All filesystem operations below are Pi's defaults.

```sh
index="$PWD/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
root=${TMPDIR:-/tmp}/pi-read-crash; mkdir -p "$root"; d=$(mktemp -d "$root/read-test.XXXXXX")
mkdir "$d/cwd" "$d/home" "$d/agent" "$d/tmp"
cat >"$d/read-test.mjs" <<'JS'
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const { createReadToolDefinition } = await import(process.argv[2]);
const ac = new AbortController();
const ctx = { cwd: process.cwd(), get model() {
  queueMicrotask(() => ac.abort()); return undefined;
} };
try {
  await createReadToolDefinition(ctx.cwd).execute('r', { path: fileURLToPath(import.meta.url) }, ac.signal, undefined, ctx);
  throw Error('expected cancellation');
} catch (e) {
  if (e.message !== 'Operation aborted') throw e;
  console.log('caught read rejection:', e.message);
}
await delay(200);
console.log('still alive');
JS
(cd "$d/cwd" && env -i PATH="$PATH" HOME="$d/home" TMPDIR="$d/tmp" \
  PI_CODING_AGENT_DIR="$d/agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
  node --trace-uncaught --unhandled-rejections=warn "$d/read-test.mjs" "$index")
```

**Measured — actual:** the read rejection is caught; a separate event still kills the process before `still alive`. Same result with `--unhandled-rejections=strict`. Excerpt from the **full RPC** stack (package paths shortened):

```text
node:events:505
    throw er; // Unhandled 'error' event
AbortError: The operation was aborted
    at stream.<computed>.AbortError.cause (node:internal/streams/add-abort-signal:47:22)
    at module.exports.addAbortSignalNoValidate (node:internal/streams/add-abort-signal:53:5)
    at addAbortSignal (node:internal/streams/add-abort-signal:38:25)
    at ReadStream.Readable (node:internal/streams/readable:376:7)
    at new ReadStream (node:internal/fs/streams:257:3)
    at FileHandle.createReadStream (node:internal/fs/promises:414:12)
    at Object.readLocalFileChunks [as createReadStream] (.../pi-coding-agent/dist/core/tools/read.js:46:23)
    at async selectLinesFromStream (.../pi-coding-agent/dist/core/tools/read.js:156:22)
    at async .../pi-coding-agent/dist/core/tools/read.js:241:35
Emitted 'error' event on ReadStream instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
    at emitErrorCloseNT (node:internal/streams/destroy:129:3)
...
  code: 'ABORT_ERR',
  [cause]: DOMException [AbortError]: This operation was aborted
      ...
      at AbortController.abort (node:internal/abort_controller:581:18)
      at Execution.finish (.../pi-codemode/dist/runtime/execution.js:347:32)
      at Execution.handleDone (.../pi-codemode/dist/runtime/execution.js:288:18)
```

**Measured — responsible line:** The 1.5.2 source map locates `read.js:46:23` at **`packages/coding-agent/src/core/tools/read.ts:80`** in `readLocalFileChunks`: `yield* handle.createReadStream({ end, signal, autoClose: false });`. It follows two awaits, `fsOpen` and `handle.stat()`.

**Inferred — suggested fix and regression test:** Inside the existing `try/finally`, check `signal?.throwIfAborted()` **after the last await and immediately before stream construction**. Keep passing the signal to a live stream for subsequent cancellation; keep the `finally` that closes the handle. Don't mask `'error'` events or disable codemode's pending-call cancellation. Put the deterministic `read` repro in a subprocess test: require the normal cancellation rejection, `still alive`, and exit 0; in the RPC case require ENOENT **and** a subsequent successful prompt. A check only at the start of `execute()` is already present and is too early.
