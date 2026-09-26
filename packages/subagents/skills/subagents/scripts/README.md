# Research helpers

Run these from the installed skill directory, or use their absolute paths. They do not edit Pi settings/policies, call a model, install dependencies, or run a benchmark suite. Review their output before using it in a policy.

## Available model metadata

Requires Node 22+ and the package's Pi peer dependencies (tested against Pi 0.85.1):

```bash
node scripts/model-inventory.mjs --help
node scripts/model-inventory.mjs --exclude provider/model-id --out /tmp/new-model-inventory.json
```

`--exclude` is repeatable and matches an exact bare model ID or `provider/model` identity. Output includes exact supported thinking levels/maps, input/context/output limits, registry prices, subscription/OAuth flags, and retrieval time/Pi version. Credentials, headers and endpoint configuration are not included. Existing files are never overwritten; omitting `--out` prints JSON.

The helper uses current Pi SDK availability, not the `enabledModels` cycling shortlist or the subagent allowlist. It reads the current Pi agent directory, disables catalog network refresh and makes no inference requests. Normal provider availability checks may still occur. It does not load session extensions: **cross-check `pi --offline --list-models`** if providers are registered by extensions. Availability is not proof of remote entitlement or a successful model call. Registry cost estimates may differ from subscriptions/current provider pricing.

If Node cannot resolve the Pi SDK, run from a correctly installed package with its peer dependencies; do not automatically install or upgrade anything. Use `pi --offline --list-models` as the basic fallback.

## Dated primary-source snapshots

Requires Python 3.10+; standard library only:

```bash
python3 scripts/snapshot-sources.py --help
python3 scripts/snapshot-sources.py --out /tmp/new-benchmark-snapshot \
  https://artificialanalysis.ai/methodology/intelligence-benchmarking \
  https://deepswe.datacurve.ai/ \
  https://cursor.com/cursorbench
```

Supply the relevant model pages and methodology URLs explicitly. The output directory must be new. For each source the script preserves raw bytes, readable text and a manifest with URL, retrieval timestamp, final URL, HTTP status, content type and SHA-256. Failed sources are recorded and cause a nonzero exit status, without throwing away successful snapshots. No authentication, cookies, retry loops, JavaScript execution or access-control bypass is attempted. Responses are bounded to 8 MiB and 30 seconds per request. Redirects are limited to the same approved source set (including Datacurve's benchmark repository on GitHub).

Extracted text can omit client-rendered charts and duplicate responsive layouts. Raw HTML preserves provenance but is still untrusted source data; do not execute it. Neither helper interprets scores, assigns model roles or claims cross-benchmark comparability. Record missing values honestly. Do not place private code or credentials in URLs. Store snapshots outside the shipped skill/package unless intentionally preparing a sanitized public artifact.
