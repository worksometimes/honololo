# Quickstart

## Claude Code

From this repository:

```text
/mini-venti https://your-site.example
```

Venti will scout the target, present a small set of test choices, ask for approval, freeze a plan,
run it, and write a report under `runs/`. To replay a frozen plan:

```text
/mini-venti run <plan-id>
```

The Claude-specific role entry points live in `.claude/agents/`; their source contracts live in
`agents/` so the behavior stays portable.

## Codex

Use the same repository instructions and invoke the skill phases explicitly:

```text
Read AGENTS.md, .claude/skills/mini-venti/SKILL.md, and docs/contracts/.
Run a generic QA flow for https://your-site.example.
```

If Codex exposes native subagents, dispatch the roles in `agents/` according to the graph. If not,
run the roles inline and set `execution_mode: inline_degraded` in the manifest.

## First-run setup

The baseline browser path needs `agent-browser` and `jq` for valid append-only JSONL artifacts:

```bash
npm i -g agent-browser
agent-browser install
brew install jq                 # macOS; use your platform package manager elsewhere
./bin/venti doctor
npm install
npm run doctor
```

The deterministic execution core can run a frozen plan without Claude Code:

```bash
./bin/venti-run run plans/example-web-smoke.yaml --provider agent-browser
./bin/venti-run run plans/example-api-smoke.yaml --provider http
```

Provider discovery and contract tests:

```bash
./bin/venti-run providers
npm test
npm run lint
```

Playwright over an existing CDP browser:

```bash
export VENTI_CDP_URL="$(agent-browser --namespace pw-demo --session pw-demo \
  --allowed-domains example.com open https://example.com >/dev/null && \
  agent-browser --namespace pw-demo --session pw-demo get cdp-url)"
./bin/venti-run run plans/example-playwright-cdp.yaml --provider playwright
```

For current Browser Use, start or obtain a CDP endpoint and run the built-in harness adapter:

```bash
export VENTI_CDP_WS="ws://127.0.0.1:9222/devtools/browser/..."
./bin/venti-run run plans/example-browser-use.yaml --provider browser-use
```

For Browser Use Cloud, use its raw browser/CDP session with the Playwright plan or the current
Browser Use plan. The legacy `open/state/click/type` CLI profile remains available as
`--provider browser-use-cli`. Stagehand, BrowserGym, MCP, and autonomous agent SDKs can use the
small JSONL bridge in `docs/contracts/bridge-protocol.md`; the harness core does not import their
runtime-specific SDKs.

Authentication is interactive. Venti opens a headed browser and waits for the user to log in; it
never asks for or stores a password.

## What to inspect after a run

```text
runs/<run-id>/report.md       # conclusion first
runs/<run-id>/results.jsonl   # machine-readable item verdicts
runs/<run-id>/evidence/       # screenshots and action ledgers
sites/<target-key>/           # audited durable knowledge
```

## Adding a target pack

Create `sites/<target-key>/map.md`, `selectors.md`, and `findings.md`. Keep target-specific facts
there; keep universal behavior in the Venti skill, role prompts, schemas, and contracts.
