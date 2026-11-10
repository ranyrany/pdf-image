import { defineConfig } from 'vite';
import { cpSync, mkdirSync } from 'node:fs';
// PDF.js 보조 리소스도 로컬에서 제공하여 외부 CDN 요청을 없앱니다.
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  const target = new URL(`./public/pdf-assets/${dir}/`, import.meta.url);
  mkdirSync(target, { recursive: true });
  cpSync(new URL(`./node_modules/pdfjs-dist/${dir}/`, import.meta.url), target, { recursive: true });
}
export default defineConfig({ build: { chunkSizeWarningLimit: 900 } });
