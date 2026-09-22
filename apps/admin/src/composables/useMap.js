// 后台地图实例。
//
// 与游戏站的 useMap 共用同一套底图参数（CRS.Simple / 瓦片 512 / minZoom -3 / maxZoom 1 /
// maxNativeZoom 0 / maxBounds 用 bounds.pad(0.18)），保证后台点选的位置和玩家看到的完全一致。
//
// 两处刻意不同：
//   1. 地图上不画任何题库点位——后台地图一旦显示点位就等于把答案提前摆在眼前，
//      和游戏站一样保持「只有底图 + 当前正在编辑的那个答案点」。
//      区域名标记是例外：它是区域级的参照，不泄露任何具体点位。
//   2. 点位数据由调用方通过 pinPoint 注入（当前草稿/编辑中的答案），点击回调用 onMapClick。
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { INITIAL_ZOOM, MAX_ZOOM, MIN_ZOOM } from '@nte-geoguess/shared'
import L from '../utils/leaflet'
import { publicAssetUrl } from '../utils/assets'

// geometry: createGeometry(...) 的返回值（调用方保证已就绪，本模块不做空判断）
// pinPoint: Ref<{x, y} | null>  当前答案位置（游戏坐标）
// regionPoints: Ref<Array<{ label, pixelX, pixelY }>>  区域名标记的落点（标定像素）
// showRegionLabels: Ref<boolean>  区域名标记开关
// onMapClick: (gamePoint) => void
export function useMap({ geometry, mapConfig, pinPoint, regionPoints, showRegionLabels, onMapClick }) {
  const mapElement = ref(null)
  const map = shallowRef(null)
  const mapReady = ref(false)
  const zoom = ref(INITIAL_ZOOM)
  const cursors = ref({ pixelX: 0, pixelY: 0, x: 0, y: 0 })

  // 全部底图覆盖物的包围盒：lng ∈ [0, mapWidth]，lat ∈ [-mapHeight, 0]
  const bounds = L.latLngBounds([-geometry.mapHeight, 0], [0, geometry.mapWidth])

  let pinLayer = null
  let regionLabelLayer = null

  // 区域名从这一级开始显示：初始 -3 是整图缩略，7 个标签会糊在一起
  const REGION_LABEL_MIN_ZOOM = -2

  function renderRegionLabels() {
    if (!regionLabelLayer) return
    regionLabelLayer.clearLayers()
    for (const region of regionPoints?.value || []) {
      const latlng = geometry.mapLocatorToMapLatLng({
        pixelX: region.pixelX,
        pixelY: region.pixelY,
      })
      const icon = L.divIcon({
        className: 'region-label-shell',
        html: `<span class="region-label">${region.label}</span>`,
        iconSize: [120, 28],
        iconAnchor: [60, 14],
      })
      regionLabelLayer.addLayer(L.marker([latlng.lat, latlng.lng], {
        icon,
        // 标签不可交互，免得挡住点击落点
        interactive: false,
        keyboard: false,
      }))
    }
  }

  function updateRegionLabels() {
    if (!regionLabelLayer || !map.value) return
    const instance = map.value
    const shouldShow = showRegionLabels?.value !== false && instance.getZoom() >= REGION_LABEL_MIN_ZOOM
    if (shouldShow) {
      if (!instance.hasLayer(regionLabelLayer)) regionLabelLayer.addTo(instance)
    } else if (instance.hasLayer(regionLabelLayer)) {
      regionLabelLayer.remove()
    }
  }

  // 图钉以「点位」为几何中心：锚点取图标正中，圆点中心才是真实坐标，
  // 否则后台看到的落点和入库的坐标会差半个图标。
  function pinIcon() {
    return L.divIcon({
      className: 'pin-shell',
      html: '<div class="map-pin map-pin--answer"><i></i><b>答</b></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    })
  }

  function renderPin() {
    if (!pinLayer) return
    pinLayer.clearLayers()
    const point = pinPoint?.value
    if (!point) return
    pinLayer.addLayer(L.marker(geometry.gameToMapLatLng(point), {
      icon: pinIcon(),
      interactive: false,
    }))
  }

  // 把某个游戏坐标放到视野中心（保存后回看、编辑已有题目时用）
  function focusPoint(point, targetZoom = 1) {
    if (!map.value || !point) return
    map.value.setView(geometry.gameToMapLatLng(point), targetZoom, { animate: false })
  }

  // 缩放一个级别。浏览器里 Shift+拖拽是框选放大，会和地图平移冲突，
  // 所以缩放统一交给按钮（与游戏站同一个理由）。
  function shiftZoom(delta) {
    if (!map.value) return
    const target = map.value.getZoom() + delta
    if (target < MIN_ZOOM || target > MAX_ZOOM) return
    map.value.setZoom(target)
  }

  function resetView() {
    if (!map.value) return
    map.value.setView(bounds.getCenter(), INITIAL_ZOOM, { animate: false })
  }

  onMounted(() => {
    const instance = L.map(mapElement.value, {
      crs: L.CRS.Simple,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxBounds: bounds.pad(0.18),
      zoomControl: false,
      attributionControl: false,
    })

    L.tileLayer(publicAssetUrl(mapConfig.tileUrl), {
      bounds,
      minZoom: MIN_ZOOM,
      // 瓦片仓库最高只到 z=0，再往上由 Leaflet 放大复用
      maxNativeZoom: 0,
      maxZoom: MAX_ZOOM,
      noWrap: true,
      tileSize: geometry.tileSize,
      keepBuffer: 3,
    }).addTo(instance)

    L.control.zoom({ position: 'bottomright' }).addTo(instance)

    pinLayer = L.layerGroup().addTo(instance)
    // 区域名单独一层：它不是点位标记，开关与缩放门槛都不一样
    regionLabelLayer = L.layerGroup()
    renderRegionLabels()

    instance.on('mousemove', ({ latlng }) => {
      // 两套坐标都给：像素用于复核标定，游戏坐标用于入库
      cursors.value = {
        ...geometry.mapLatLngToMapLocator(latlng),
        ...geometry.mapLatLngToGame(latlng),
      }
    })

    instance.on('click', ({ latlng }) => {
      onMapClick?.(geometry.mapLatLngToGame(latlng))
    })

    instance.on('moveend zoomend', () => {
      zoom.value = instance.getZoom()
      updateRegionLabels()
    })

    instance.setView(bounds.getCenter(), INITIAL_ZOOM, { animate: false })

    map.value = instance
    renderPin()
    zoom.value = instance.getZoom()
    updateRegionLabels()
    mapReady.value = true
  })

  onBeforeUnmount(() => {
    map.value?.remove()
    map.value = null
    mapReady.value = false
  })

  watch(pinPoint, renderPin, { deep: true })
  watch(regionPoints, () => {
    renderRegionLabels()
    updateRegionLabels()
  }, { deep: true })
  watch(() => showRegionLabels?.value, updateRegionLabels)

  return {
    mapElement,
    map,
    mapReady,
    zoom,
    cursors,
    focusPoint,
    shiftZoom,
    resetView,
  }
}
