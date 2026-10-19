import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const addon = resolve(here, '..', '..', 'nexus-addon');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.md': 'text/plain' };
const resourceColors = {
  ore: '#f5a000', silicates: '#9259ff', hydrogen: '#36dbff', alloys: '#a0aec0',
  cryo_ice: '#85e5f0', quantum_dust: '#fa72be', plasma_core: '#ff8500',
  bio_extract: '#7ed957', dark_matter: '#bc8cff', antimatter: '#ff6b7a',
};

export function createDemoServer() {
  return createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Read-only demo server.');
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/.nexus-install.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(req.method === 'HEAD' ? undefined : JSON.stringify({ channel: 'demo' }));
        return;
      }
      const icon = /^\/images\/resources\/([a-z_]+)\.webp$/.exec(pathname);
      if (icon && resourceColors[icon[1]]) {
        const color = resourceColors[icon[1]];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="#102036" stroke="${color}"/><path d="m16 6 9 10-9 10L7 16Z" fill="${color}"/><path d="m16 6 0 20 9-10Z" fill="#fff" opacity=".2"/></svg>`;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(req.method === 'HEAD' ? undefined : svg);
        return;
      }
      const demoFile = pathname === '/demo/browser.js' || pathname === '/demo/fixtures.js';
      const root = demoFile ? here : addon;
      const relative = demoFile ? pathname.slice('/demo/'.length) : pathname === '/' ? 'dashboard.html' : pathname.slice(1);
      const file = resolve(root, relative);
      if (!file.startsWith(root + sep) || !types[extname(file)] || relative.split(/[\\/]/).some(p => p.startsWith('.'))) {
        res.writeHead(404).end('Not found.');
        return;
      }
      let body = await readFile(file);
      if (extname(file) === '.html') {
        body = body.toString()
          .replace('<script src="browser-polyfill.js"></script>', '<script type="module" src="/demo/browser.js"></script>')
          .replace('<script src="server-storage.js"></script>', '')
          .replace('<option value="s0">NX-S0</option>', '<option value="demo">Demo Universe (fictional)</option>')
          .replace('<option value="beta">NX-BETA</option>', '')
          .replaceAll(/id="(btn-import|btn-import-settings|f-import|import-file|import-settings-file|f-import-file)"/g,
            'id="$1" disabled')
          .replace('<span>Nexus Overseer</span>', '<span>Nexus Overseer &middot; Fictional demo data</span>');
      } else if (extname(file) === '.js') {
        body = body.toString().replaceAll('https://s0.nexuslegacy.space/images/resources/', '/images/resources/');
      }
      res.writeHead(200, { 'Content-Type': `${types[extname(file)]}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof URIError) {
        res.writeHead(404).end('Not found.');
      } else {
        console.error('[Demo] Request failed:', error);
        res.writeHead(500).end('Demo server error.');
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const server = createDemoServer();
  server.on('error', error => {
    console.error('[Demo] Could not start:', error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Fictional demo: http://127.0.0.1:${port}`);
    console.log('No account access. Game actions are blocked. Reload to reset demo data.');
  });
}
