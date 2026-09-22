// Leaflet 及插件必须从这里统一引入。
//
// 背景：leaflet.markercluster 1.5.3 是 UMD 包，但源码内部直接使用裸标识符 `L`
// （旧版本靠 `(function(global){...}(this))` 里的 `this === window` 才能取到）。
// Leaflet 官方 ESM 构建不会设置 window.L，因此在打包器里直接 import 插件会抛
// `ReferenceError: L is not defined`。
//
// 解决方式：本模块先执行副作用，把 Leaflet 挂到全局，再由本模块加载插件；
// 模块内部保证顺序，其他文件只需 `import L from './leaflet'`。
import L from 'leaflet'

if (typeof window !== 'undefined') {
  window.L = L
}

// 关键：静态 import 会被提升到模块顶部执行，无法用「先赋值再 import」的顺序。
// 这里改用动态 import，插件就会在 window.L 就绪之后才求值。
export const markerClusterReady = import('leaflet.markercluster')

export default L
