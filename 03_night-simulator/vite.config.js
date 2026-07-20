import { defineConfig } from 'vite';

// 引数に { command } を受け取る関数形式に変更します
export default defineConfig(({ command }) => {
  return {
    // ★ 開発(serve)なら '/night-api/'、ビルド(build)なら './' を自動適用
    base: command === 'build' ? './' : '/night-api/',

    server: {
      port: 5175,
      open: false // VS Code内で勝手に開かなくなる便利な設定を維持
    },

    build: {
      // ★ 出力先を標準の 'dist' フォルダに戻す（自動デプロイで素直に参照させるため）
      outDir: 'dist',
      emptyOutDir: true
    }
  };
});