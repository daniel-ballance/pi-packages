import { displayText } from './diagnostics.js';
import type { ObjectValue } from './headers.js';

/** Per-call updates; no footer ownership, background polling, or execution replay. */
export async function withProgress<T>(
  source: string,
  update: ((text: string) => void) | undefined,
  work: (progress: (value: ObjectValue) => void) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let reported: string | undefined;
  const emit = () =>
    update?.(
      `${displayText(source, 120)} · ${reported ?? 'awaiting result'} · ${Math.floor((Date.now() - started) / 1000)}s`,
    );
  const timer = update ? setInterval(emit, 2000) : undefined;
  timer?.unref();
  try {
    return await work((value) => {
      reported = `server progress: ${displayText(String(value.progress), 40)}${value.total === undefined ? '' : ` / ${displayText(String(value.total), 40)}`}${typeof value.message === 'string' ? ` — ${displayText(value.message)}` : ''}`;
      emit();
    });
  } finally {
    clearInterval(timer);
  }
}
