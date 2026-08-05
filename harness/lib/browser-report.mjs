const MAX_NAME = 80;
const COLLAPSE_AT = 3;
const REFS_SHOWN = 4;

function quoted(value) {
  const text = String(value ?? '');
  return JSON.stringify(text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text);
}

function shortDigest(sha256) {
  return typeof sha256 === 'string' ? sha256.replace(/^sha256:/u, '').slice(0, 12) : '';
}

// Repeated controls — list rows, table actions — dominate an element census while carrying almost no
// information per line. Identical role/name/state groups collapse to one line naming their refs; the
// persisted snapshot keeps every element, so annotation and inspection lose nothing.
export function elementLines(elements = []) {
  const counts = new Map();
  const key = (element) => `${element.role}\0${element.name}\0${element.disabled ? 1 : 0}`;
  for (const element of elements) counts.set(key(element), (counts.get(key(element)) ?? 0) + 1);

  const emitted = new Set();
  const lines = [];
  for (const element of elements) {
    const group = key(element);
    const label = `${element.role} ${quoted(element.name)}${element.disabled ? ' disabled' : ''}`;
    const total = counts.get(group);
    if (total < COLLAPSE_AT) {
      lines.push(`  ${element.ref} ${label} ${(element.box ?? []).join(',')}`);
      continue;
    }
    if (emitted.has(group)) continue;
    emitted.add(group);
    const refs = elements.filter((candidate) => key(candidate) === group).map(({ ref }) => ref);
    const shown = refs.slice(0, REFS_SHOWN).join(',');
    lines.push(`  ${label} ×${total} (${shown}${refs.length > REFS_SHOWN ? ',…' : ''})`);
  }
  return lines;
}

function snapshotBlock(result, header) {
  const lines = [header];
  lines.push(...elementLines(result.elements));
  if (result.text) {
    lines.push('  --- visible text ---');
    for (const line of String(result.text).split('\n')) lines.push(`  ${line}`);
  }
  return lines;
}

export function formatResult(result) {
  const op = result.op;
  if (result.error !== undefined) return [`${op} ERROR ${result.error}`];
  if (op === 'safety_stop') {
    return [`safety_stop ${result.code} ${result.url ?? result.hostname ?? ''}`.trimEnd()];
  }
  if (result.refused === true) return [`${op} REFUSED ${result.code} ${result.url ?? ''}`.trimEnd()];
  if (op === 'snapshot') {
    return snapshotBlock(
      result,
      `snapshot ${result.url} ${quoted(result.title)} ${(result.elements ?? []).length} elements`,
    );
  }
  if (op === 'capture') {
    return snapshotBlock(result, [
      `capture ${result.screenshot} ${result.bytes}B ${shortDigest(result.sha256)}`,
      `+ ${result.snapshot} ${(result.elements ?? []).length} elements ${result.url}`,
    ].join('\n'));
  }
  if (op === 'screenshot') {
    return [`screenshot ${result.path} ${result.bytes}B ${shortDigest(result.sha256)}`];
  }
  if (op === 'type') return [`type ${result.ref} ${result.chars} chars`];
  const detail = Object.entries(result)
    .filter(([name]) => name !== 'op')
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  return [`${op}${detail === '' ? '' : ` ${detail}`}`];
}

export function formatResults(results) {
  return `${results.flatMap((result) => formatResult(result)).join('\n')}\n`;
}
