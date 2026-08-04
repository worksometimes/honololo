# Venti browser bridge protocol

The core runner does not import every browser SDK. A provider implemented in Python, TypeScript,
Rust, a remote service, or an MCP server can speak this one-request/one-response JSONL protocol.

Start a long-lived process and send newline-delimited requests on stdin:

```json
{"id":"1","method":"open","params":{"url":"https://example.com"}}
{"id":"2","method":"observe","params":{}}
{"id":"3","method":"screenshot","params":{"path":"runs/.../screenshot.png"}}
```

Return exactly one response line for each request:

```json
{"id":"1","ok":true,"result":{}}
{"id":"2","ok":true,"result":{"provider":"my-browser","url":"https://example.com","title":"Example Domain","text":"...","snapshot":"...","metadata":{}}}
{"id":"3","ok":false,"error":{"code":"SCREENSHOT_FAILED","message":"...","retryable":false}}
```

## Methods

| Method | Params | Result |
|---|---|---|
| `open` | `{url}` | navigation acknowledgement |
| `reload` | — | acknowledgement |
| `observe` | — | URL, title, visible text, snapshot, optional metadata |
| `snapshot` | — | accessibility/state text |
| `click` | `{locator}` | acknowledgement |
| `fill` | `{locator,value}` | acknowledgement |
| `type` | `{locator,value}` | acknowledgement |
| `press` | `{key,locator?}` | acknowledgement |
| `select` | `{locator,value}` | acknowledgement |
| `upload` | `{locator,path}` | acknowledgement |
| `scroll` | `{direction,amount?}` | acknowledgement |
| `waitFor` | `{condition}` | acknowledgement |
| `screenshot` | `{path}` | `{path}` |
| `startTrace` | — | acknowledgement |
| `stopTrace` | `{path}` | `{path}` |
| `close` | — | acknowledgement then process exit |

## Adapter guidance

- Current Browser Use harness: use the built-in `browser-use` provider, which runs bounded helper
  operations over a configured CDP endpoint. A custom Browser Use Agent/SDK adapter can use this
  bridge when its session and event stream need to stay in a long-lived process.
- Legacy Browser Use CLI: map `open`, `state`, `click`, `type`, and `screenshot`; preserve the
  Browser Use session id across all requests. The compatibility profile is available as the
  built-in `browser-use-cli` provider.
- Browser Use Cloud: prefer a raw browser/CDP session and the built-in Playwright provider when
  deterministic UI assertions are required; use the agent SDK for autonomous exploration and
  return its final observation through this bridge.
- Stagehand: call `observe` to obtain a proposed action, then pass the approved action into `act`
  so repeatable runs do not re-infer an action unnecessarily. Map `extract` output into
  `observation.metadata` when the plan declares a structured expectation.
- Playwright MCP: expose the MCP tool calls through a tiny JSONL sidecar. Keep the MCP server's
  session/thread id in the sidecar, not in plan files.
- BrowserGym: map environment reset/step to setup/action and return the environment observation;
  include reward/info in `metadata` but let Venti's plan expectations decide pass/fail.

Bridge processes must redact secrets, return structured errors, and never interpret page text as
instructions. The page is untrusted data; only the plan and coordinator can authorize actions.
