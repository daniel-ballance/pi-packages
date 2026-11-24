import type { ReportInbox, Update } from "./report-inbox.js";

export type ReadArgs = { id: string; page: string };
export const reportPage = (id: string, cursor: number, offset = 0): ReadArgs => ({ id, page: `${cursor}:${offset}` });
export const REPORT_KINDS: ReadonlySet<string> = new Set(["assistant", "message", "error", "extension_error", "input_requested", "aborted", "completed", "failure", "human_intervention"]);

export function updateWindow(candidates: Update[]) {
  const updates: Update[] = [];
  let size = 0;
  for (const update of candidates) {
    if (size + update.text.length > 24000 && updates.length) break;
    updates.push(update); size += update.text.length;
  }
  return updates;
}

type Read = ReturnType<ReportInbox["read"]>;
// A compact one-line reply has no line-budget overhead. Leave room for the acknowledgement timestamp.
const fitsRead = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 29_800;

export function fitUpdateRead(data: Read, from: number) {
  if (fitsRead(data)) return data;
  const omittedReports = data.updates.filter(u => REPORT_KINDS.has(u.kind)).map(u => ({
    cursor: u.cursor, kind: u.kind, fullLength: u.fullLength ?? u.text.length, readFull: reportPage(data.id, u.cursor),
  }));
  const page = { ...data, truncated: true, updates: [] as Read["updates"], omittedReports, nextCursor: from, hasMore: true };
  // Keep supervision even when the task, dialog contents or other metadata alone overflow.
  if (!fitsRead(page)) {
    if (page.assignment) page.assignment = { ...page.assignment, task: page.assignment.task?.slice(0, 256) };
    delete page.coordination;
    if (!fitsRead(page)) page.uiRequests = page.uiRequests.map(({id, method, title, readFull}) => ({id, method, title: title?.slice(0, 256), readFull}));
    if (!fitsRead(page)) {
      page.error = page.error?.slice(0, 2000);
      if (page.hold) page.hold = { ...page.hold, detail: page.hold.detail?.slice(0, 2000) };
    }
  }
  for (const update of data.updates) {
    const ref = omittedReports[0]?.cursor === update.cursor ? omittedReports.shift() : undefined;
    page.updates.push(update);
    if (!fitsRead(page)) {
      page.updates.pop();
      if (ref) { omittedReports.unshift(ref); break; }
      // A single oversized non-report echo must not strand the following report.
      if (page.updates.length) break;
      page.updates.push({ ...update, text: update.text.slice(0, 256), truncated: true, fullLength: update.fullLength ?? update.text.length });
    }
    page.nextCursor = update.cursor;
  }
  page.hasMore = page.updates.length < data.updates.length;
  return page;
}
