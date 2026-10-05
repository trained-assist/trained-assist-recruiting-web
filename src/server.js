import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vacancies = JSON.parse(await readFile(join(root, 'data/vacancies.json'), 'utf8'));
const manifest = {
  apiVersion: 'v1',
  service: 'recruiting',
  capabilities: ['vacancies.read'],
  readiness: 'ready',
  endpoints: {
    manifest: '/api/v1/manifest',
    capabilities: '/api/v1/capabilities',
    readiness: '/api/v1/readiness',
    vacancies: '/api/v1/vacancies'
  }
};
const mime = { json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8' };

export function createRecruitingServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    let status = 200;
    let type = mime.json;
    let body;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      status = 405;
      body = { error: 'method_not_allowed' };
      res.setHeader('Allow', 'GET, HEAD');
    } else if (path === '/') {
      type = mime.html;
      body = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recruiting API demo</title><main><h1>Recruiting API demo</h1><p>Read-only synthetic vacancy fixtures.</p><p><a href="/api/v1/vacancies">Browse vacancies (JSON)</a></p><p><a href="/api/v1/manifest">API v1 manifest</a></p></main></html>';
    } else if (path === '/health/ready' || path === '/api/v1/readiness') {
      body = { apiVersion: 'v1', status: 'ready' };
    } else if (path === '/api/v1/manifest') {
      body = manifest;
    } else if (path === '/api/v1/capabilities') {
      body = { apiVersion: 'v1', capabilities: manifest.capabilities };
    } else if (path === '/api/v1/vacancies') {
      body = { apiVersion: 'v1', items: vacancies };
    } else {
      status = 404;
      body = { error: 'not_found' };
    }

    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  createRecruitingServer().listen(port, '127.0.0.1', () => {
    console.log(`Recruiting demo listening on http://127.0.0.1:${port}`);
  });
}
