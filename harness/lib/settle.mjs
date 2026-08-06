// A fixed sleep after every operation is the transport's largest avoidable cost and its most common
// source of a capture taken mid-render: too short for a slow page, wasted time on a fast one. Each
// op instead waits until the document stops changing, which on a responsive page resolves in a
// fraction of the old delay, and falls back to a bounded cap so a page carrying a permanent
// animation — a spinner, a clock, a blinking caret — can never stall the run.
//
// Every cap is at most the fixed delay it replaced, so the slowest possible settle matches the old
// behaviour and the common case is far faster.
export const SETTLE_BUDGETS = {
  goto: { quiet: 200, cap: 2500 },
  click: { quiet: 150, cap: 1500 },
  press: { quiet: 150, cap: 1500 },
  select: { quiet: 150, cap: 1500 },
  type: { quiet: 100, cap: 600 },
  scroll: { quiet: 100, cap: 600 },
  hover: { quiet: 100, cap: 600 },
  snapshot: { quiet: 120, cap: 800 },
  capture: { quiet: 120, cap: 800 },
};

const FALLBACK = { quiet: 120, cap: 800 };

export const SETTLE_JS = String.raw`
(({ quiet, cap }) => new Promise((resolve) => {
  const start = Date.now();
  let last = start;
  const observer = new MutationObserver(() => { last = Date.now(); });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  const finish = (reason) => {
    observer.disconnect();
    resolve({ waited_ms: Date.now() - start, reason });
  };
  const tick = () => {
    const now = Date.now();
    if (now - start >= cap) return finish('cap');
    if (now - last >= quiet && document.readyState === 'complete') return finish('quiet');
    setTimeout(tick, 25);
  };
  setTimeout(tick, 0);
}))
`;

// An explicit `ms` on an op becomes the settle budget rather than a guaranteed sleep: it is the
// longest the op may wait, not the shortest. The `wait` op remains for a guaranteed pause.
export function settleBudget(op, ms) {
  const base = SETTLE_BUDGETS[op] ?? FALLBACK;
  if (!Number.isFinite(ms) || ms <= 0) return { ...base };
  const cap = Math.round(ms);
  return { quiet: Math.max(25, Math.min(base.quiet, Math.ceil(cap / 4))), cap };
}

// A navigation started by the op destroys the execution context the settle promise lives in. That is
// an ordinary outcome, not a failure: the page moved on, which is exactly what the op asked for. One
// retry settles the document that replaced it; a second failure returns rather than throwing, so a
// transport op is never lost to its own wait.
export async function settle(page, op, ms) {
  const budget = settleBudget(op, ms);
  const argument = JSON.stringify(budget);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await page.evaluate(`(${SETTLE_JS.trim()})(${argument})`);
    } catch {
      // fall through to the retry, then to the reported non-settle
    }
  }
  return { waited_ms: 0, reason: 'context_lost' };
}
