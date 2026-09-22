import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 后台站与游戏站一样，是纯前端：
//   · 数据与截图全部走服务端 API（见 docs/api-contract.md）
//   · 开发/预览时把 /api 与静态资源前缀代理到本地后端，避免跨域与 Cookie 的 SameSite 问题
//
// 环境变量：
//   VITE_API_BASE   后端地址（默认空 = 同源，配合下面的代理）
//   VITE_DEV_SERVER 后端端口，默认 8787（与游戏站共用同一个后端实例）

const DEV_SERVER_PORT = process.env.VITE_DEV_SERVER || '8787'
const API_TARGET = `http://127.0.0.1:${DEV_SERVER_PORT}`

// 后台比游戏站多代理 /icons（分类图标），少一个都不行：
// 分类管理里要显示图标，图标由后端 /icons/** 托管。
const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
  '/images': { target: API_TARGET, changeOrigin: true },
  '/icons': { target: API_TARGET, changeOrigin: true },
  '/mapsource-tiles': { target: API_TARGET, changeOrigin: true },
}

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5175,
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 4175,
    proxy,
  },
})
