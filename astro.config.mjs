// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// 旧サイトの URL（/r07/q1/ のような末尾スラッシュ付きディレクトリ形式）をそのまま維持する。
// Search Console の実績と被リンクを引き継ぐため、URL 構造は変えない。
export default defineConfig({
  site: 'https://sokuryo-kakomon.com',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
