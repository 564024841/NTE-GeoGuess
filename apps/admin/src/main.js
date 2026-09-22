import { createApp } from 'vue'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
// 副作用导入：把 Leaflet 挂到全局，并在其后加载 markercluster 插件
import { markerClusterReady } from './utils/leaflet'
import './styles.css'
import App from './App.vue'

// 与游戏站完全一致的启动顺序：插件的加载是异步的（见 utils/leaflet.js），
// 必须等它完成再挂载应用，否则任何用到 window.L 的代码都会抛 `L is not defined`。
// 这里用 .then 而不是顶层 await：默认浏览器目标不支持 TLA，vite build 会直接失败。
markerClusterReady.then(() => {
  createApp(App).mount('#app')
})
