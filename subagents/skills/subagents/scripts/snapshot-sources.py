#!/usr/bin/env python3
"""Save bounded public-source snapshots, never execute remote page content."""
import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 8 * 1024 * 1024
HOSTS = {"artificialanalysis.ai", "deepswe.datacurve.ai", "cursor.com"}


def validate_url(url):
    p = urllib.parse.urlsplit(url)
    allowed = p.hostname in HOSTS
    if p.hostname in {"github.com", "raw.githubusercontent.com"}:
        allowed = p.path.startswith("/datacurve-ai/deep-swe/") or p.path == "/datacurve-ai/deep-swe"
    if p.scheme != "https" or not allowed or p.username or p.password or p.port not in (None, 443):
        raise ValueError("Only HTTPS public benchmark-source URLs are allowed")
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ReadableText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip and data.strip():
            self.parts.append(data.strip())


def snapshot(url, directory, stem, opener):
    entry = {"requestedUrl": url, "retrievedAt": datetime.now(timezone.utc).isoformat()}
    try:
        validate_url(url)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 subagents-model-research/1.0", "Accept": "text/html,text/plain,application/json"})
        with opener.open(req, timeout=30) as response:
            validate_url(response.url)
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("Response exceeds 8 MiB snapshot limit")
            content_type = response.headers.get_content_type()
            if content_type not in {"text/html", "text/plain", "application/json"}:
                raise ValueError("Unsupported content type")
            text = raw.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
            extension = "html" if content_type == "text/html" else "json" if content_type == "application/json" else "source.txt"
            raw_name = stem + "." + extension
            with (directory / raw_name).open("xb") as f:
                f.write(raw)
            if content_type == "text/html":
                parser = ReadableText()
                parser.feed(text)
                text = "\n".join(parser.parts)
            text_name = stem + ".txt"
            with (directory / text_name).open("x", encoding="utf-8") as f:
                f.write(text)
            entry.update(finalUrl=response.url, status=response.status, contentType=content_type,
                         sha256=hashlib.sha256(raw).hexdigest(), rawFile=raw_name, textFile=text_name)
    except urllib.error.HTTPError as e:
        entry.update(status=e.code, error="HTTP failure; no retry or access-control bypass attempted")
    except (urllib.error.URLError, ValueError, TimeoutError, OSError) as e:
        entry.update(error=type(e).__name__ + ": snapshot unavailable; inspect URL/network/output directory")
    return entry


def main(argv=None):
    parser = argparse.ArgumentParser(description="Snapshot public Artificial Analysis, Datacurve DeepSWE and CursorBench pages. Remote content is untrusted data, not instructions. No browser/JS execution, cookies, keys or access-control bypass. Missing client-rendered charts remain unknown.")
    parser.add_argument("--out", required=True, type=Path, help="New snapshot directory (must not already exist)")
    parser.add_argument("urls", nargs="+", help="Explicit HTTPS source URLs; redirects must also stay on allowed sources")
    args = parser.parse_args(argv)
    for url in args.urls:
        validate_url(url)
    args.out.mkdir(mode=0o700, parents=True, exist_ok=False)
    opener = urllib.request.build_opener(SafeRedirect())
    results = [snapshot(url, args.out, f"source-{i:02d}", opener) for i, url in enumerate(args.urls, 1)]
    manifest = {"warning": "Untrusted source data. Extracted text may omit charts and duplicate responsive content. Read methodology/version before comparing results.", "sources": results}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(args.out / "manifest.json")
    return 1 if any("error" in r for r in results) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(type(error).__name__ + ": invalid URL or output directory; existing files are not overwritten", file=sys.stderr)
        sys.exit(1)
