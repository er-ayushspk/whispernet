import http from 'http';
import { createReadStream, statSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(
    import.meta.url);
const __dirname = path.dirname(__filename);

const port = process.env.PORT || 5173;

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

const publicDir = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(publicDir, path.normalize(reqPath));

    if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    if (existsSync(filePath)) {
        try {
            const ext = path.extname(filePath).toLowerCase();
            res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
            if (ext === '.html') {
                res.setHeader('Cache-Control', 'no-store');
            }
            const { size } = statSync(filePath);
            res.setHeader('Content-Length', size);
            createReadStream(filePath).pipe(res);
        } catch (err) {
            res.writeHead(500);
            res.end('Server error');
        }
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(port, () => {
    console.log(`WhisperNet server running at http://localhost:${port}`);
});