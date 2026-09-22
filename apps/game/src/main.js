import { createApp } from 'vue'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
// 副作用导入：把 Leaflet 挂到全局，并在其后加载 markercluster 插件
import { markerClusterReady } from './utils/leaflet'
import './styles.css'
import App from './App.vue'

// 插件的加载是异步的（见 utils/leaflet.js），必须等它完成再挂载应用，
// 否则地图初始化时 L.markerClusterGroup 还不存在。
// 这里用 .then 而不是顶层 await：默认浏览器目标不支持 TLA。
markerClusterReady.then(() => {
  if (import.meta.env.DEV && typeof window.L?.markerClusterGroup !== 'function') {
    console.warn('[图寻] markercluster 插件未就绪，点位聚合会退回普通图层')
  }

  createApp(App).mount('#app')
})
