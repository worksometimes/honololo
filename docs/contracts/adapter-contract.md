# Target adapter contract

The core harness is target-agnostic. A target pack may provide facts and optional channel adapters,
but it must not modify the universal graph or result semantics.

## Required target metadata

```yaml
key: example.com
url: https://example.com
allowed_domains: [example.com]
session: venti-example-com
environment: public-demo
```

## Optional adapter capabilities

An adapter can expose:

- a browser entry URL and safe discovery hints;
- an approved API base and named, redacted request templates;
- data setup/reset commands with idempotency guarantees;
- response redaction rules;
- known completion signals and environment checks.

An adapter cannot:

- inject hidden assertions into a plan;
- bypass an approval gate;
- widen `allowed_domains` at runtime;
- store credentials or raw authorization headers;
- convert a browser failure into an API pass;
- change the global status policy.

## API adapter output

API calls return a redacted record with status, elapsed time, selected safe headers, and a body
projection. The full response is not persisted by default.

```json
{
  "channel": "api",
  "method": "GET",
  "url": "https://example.com/health",
  "status": 200,
  "elapsed_ms": 42,
  "body_projection": {"status": "ok"},
  "redactions": ["authorization", "set-cookie"]
}
```
