import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { INITIAL_ZOOM, MAX_ZOOM, MIN_ZOOM } from '@nte-geoguess/shared/constants'
import L from '../utils/leaflet'
import { persistMapView, readStoredMapView } from '../utils/storage'

// 负责 Leaflet 实例本身：底图、视图、点位图层、落点、答案与结算连线。
// 不掺业务规则，业务状态由 useGame.js 持有。
//
// 坐标换算与地图元数据都来自服务端（store.js 用 createGeometry 构造），
// 所以本模块不 import 任何地图数据。

export function useMap({
  geometry,
  mapConfig,
  regionPositions,
  showRegionLabels,
  markerPuzzles,
  markerClusterEnabled,
  guessPoint,
  revealAnswer,
  answerPoint,
  onMapClick,
}) {
  const mapElement = ref(null)
  const map = shallowRef(null)
  const cursors = ref({ pixelX: 0, pixelY: 0, x: 0, y: 0 })
  const mapReady = ref(false)
  // Leaflet 实例不是响应式的，缩放级别单独用 ref 同步给 UI
  const zoom = ref(INITIAL_ZOOM)

  let markerLayer = null
  let overlayLayer = null
  let regionLabelLayer = null
  let viewPersistReady = false

  // 区域名标签从这一级开始才显示。
  // 初始视图是 -3（整图缩略），7 个标签会糊在一起；-2 是玩家开始辨认地形的档位。
  const REGION_LABEL_MIN_ZOOM = -2

  function updateRegionLabels() {
    if (!regionLabelLayer || !map.value) return
    const instance = map.value
    // divIcon 的字号不随缩放变化，所以在低缩放级别直接整层收起，避免糊成一团
    const shouldShow = showRegionLabels.value && instance.getZoom() >= REGION_LABEL_MIN_ZOOM
    if (shouldShow) {
      if (!instance.hasLayer(regionLabelLayer)) regionLabelLayer.addTo(instance)
    } else if (instance.hasLayer(regionLabelLayer)) {
      regionLabelLayer.remove()
    }
  }

  // 全部底图覆盖物的包围盒（CRS.Simple：lat 为负、lng 为正）
  function bounds() {
    const width = Number(mapConfig.value?.width) || 26112
    const height = Number(mapConfig.value?.height) || 26112
    return L.latLngBounds([-height, 0], [0, width])
  }

  function createMarkerLayer() {
    return markerClusterEnabled.value
      ? L.markerClusterGroup({
          chunkedLoading: true,
          maxClusterRadius: 52,
          disableClusteringAtZoom: 0,
          showCoverageOnHover: false,
        })
      : L.layerGroup()
  }

  function sourceIcon(puzzle) {
    const color = puzzle?.primaryCategoryColor || '#8adfd6'
    return L.divIcon({
      className: 'marker-shell',
      html: `<div class="map-marker" style="--marker-color:${color}"><span>${puzzle?.iconHtml || '?'}</span></div>`,
      iconSize: [36, 44],
      iconAnchor: [18, 42],
    })
  }

  // 图钉以「点位」为几何中心：锚点取图标正中，圆点中心即真实坐标，
  // 否则玩家看到的落点和实际判分坐标会有视觉偏差。
  function pinIcon(className, label) {
    return L.divIcon({
      className: 'pin-shell',
      html: `<div class="map-pin ${className}"><i></i><b>${label}</b></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    })
  }

  function renderMarkers() {
    if (!markerLayer || !geometry.value) return
    markerLayer.clearLayers()
    for (const puzzle of markerPuzzles.value) {
      markerLayer.addLayer(L.marker(geometry.value.gameToMapLatLng(puzzle), {
        icon: sourceIcon(puzzle),
        title: `${puzzle.name}${puzzle.district ? ` · ${puzzle.district}` : ''}`,
        riseOnHover: true,
      }))
    }
  }

  // 区域名标签：把区域名写在地图上，作为玩家定位的参照。
  // 落点来自 packages/shared/data/region-positions.json（标定像素），
  // 这里换算成 Leaflet 坐标；标签本身不可交互，不挡点击。
  function renderRegionLabels() {
    if (!regionLabelLayer) return
    regionLabelLayer.clearLayers()
    if (!geometry.value) return

    for (const region of regionPositions.value || []) {
      // region-positions.json 用 x / y（标定像素），与 shared 里的约定一致
      const latlng = geometry.value.mapLocatorToMapLatLng({
        pixelX: region.x,
        pixelY: region.y,
      })
      const icon = L.divIcon({
        className: 'region-label-shell',
        html: `<span class="region-label">${region.label}</span>`,
        // 用固定尺寸 + 居中锚点：divIcon 没有内容时也能正确定位
        iconSize: [120, 28],
        iconAnchor: [60, 14],
      })
      regionLabelLayer.addLayer(L.marker([latlng.lat, latlng.lng], {
        icon,
        interactive: false,
        keyboard: false,
      }))
    }
  }

  function rebuildMarkerLayer() {
    if (!map.value) return
    markerLayer?.clearLayers()
    markerLayer?.remove()
    markerLayer = createMarkerLayer().addTo(map.value)
    renderMarkers()
  }

  function renderOverlay() {
    if (!overlayLayer || !geometry.value) return
    overlayLayer.clearLayers()

    const guess = guessPoint.value
    const answer = revealAnswer.value ? answerPoint.value : null

    if (guess) {
      overlayLayer.addLayer(L.marker(geometry.value.gameToMapLatLng(guess), {
        icon: pinIcon('map-pin--guess', '你'),
        interactive: false,
      }))
    }

    if (answer) {
      overlayLayer.addLayer(L.marker(geometry.value.gameToMapLatLng(answer), {
        icon: pinIcon('map-pin--answer', '答'),
        interactive: false,
      }))
    }

    // 结算时用一条虚线直观展示偏差
    if (guess && answer) {
      overlayLayer.addLayer(L.polyline(
        [geometry.value.gameToMapLatLng(guess), geometry.value.gameToMapLatLng(answer)],
        { color: '#ff8080', weight: 2, opacity: 0.9, dashArray: '6 6', interactive: false },
      ))
    }
  }

  function fitToPoints(points, options = {}) {
    if (!map.value || !geometry.value || !points?.length) return
    const latLngs = points.map((point) => geometry.value.gameToMapLatLng(point))
    if (latLngs.length === 1) {
      map.value.setView(latLngs[0], options.maxZoom ?? 0, { animate: options.animate ?? true })
      return
    }
    map.value.fitBounds(L.latLngBounds(latLngs).pad(0.35), { animate: options.animate ?? true })
  }

  function focusPoint(point, targetZoom = 1) {
    if (!map.value || !geometry.value || !point) return
    map.value.setView(geometry.value.gameToMapLatLng(point), targetZoom, { animate: false })
  }

  // 当前视野中心对应的游戏坐标。
  // 用来做无歧义的坐标链路自检：地图有 maxBounds，
  // 把靠近边缘的点居中会被夹住，此时不能拿目标点当参照。
  function centerGamePoint() {
    if (!map.value || !geometry.value) return null
    return geometry.value.mapLatLngToGame(map.value.getCenter())
  }

  // 缩放一个级别。浏览器把 Shift+拖拽当成框选放大，会和地图平移冲突，
  // 所以地图交互改用按钮触发缩放。
  function shiftZoom(delta) {
    if (!map.value) return
    const target = map.value.getZoom() + delta
    if (target < MIN_ZOOM || target > MAX_ZOOM) return
    map.value.setZoom(target)
  }

  function resetView() {
    if (!map.value) return
    map.value.setView(bounds().getCenter(), INITIAL_ZOOM, { animate: false })
  }

  function createMap() {
    if (map.value || !mapElement.value || !geometry.value) return
    const mapBounds = bounds()
    const storedView = readStoredMapView()

    const instance = L.map(mapElement.value, {
      crs: L.CRS.Simple,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxBounds: mapBounds.pad(0.18),
      zoomControl: false,
      attributionControl: false,
    })

    L.tileLayer(mapConfig.value.tileUrl, {
      bounds: mapBounds,
      minZoom: MIN_ZOOM,
      // 瓦片仓库最高只到 z=0，再往上由 Leaflet 放大复用
      maxNativeZoom: 0,
      maxZoom: MAX_ZOOM,
      noWrap: true,
      tileSize: Number(mapConfig.value.tileSize) || 512,
      keepBuffer: 3,
    }).addTo(instance)

    L.control.zoom({ position: 'bottomright' }).addTo(instance)

    markerLayer = createMarkerLayer().addTo(instance)
    overlayLayer = L.layerGroup().addTo(instance)
    // 区域名图层单独一层：它不属于「点位标记」，开关与缩放行为都不一样
    regionLabelLayer = L.layerGroup()
    renderRegionLabels()

    instance.on('mousemove', ({ latlng }) => {
      // 两套坐标都要：标定像素便于和定位服务对齐，游戏坐标用于评分与展示
      cursors.value = {
        ...geometry.value.mapLatLngToMapLocator(latlng),
        ...geometry.value.mapLatLngToGame(latlng),
      }
    })

    instance.on('click', ({ latlng }) => {
      onMapClick?.(latlng)
    })

    instance.on('moveend zoomend', () => {
      zoom.value = instance.getZoom()
      // 区域名标签只在放大到一定级别后显示，所以缩放时要跟着开关
      updateRegionLabels()
      if (!viewPersistReady || !map.value) return
      const center = map.value.getCenter()
      persistMapView({ lat: center.lat, lng: center.lng, zoom: map.value.getZoom() })
    })

    if (storedView) {
      instance.setView([storedView.lat, storedView.lng], storedView.zoom, { animate: false })
    } else {
      instance.setView(mapBounds.getCenter(), INITIAL_ZOOM, { animate: false })
    }

    map.value = instance
    renderMarkers()
    renderOverlay()
    zoom.value = instance.getZoom()
    updateRegionLabels()
    viewPersistReady = true
    mapReady.value = true
  }

  onMounted(() => {
    createMap()
  })

  // 数据（geometry）是异步到达的：到达后再建图
  watch(geometry, () => {
    if (!map.value) createMap()
  })

  onBeforeUnmount(() => {
    map.value?.remove()
    map.value = null
    mapReady.value = false
  })

  watch(markerPuzzles, renderMarkers)
  watch(markerClusterEnabled, rebuildMarkerLayer)
  watch([guessPoint, revealAnswer, answerPoint], renderOverlay)
  watch(regionPositions, () => {
    renderRegionLabels()
    updateRegionLabels()
  })
  watch(showRegionLabels, updateRegionLabels)

  return {
    mapElement,
    map,
    mapReady,
    cursors,
    zoom,
    fitToPoints,
    focusPoint,
    centerGamePoint,
    shiftZoom,
    resetView,
    renderMarkers,
    updateRegionLabels,
  }
}
