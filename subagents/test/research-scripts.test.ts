import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = new URL("../skills/subagents/scripts/", import.meta.url);

test("inventory exposes allowlisted metadata rather than credential-bearing model objects", () => {
  const source = new URL("model-inventory.mjs", scripts).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { publicModel } from ${JSON.stringify(source)};
    const model = { provider: 'test', id: 'stub', api: 'test', input: ['text'], contextWindow: 100,
      maxTokens: 50, cost: {input: 1, output: 2}, headers: {Authorization: 'SECRET'}, apiKey: 'SECRET', baseUrl: 'PRIVATE' };
    console.log(JSON.stringify(publicModel(model, ['medium'], {oauth: true, subscription: true})));
  `], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!/SECRET|PRIVATE|apiKey|Authorization/.test(run.stdout));
  const value = JSON.parse(run.stdout);
  assert.equal(value.id, "test/stub");
  assert.deepEqual(value.thinkingLevels, ["medium"]);
  assert.equal(value.billing.subscription, true);
});

test("inventory help needs no model call or output file; invalid arguments fail safely", () => {
  const path = fileURLToPath(new URL("model-inventory.mjs", scripts));
  const help = spawnSync(process.execPath, [path, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--exclude/);
  const bad = spawnSync(process.execPath, [path, "--unknown"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Inventory failed/);
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;
test("snapshot helper validates redirects, preserves provenance and records blocked sources without network tests", { skip: !hasPython }, () => {
  const dir = mkdtempSync(join(tmpdir(), "research-snapshot-"));
  try {
    const run = spawnSync("python3", ["-c", `
import runpy,sys,io,hashlib
from pathlib import Path
from email.message import Message
from urllib.error import HTTPError
m=runpy.run_path(sys.argv[1]); validate=m['validate_url']
for url in ['http://cursor.com/', 'https://localhost/', 'https://cursor.com.evil.test/', 'https://user:password@cursor.com/', 'https://cursor.com:444/', 'https://github.com/unrelated/repo']:
    try: validate(url)
    except ValueError: pass
    else: raise AssertionError(url)
validate('https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json')
validate('https://raw.githubusercontent.com/datacurve-ai/deep-swe/main/README.md')
try: m['SafeRedirect']().redirect_request(None,None,302,'',{},'https://localhost/private')
except ValueError: pass
else: raise AssertionError('unsafe redirect')
raw=b'<h1>Score 42</h1><script>must_not_execute()</script><p>Version 1</p>'
class Response(io.BytesIO):
    url='https://cursor.com/cursorbench'
    status=200
    headers=Message()
Response.headers['Content-Type']='text/html; charset=utf-8'
class Opener:
    def open(self,*a,**kw): return Response(raw)
directory=Path(sys.argv[2]); row=m['snapshot']('https://cursor.com/cursorbench',directory,'ok',Opener())
assert row['sha256']==hashlib.sha256(raw).hexdigest()
assert row['status']==200 and row['retrievedAt']
assert (directory/row['rawFile']).read_bytes()==raw
text=(directory/row['textFile']).read_text()
assert 'Score 42' in text and 'must_not_execute' not in text
class Blocked:
    def open(self,*a,**kw): raise HTTPError('https://cursor.com/',403,'blocked',{},None)
row=m['snapshot']('https://cursor.com/',directory,'blocked',Blocked())
assert row['status']==403 and 'error' in row
try: m['main'](['--out',str(directory),'https://cursor.com/'])
except FileExistsError: pass
else: raise AssertionError('must not reuse an output directory')
`, fileURLToPath(new URL("snapshot-sources.py", scripts)), dir], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
