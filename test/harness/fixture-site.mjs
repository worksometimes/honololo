import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
  'content-type': 'text/html; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

const STYLE = `
  :root { color-scheme: light; font-family: system-ui, sans-serif; }
  body { max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; }
  nav, main { display: grid; gap: 1rem; }
  nav { grid-auto-flow: column; justify-content: start; }
  .setting { display: flex; align-items: center; gap: .75rem; }
  [role="status"] { font-weight: 700; }
`;

function page(title, content, script = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${STYLE}</style>
</head>
<body>
${content}
${script ? `<script>${script}</script>` : ''}
</body>
</html>
`;
}

const ROUTES = new Map([
  ['/', page('HONOLOLO Fixture — Home', `
<main>
  <h1>HONOLOLO Fixture</h1>
  <p>A deterministic local site for evidence-first browser checks.</p>
  <nav aria-label="Fixture navigation">
    <a href="/settings">Settings</a>
    <a href="/error">Error state</a>
  </nav>
</main>`)],
  ['/settings', page('HONOLOLO Fixture — Settings', `
<main>
  <h1 id="page-heading">Loading settings…</h1>
  <section id="settings-panel" aria-labelledby="page-heading" hidden>
    <div class="setting">
      <label for="notifications">Email notifications</label>
      <input id="notifications" type="checkbox" role="switch" aria-describedby="notification-status">
      <span id="notification-status" role="status">Disabled</span>
    </div>
  </section>
  <nav aria-label="Fixture navigation"><a href="/">Home</a></nav>
</main>`, `
  const heading = document.querySelector('#page-heading');
  const panel = document.querySelector('#settings-panel');
  const toggle = document.querySelector('#notifications');
  const status = document.querySelector('#notification-status');
  setTimeout(() => {
    heading.textContent = 'Settings';
    panel.hidden = false;
  }, 40);
  toggle.addEventListener('change', () => {
    status.textContent = toggle.checked ? 'Enabled' : 'Disabled';
  });
`)],
  ['/error', page('HONOLOLO Fixture — Error', `
<main>
  <h1>Something went wrong</h1>
  <p>The fixture exposes this deterministic recovery state intentionally.</p>
  <a href="/">Home</a>
</main>`)],
]);

export async function startFixtureSite() {
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const body = ROUTES.get(path);
    if (!body || (method !== 'GET' && method !== 'HEAD')) {
      response.writeHead(body ? 405 : 404, {
        ...HEADERS,
        allow: 'GET, HEAD',
      });
      response.end();
      return;
    }
    response.writeHead(200, { ...HEADERS, 'content-length': Buffer.byteLength(body) });
    response.end(method === 'HEAD' ? undefined : body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HONOLOLO_FIXTURE_ADDRESS_INVALID');
  const origin = `http://127.0.0.1:${address.port}`;
  let closing;
  const close = () => {
    closing ??= new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return closing;
  };
  return { url: `${origin}/`, origin, close };
}

async function main() {
  const fixture = await startFixtureSite();
  process.stdout.write(`${JSON.stringify({ url: fixture.url })}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await fixture.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
