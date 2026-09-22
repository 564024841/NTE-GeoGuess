import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 游戏站是纯只读前端：
//   · 底图瓦片与题库数据都由服务端提供（见 server/）
//   · 开发时把 /api 与 /images 代理到本地后端，避免跨域配置
//
// 环境变量：
//   VITE_API_BASE   后端地址（默认空 = 同源，配合下面的 dev 代理）
//   VITE_DEV_SERVER 开发时后端端口，默认 8787

const DEV_SERVER_PORT = process.env.VITE_DEV_SERVER || '8787'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': { target: `http://127.0.0.1:${DEV_SERVER_PORT}`, changeOrigin: true },
      '/images': { target: `http://127.0.0.1:${DEV_SERVER_PORT}`, changeOrigin: true },
      '/mapsource-tiles': { target: `http://127.0.0.1:${DEV_SERVER_PORT}`, changeOrigin: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    proxy: {
      '/api': { target: `http://127.0.0.1:${DEV_SERVER_PORT}`, changeOrigin: true },
      '/images': { target: `http://127.0.0.1:${DEV_SERVER_PORT}`, changeOrigin: true },
      '/mapsource-tiles': { target: `http://127.0.0.1:${DEV_SERVER_PORT}`, changeOrigin: true },
    },
  },
})
