import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { formatResults } from '../lib/browser-report.mjs';
import { checkGuard, parseDriverArguments } from '../lib/browser-guard.mjs';
import { settle } from '../lib/settle.mjs';

const SNAPSHOT_JS = String.raw`
(within) => {
  document.querySelectorAll('[data-hnl-ref]').forEach(e => e.removeAttribute('data-hnl-ref'));
  const scope = within ? document.querySelector(within) : null;
  if (within && !scope) return { error: 'within selector matched nothing: ' + within };
  const base = scope || document;
  const roots = [base];
  const collectShadow = (node) => {
    node.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) { roots.push(el.shadowRoot); collectShadow(el.shadowRoot); }
    });
  };
  collectShadow(base);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    const s = getComputedStyle(el);
    return !(s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0');
  };
  const name = (el) => {
    let t = el.getAttribute('aria-label') || '';
    if (!t) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) { const l = document.getElementById(lb); if (l) t = l.innerText || ''; }
    }
    if (!t) t = el.innerText || '';
    if (!t) t = el.value || el.getAttribute('placeholder') || el.getAttribute('title')
              || el.getAttribute('alt') || '';
    return String(t).replace(/\s+/g, ' ').trim().slice(0, 140);
  };
  const role = (el) => el.getAttribute('role') || el.tagName.toLowerCase();
  const INTERACTIVE = 'a,button,input,textarea,select,summary,[role],[onclick],[tabindex],[contenteditable="true"]';
  const out = [];
  let n = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll(INTERACTIVE)) {
      if (!visible(el)) continue;
      const r = role(el);
      if (['presentation', 'none'].includes(r)) continue;
      const nm = name(el);
      const rect = el.getBoundingClientRect();
      if (!nm && !['input', 'textarea', 'select', 'button', 'a'].includes(el.tagName.toLowerCase())) continue;
      if (rect.width > 900 && rect.height > 600 && !['input','textarea','button','a'].includes(el.tagName.toLowerCase())) continue;
      n += 1;
      const ref = 'e' + n;
      el.setAttribute('data-hnl-ref', ref);
      out.push({
        ref, role: r, tag: el.tagName.toLowerCase(), name: nm,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      });
    }
  }
  const source = scope || document.body;
  const text = (source ? source.innerText : '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
  return {
    url: location.href, title: document.title, elements: out, text,
    ...(within ? { within } : {}),
  };
}
`;

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function driverError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function findPage(context, target) {
  const matches = context.pages().filter((page) => page.url().includes(target));
  if (matches.length === 0) {
    throw driverError(
      'HONOLOLO_BROWSER_TAB_NOT_FOUND',
      `${target}; open tabs: ${context.pages().map((page) => page.url()).join(', ')}`,
    );
  }
  return matches[0];
}

function locate(page, ref) {
  return page.locator(`[data-hnl-ref="${ref}"]`).first();
}

async function writeExclusive(path, bytes) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw driverError('HONOLOLO_BROWSER_OUTPUT_CONFLICT', path);
    throw error;
  }
}

// `within` narrows the snapshot to one element subtree: its own text and controls only. A page whose
// chrome always shows an account name or a chat history cannot otherwise be captured cleanly, and a
// scoped census is also far smaller than a whole-document one.
async function takeSnapshot(page, within) {
  const argument = JSON.stringify(within ?? null);
  const snapshot = await page.evaluate(`(${SNAPSHOT_JS.trim()})(${argument})`);
  if (snapshot?.error) throw driverError('HONOLOLO_BROWSER_WITHIN_UNMATCHED', snapshot.error);
  return snapshot;
}

const REGION_METRICS_JS = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  return { rect: [r.x, r.y, r.width, r.height], dpr: window.devicePixelRatio };
})()`;

// `"clip": "within"` captures the whole surface and crops it to the scoped element using the page's
// own device pixel ratio.
//
// Playwright's `clip` and element screenshots both map CSS pixels to surface pixels with a scale
// they infer for the browser. When a human-operated Chrome has page zoom enabled that inferred scale
// disagrees with `window.devicePixelRatio`, and every region capture comes out shifted and
// mis-sized — silently, producing evidence that looks plausible but frames the wrong pixels.
// A full-surface screenshot needs no such mapping, so cropping it is exact at any zoom.
async function regionBytes(page, selector) {
  const metrics = await page.evaluate(REGION_METRICS_JS(selector));
  if (!metrics) throw driverError('HONOLOLO_BROWSER_WITHIN_UNMATCHED', selector);
  const surface = await page.screenshot();
  const { rect, dpr } = metrics;
  const { width, height } = await sharp(surface).metadata();
  // Clamped to the surface: a fractional device pixel ratio can round an edge-touching element one
  // pixel past the edge, which should crop to the edge rather than refuse the capture.
  const left = Math.max(0, Math.min(Math.round(rect[0] * dpr), width));
  const top = Math.max(0, Math.min(Math.round(rect[1] * dpr), height));
  const box = {
    left,
    top,
    width: Math.min(Math.round(rect[2] * dpr), width - left),
    height: Math.min(Math.round(rect[3] * dpr), height - top),
  };
  if (box.width < 1 || box.height < 1) {
    throw driverError(
      'HONOLOLO_BROWSER_REGION_OUT_OF_SURFACE',
      `${selector}: ${box.left},${box.top},${box.width},${box.height} in ${width}x${height}`,
    );
  }
  return {
    bytes: await sharp(surface).extract(box).png().toBuffer(),
    region: { within: selector, css_rect: rect.map((value) => Math.round(value)), dpr },
  };
}

async function screenshotBytes(page, command) {
  if (command.clip === 'within') {
    if (typeof command.within !== 'string' || command.within === '') {
      throw driverError('HONOLOLO_BROWSER_USAGE', 'clip "within" requires a within selector');
    }
    return regionBytes(page, command.within);
  }
  const options = { fullPage: command.full === true };
  if (Array.isArray(command.clip)) {
    const [x, y, width, height] = command.clip;
    options.clip = { x, y, width, height };
  }
  return { bytes: await page.screenshot(options), region: null };
}

// Waits for a named condition instead of guessing a duration. `optional` reports a miss and lets the
// op list continue; without it a missed condition stops the batch, which is the right default — the
// steps after an unmet precondition would act on a page that never arrived.
async function waitFor(page, command) {
  const timeout = command.timeout ?? 10000;
  const gone = command.gone === true;
  const started = Date.now();
  const selector = typeof command.selector === 'string' ? command.selector : '';
  const text = typeof command.text === 'string' ? command.text : '';
  if (selector === '' && text === '') {
    throw driverError('HONOLOLO_BROWSER_USAGE', 'wait_for needs a selector or text');
  }
  try {
    if (selector !== '') {
      await page.waitForSelector(selector, { state: gone ? 'hidden' : 'visible', timeout });
    } else {
      await page.waitForFunction(
        ([needle, absent]) => ((document.body?.innerText ?? '').includes(needle) !== absent),
        [text, gone],
        { timeout, polling: 100 },
      );
    }
  } catch (error) {
    if (command.optional === true) {
      return { matched: false, waited_ms: Date.now() - started };
    }
    throw driverError(
      'HONOLOLO_BROWSER_WAIT_TIMEOUT',
      `${selector !== '' ? selector : JSON.stringify(text)} after ${timeout}ms`,
    );
  }
  return { matched: true, waited_ms: Date.now() - started };
}

export async function runOp(page, command, guard) {
  const op = command.op;
  if (op === 'goto') {
    const violation = checkGuard(command.url, guard);
    if (violation) return { op, refused: true, ...violation };
    await page.goto(command.url, { waitUntil: 'domcontentloaded' });
    const settled = await settle(page, 'goto', command.ms);
    return { op, url: page.url(), settled_ms: settled.waited_ms };
  }
  if (op === 'snapshot') {
    const settled = await settle(page, 'snapshot', command.ms);
    const snapshot = await takeSnapshot(page, command.within);
    // Persisting a snapshot without a screenshot is the cheap path for a step whose criteria are all
    // textual: no PNG encode, and no pixels for the operator to inspect before the capture is saved.
    // A step that declares screenshot evidence must use `capture`, which pairs the two atomically.
    if (typeof command.path_prefix === 'string' && command.path_prefix !== '') {
      const snapshotPath = `${command.path_prefix}.snapshot.json`;
      await writeExclusive(
        snapshotPath, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'),
      );
      return { op, snapshot: snapshotPath, ...snapshot, settled_ms: settled.waited_ms };
    }
    return { op, ...snapshot, settled_ms: settled.waited_ms };
  }
  if (op === 'click') {
    await locate(page, command.ref).click({ timeout: command.timeout ?? 10000 });
    const settled = await settle(page, 'click', command.ms);
    return { op, ref: command.ref, url: page.url(), settled_ms: settled.waited_ms };
  }
  if (op === 'hover') {
    await locate(page, command.ref).hover({ timeout: command.timeout ?? 10000 });
    const settled = await settle(page, 'hover', command.ms);
    return { op, ref: command.ref, settled_ms: settled.waited_ms };
  }
  if (op === 'select') {
    const target = typeof command.label === 'string'
      ? { label: command.label }
      : { value: command.value };
    const selected = await locate(page, command.ref)
      .selectOption(target, { timeout: command.timeout ?? 10000 });
    const settled = await settle(page, 'select', command.ms);
    return { op, ref: command.ref, selected: selected.join(','), settled_ms: settled.waited_ms };
  }
  if (op === 'type') {
    const element = locate(page, command.ref);
    await element.click({ timeout: 10000 });
    await element.type(command.text, { delay: 20 });
    const settled = await settle(page, 'type', command.ms);
    return {
      op, ref: command.ref,
      chars: command.text.length,
      settled_ms: settled.waited_ms,
      ...(command.redact === true ? { text: '[REDACTED_INPUT]' } : {}),
    };
  }
  if (op === 'press') {
    await page.keyboard.press(command.key);
    const settled = await settle(page, 'press', command.ms);
    return { op, key: command.key, url: page.url(), settled_ms: settled.waited_ms };
  }
  if (op === 'scroll') {
    if (command.at) {
      // Some scroll containers only accept wheel events once hover has registered on them, so this
      // one short pause stays a pause: there is no document change to settle on.
      await page.mouse.move(command.at[0], command.at[1]);
      await page.waitForTimeout(100);
    }
    await page.mouse.wheel(0, command.dy ?? 600);
    const settled = await settle(page, 'scroll', command.ms);
    return { op, dy: command.dy ?? 600, settled_ms: settled.waited_ms };
  }
  if (op === 'wait_for') {
    return { op, ...(await waitFor(page, command)) };
  }
  if (op === 'wait') {
    await page.waitForTimeout(command.ms ?? 1000);
    return { op };
  }
  if (op === 'screenshot') {
    const { bytes } = await screenshotBytes(page, command);
    await writeExclusive(command.path, bytes);
    return { op, path: command.path, bytes: bytes.length, sha256: sha256(bytes), url: page.url() };
  }
  if (op === 'capture') {
    const prefix = command.path_prefix;
    if (typeof prefix !== 'string' || prefix === '') {
      throw driverError('HONOLOLO_BROWSER_USAGE', 'capture.path_prefix');
    }
    const settled = await settle(page, 'capture', command.ms);
    const snapshot = await takeSnapshot(page, command.within);
    const { bytes: imageBytes, region } = await screenshotBytes(page, command);
    const screenshotPath = `${prefix}.png`;
    const snapshotPath = `${prefix}.snapshot.json`;
    const record = {
      ...snapshot,
      ...(region ? { region } : {}),
      paired_screenshot: screenshotPath,
      paired_sha256: sha256(imageBytes),
    };
    await writeExclusive(screenshotPath, imageBytes);
    await writeExclusive(snapshotPath, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
    return {
      op,
      screenshot: screenshotPath,
      snapshot: snapshotPath,
      bytes: imageBytes.length,
      sha256: record.paired_sha256,
      url: snapshot.url,
      title: snapshot.title,
      elements: snapshot.elements,
      text: snapshot.text,
      settled_ms: settled.waited_ms,
    };
  }
  throw driverError('HONOLOLO_BROWSER_OP_UNKNOWN', String(op));
}

// A control with `target="_blank"` moves the flow to a tab this driver never looks at. Without this
// the batch keeps snapshotting the original page, and the agent reads an unchanged document as
// "the click did nothing" instead of "the page it opened is somewhere else". Reporting the tab is
// enough to redirect the next invocation; a tab outside the guard stops the batch like any drift.
export async function inspectNewTabs(context, known, guard) {
  const opened = [];
  for (const candidate of context.pages()) {
    if (known.has(candidate)) continue;
    known.add(candidate);
    try {
      await candidate.waitForLoadState('domcontentloaded', { timeout: 3000 });
    } catch {
      // A tab still loading reports whichever URL it already has, which is what the guard needs.
    }
    const url = candidate.url();
    opened.push(url);
    const violation = checkGuard(url, guard);
    if (violation) return { opened, violation };
  }
  return { opened, violation: null };
}

export async function runOps({ cdp, target, allow, scope, commands }) {
  const guard = { allow, scope };
  const results = [];
  const browser = await chromium.connectOverCDP(cdp);
  try {
    const context = browser.contexts()[0];
    if (!context) throw driverError('HONOLOLO_BROWSER_CONTEXT_MISSING');
    const page = findPage(context, target);
    await page.bringToFront();
    const initial = checkGuard(page.url(), guard);
    if (initial) {
      results.push({ op: 'safety_stop', ...initial });
      return results;
    }
    const known = new Set(context.pages());
    for (const command of commands) {
      try {
        results.push(await runOp(page, command, guard));
      } catch (error) {
        results.push({
          op: command.op,
          error: `${error?.message ?? error}`.slice(0, 400),
          url: page.url(),
        });
        break;
      }
      const tabs = await inspectNewTabs(context, known, guard);
      if (tabs.opened.length > 0) results.push({ op: 'new_tab', urls: tabs.opened.join(' ') });
      if (tabs.violation) {
        results.push({ op: 'safety_stop', ...tabs.violation });
        break;
      }
      const violation = checkGuard(page.url(), guard);
      if (violation) {
        results.push({ op: 'safety_stop', ...violation });
        break;
      }
    }
    results.push({ op: 'final', url: page.url() });
  } finally {
    await browser.close();
  }
  return results;
}

async function main(argv) {
  const options = parseDriverArguments(argv);
  let source = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) source += chunk;
  let commands;
  try {
    commands = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) throw driverError('HONOLOLO_BROWSER_STDIN_INVALID');
    throw error;
  }
  if (!Array.isArray(commands)) throw driverError('HONOLOLO_BROWSER_STDIN_INVALID');
  const results = await runOps({ ...options, commands });
  process.stdout.write(options.json ? `${JSON.stringify(results)}\n` : formatResults(results));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
