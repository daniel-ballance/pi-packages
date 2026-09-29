import type { SubagentManager } from "./manager.js";

/** Peek at bounded report pages. The caller acknowledges only after successful formatting. */
export function collectReports(manager: SubagentManager, ids: string[], maxBytes = 24000, maxLines = 750) {
  const reports: ReturnType<SubagentManager["read"]>[] = [];
  const deferred: string[] = [];
  const fits = (page: ReturnType<SubagentManager["read"]>) => {
    const text = JSON.stringify([...reports, page], null, 2);
    return Buffer.byteLength(text) <= maxBytes && text.split("\n").length <= maxLines;
  };
  for (const id of ids) {
    const record = manager.get(id);
    const page = manager.read(id, undefined, false);
    if (!page.updates.length && !page.uiRequests.length) continue;
    // Preserve a contiguous prefix; never acknowledge skipped output.
    page.updates = [...page.updates];
    while (!fits(page) && page.updates.length) {
      page.updates.pop();
      page.nextCursor = page.updates.at(-1)?.cursor ?? record.readCursor;
      page.hasMore = record.cursor > page.nextCursor;
    }
    if (!fits(page) || (!page.updates.length && !page.uiRequests.length)) deferred.push(id);
    else {
      reports.push(page);
      if (page.hasMore) deferred.push(id);
    }
  }
  return { reports, deferred, hasMoreReports: deferred.length > 0 };
}
