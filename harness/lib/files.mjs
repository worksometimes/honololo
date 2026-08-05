import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';

export function safeSlug(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new TypeError('HONOLOLO_SLUG_INVALID');
  }
  return value;
}

export function jobRelative(root, value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') ||
      isAbsolute(value) || posix.normalize(value) !== value || value === '..' ||
      value.startsWith('../')) throw new TypeError('HONOLOLO_PATH_INVALID');
  const base = resolve(root);
  const absolute = resolve(base, value);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
    throw new TypeError('HONOLOLO_PATH_OUTSIDE_ROOT');
  }
  if (relative(base, absolute).split(sep).includes('..')) {
    throw new TypeError('HONOLOLO_PATH_OUTSIDE_ROOT');
  }
  return absolute;
}

export async function writeExclusiveJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
}
