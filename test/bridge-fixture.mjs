import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';

let url = '';
let text = '';

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === 'open') {
    url = request.params.url;
    text = `Bridge page for ${url}`;
  } else if (request.method === 'observe') {
    result = { provider: 'bridge-fixture', observed_at: new Date().toISOString(), url, title: 'Bridge', text, snapshot: text };
  } else if (request.method === 'snapshot') {
    result = text;
  } else if (request.method === 'screenshot') {
    await writeFile(request.params.path, 'bridge screenshot\n', 'utf8');
    result = { path: request.params.path };
  } else if (request.method === 'close') {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
});
