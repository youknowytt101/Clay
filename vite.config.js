import { defineConfig } from 'vite';

export default defineConfig({
  // 播放期与编辑器分包是决策 24 的移植退路要求（goals.md §3.6.5）。
  // 现在只有一个入口，但 target 先定死：Rapier 的 wasm 胶水与 three 都要 es2022。
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  // 显式绑 IPv4：默认 host 在本机只监听 ::1，走 IPv4 的客户端会连不上。
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
