"""Structural smoke check, not a browser test of refund arithmetic."""
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class Prototype(HTMLParser):
    def __init__(self):
        super().__init__()
        self.external = self.control = self.handler = False
        self.content = []
        self.section = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.section = tag
        if tag == "script" and "src" in attrs:
            self.external = True
        if tag == "link" and "stylesheet" in attrs.get("rel", "").lower().split():
            self.external = True
        self.control |= tag in {"button", "input", "select", "a", "summary"} or attrs.get("role") == "button"
        handlers = [v for k, v in attrs.items() if k.startswith("on") and v]
        self.handler |= bool(handlers) or tag == "summary" or (tag == "a" and attrs.get("href", "").startswith("#"))
        self.content.extend(handlers)

    def handle_endtag(self, tag):
        self.section = None

    def handle_data(self, data):
        if self.section == "style" and re.search(r"@import\b", data, re.I):
            self.external = True
        if self.section == "script" and re.search(r"addEventListener\s*\(|\.on(?:click|change|submit|input)\s*=", data, re.I):
            self.handler = True
        self.content.append(data)


doc = Prototype()
doc.feed(Path(sys.argv[1]).read_text(encoding="utf-8"))
doc.close()
states = {"requested", "approved", "rejected", "refunded"}
words = set(re.findall(r"\w+", " ".join(doc.content).lower()))
sys.exit(0 if not doc.external and doc.control and doc.handler and states <= words else 1)
