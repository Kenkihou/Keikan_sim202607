import { defineConfig } from 'vite';

// 引数に { command } を受け取る関数形式に変更します
export default defineConfig(({ command }) => {
  return {
    // ★ 開発(serve)なら '/munsell-api/'、ビルド(build)なら './' を自動適用
    base: command === 'build' ? './' : '/munsell-api/',

    server: {
      port: 5174
    },

    build: {
      outDir: 'dist',
      emptyOutDir: true
    }
  };
});