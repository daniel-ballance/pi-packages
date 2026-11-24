"""Structural smoke check, not a browser test of refund arithmetic."""
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class Prototype(HTMLParser):
    def __init__(self):
        super().__init__()
        self.external = self.control = False
        self.scripts = []
        self.handlers = []
        self.fieldsets = []
        self.content = []
        self.section = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.section = tag
        if tag == "script" and "src" in attrs:
            self.external = True
        if tag == "link" and "stylesheet" in attrs.get("rel", "").lower().split():
            self.external = True
        if tag == "fieldset":
            self.fieldsets.append("disabled" in attrs)
        control = tag in {"button", "input", "select", "summary"} or (tag == "a" and "href" in attrs) or attrs.get("role") == "button"
        if control and not any(self.fieldsets) and "disabled" not in attrs and attrs.get("aria-disabled") != "true":
            self.control = True
            self.handlers.extend(v for k, v in attrs.items() if k.startswith("on") and v)
        if tag == "script" and attrs.get("type", "").lower() not in ("", "text/javascript", "application/javascript", "module"):
            self.section = None

    def handle_endtag(self, tag):
        if tag == "fieldset" and self.fieldsets:
            self.fieldsets.pop()
        self.section = None

    def handle_data(self, data):
        if self.section == "style" and re.search(r"@import\b", data, re.I):
            self.external = True
        if self.section == "script" and re.search(r"""\b(?:import\s*\(?\s*|from\s*)['"]""", data):
            self.external = True
        if self.section == "script":
            self.scripts.append(data)
        self.content.append(data)


doc = Prototype()
doc.feed(Path(sys.argv[1]).read_text(encoding="utf-8"))
doc.close()
states = {"requested", "approved", "rejected", "refunded"}
words = set(re.findall(r"\w+", " ".join(doc.content).lower()))
script = "\n".join(doc.scripts)
# Look for assignments of result states (including conditional expressions),
# not labels, comments, a list of states, or a handler attribute alone.
def body(source):
    source = source.lstrip()
    if not source.startswith("{"):
        return re.split(r"[;\n]", source, maxsplit=1)[0]
    depth = 0
    for i, char in enumerate(source):
        depth += (char == "{") - (char == "}")
        if depth == 0:
            return source[1:i]
    return ""


callback = r"(?:function\s*\w*\s*\([^)]*\)|(?:\([^)]*\)|\w+)\s*=>)\s*"
functions = {m[1]: body(script[m.end():]) for m in re.finditer(r"function\s+(\w+)\s*\([^)]*\)\s*", script)}
functions.update({m[1]: body(script[m.end():]) for m in re.finditer(r"(\w+)\s*=\s*" + callback, script)})
handlers = list(doc.handlers)
for hook in re.finditer(r"""\.on(?:click|change|submit|input)\s*=\s*|\.addEventListener\s*\(\s*['"]\w+['"]\s*,\s*""", script):
    target = script[hook.end():]
    inline = re.match(callback, target)
    name = re.match(r"(\w+)", target)
    if inline:
        handlers.append(body(target[inline.end():]))
    elif name and name[1] in functions:
        handlers.append(functions[name[1]])
# Include named helpers called from the handlers. Ignore unreferenced sample code.
for handler in handlers:
    for name in re.findall(r"\b(\w+)\s*\(", handler):
        if name in functions:
            handlers.append(functions.pop(name))
active = "\n".join(handlers)
assignment = re.compile(r"\b[\w.]+\s*=(?![=>])\s*([^;{}\n]+)")
assignments = assignment.findall(active)
# A handler may pass its new state to a setter instead of assigning it directly.
for setter in re.finditer(r"function\s+(\w+)\s*\(\s*(\w+)\s*\)", script):
    if setter[2] in (expr.strip() for expr in assignment.findall(body(script[setter.end():]))):
        assignments.extend(re.findall(r"\b" + setter[1] + r"\s*\(([^;{}\n]+)", active))
destinations = {s.lower() for expr in assignments if not expr.lstrip().startswith("[")
                for s in re.findall(r"""['"\x60](approved|rejected|refunded)['"\x60]""", expr, re.I)}
passed = not doc.external and doc.control and script and states <= words and states - {"requested"} <= destinations
print("Structural refund prototype check: " + ("pass" if passed else "fail") + " (not a browser interaction test)")
sys.exit(0 if passed else 1)
