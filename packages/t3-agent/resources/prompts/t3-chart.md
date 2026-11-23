---
description: Answer with a chart rendered inline in this T3 thread
argument-hint: "<question or data>"
---
Answer with a chart shown inline in this thread: $@

1. Gather the data and note where each number came from.
2. Write one self-contained HTML file in a temporary directory: inline style and script, no network requests, T3's theme variables (`--chart-1` to `--chart-6`, `--foreground`, `--muted`, `--border`) instead of fixed colors, no page background, and a fixed pixel height for each chart.
3. Call `html_preview` on it and fix whatever the screenshot or console output shows wrong. Then call `html_render`.
4. Reply with only what the chart does not already say, such as sources and caveats.
