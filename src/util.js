import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rename, stat } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

export const nowIso = () => new Date().toISOString();

export function rootFromHere(fileUrl) {
  return resolve(dirname(new URL(fileUrl).pathname), '..');
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
  return path;
}

export async function atomicWrite(path, value) {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, value, 'utf8');
  await rename(temp, path);
}

export async function appendJsonl(path, value) {
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function readJsonl(path) {
  try {
    const source = await readFile(path, 'utf8');
    return source.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

export function deepGet(value, path) {
  const normalized = String(path).replace(/^\$\.?/, '').replace(/^\./, '');
  if (!normalized) return value;
  return normalized.split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    const match = key.match(/^([^[]+)(?:\[(\d+)\])?$/);
    if (!match) return undefined;
    const next = current[match[1]];
    return match[2] === undefined ? next : next?.[Number(match[2])];
  }, value);
}

export function toAbsolute(root, path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function redactText(value, patterns = []) {
  let output = String(value ?? '');
  for (const pattern of patterns) {
    if (!pattern) continue;
    output = output.split(String(pattern)).join('[REDACTED]');
  }
  return output;
}

export function redactDeep(value, patterns = []) {
  if (typeof value === 'string') return redactText(value, patterns);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, patterns));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, patterns)]));
  return value;
}

export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('**', '.*').replaceAll('*', '[^/]*')}$`);
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
