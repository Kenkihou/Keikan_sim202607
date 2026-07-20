import { defineConfig } from 'vite';

export default defineConfig({
  base: './', 
  
  server: {
    open: true,
    
    proxy: {
      // 🎨 既存のマンセルシミュレーター用プロキシ
      '/munsell-api': {
        target: 'http://localhost:5174', 
        changeOrigin: true
      },
      // 🌙 ★追加：夜間景観シミュレーター用プロキシ
      '/night-api': {
        target: 'http://localhost:5175',
        changeOrigin: true
      }
    }
  }
});