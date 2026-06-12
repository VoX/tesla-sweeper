import { join, extname, resolve, sep } from 'path';
import { statSync } from 'fs';

// Serve a `.br` pre-compressed sibling when the client accepts brotli.
// Falls through to the next handler (express.static) for non-br clients
// and for request types we don't pre-compress.
const BR_TYPES = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
};

export function brotliMiddleware(distDir) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const type = BR_TYPES[extname(req.path).toLowerCase()];
    if (!type || !(req.headers['accept-encoding'] || '').includes('br')) return next();
    const brPath = resolve(join(distDir, req.path) + '.br');
    // Containment: express does not normalize a literal /../ in the request
    // line, and unlike express.static this handler had no traversal guard.
    if (!brPath.startsWith(resolve(distDir) + sep)) return next();
    try { statSync(brPath); } catch { return next(); }
    res.set({
      'Content-Encoding': 'br',
      'Vary': 'Accept-Encoding',
      'Content-Type': `${type}; charset=utf-8`,
    });
    res.sendFile(brPath);
  };
}
