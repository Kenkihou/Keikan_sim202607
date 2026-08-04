import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EARTH_DIR = path.resolve(HERE, '../04_earth-simulator');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
};

/**
 * 🌐 地球シミュレーター（04_earth-simulator）を /earth-api/ として配る開発用プラグイン。
 *
 * 04 は Vite を使わない素の静的サイト（importmap で CDN 直読み）なので、
 * ビルドもプロキシ先のサーバーも要らない。このプラグインが 01 の dev サーバーから
 * 04 のフォルダをそのまま配ることで、【01〜03 を npm run dev するだけ】で
 * iframe 連携が揃う（04 用に別のサーバーを立てる必要がない）。
 *
 * ※ 本番は .github/workflows/deploy.yml が combined_dist/earth-api/ へコピーするので、
 *   どちらの経路でも URL は同じ /earth-api/ になる。
 */
function serveEarthSimulator() {
  return {
    name: 'serve-earth-simulator',
    configureServer(server) {
      server.middlewares.use('/earth-api', (req, res, next) => {
        // クエリ（?from=modeling など）を落とし、日本語ファイル名のために復号する
        const raw = decodeURIComponent((req.url || '/').split('?')[0]);
        const rel = raw === '/' || raw === '' ? 'index.html' : raw.replace(/^\/+/, '');
        const file = path.resolve(EARTH_DIR, rel);

        // 04 のフォルダの外へ出る要求は受け付けない
        if (!file.startsWith(EARTH_DIR)) { res.statusCode = 403; return res.end('Forbidden'); }

        let stat;
        try { stat = fs.statSync(file); } catch { return next(); }
        const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
        try { stat = fs.statSync(target); } catch { return next(); }

        // 更新していないファイルは 304 で返す（04 を触りながらでも無駄な転送が出ない）
        const lastModified = stat.mtime.toUTCString();
        if (req.headers['if-modified-since'] === lastModified) {
          res.statusCode = 304;
          return res.end();
        }

        res.setHeader('Content-Type', MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Last-Modified', lastModified);
        fs.createReadStream(target).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: './',

  plugins: [serveEarthSimulator()],

  server: {
    open: true,

    proxy: {
      // 🎨 既存のマンセルシミュレーター用プロキシ（02 を npm run dev で起動しておく）
      '/munsell-api': {
        target: 'http://localhost:5174',
        changeOrigin: true
      },
      // 🌙 ★追加：夜間景観シミュレーター用プロキシ（03 を npm run dev で起動しておく）
      '/night-api': {
        target: 'http://localhost:5175',
        changeOrigin: true
      }
      // 🌐 地球シミュレーター（04）は上の serveEarthSimulator が直接配るのでプロキシ不要
    }
  }
});
