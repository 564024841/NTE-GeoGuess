// 启动数据：一次 GET /api/bootstrap 拿到地图元信息、标定、分类与点位，
// 再交给 shared 的 createGeometry / buildPuzzleIndex 构造后台需要的两样东西：
//
//   · geometry —— 游戏坐标 ⇄ 底图像素 ⇄ Leaflet 坐标的换算（地图点选答案要用）
//   · index    —— 题库索引（分类分组、九宫格区域、题量统计）
//
// 注意题库快照有几百 KB，前端一律不打包（服务端从挂载的数据目录读），所有数据都从接口取。
import { ref, shallowRef, triggerRef } from 'vue'
import { buildPuzzleIndex, createGeometry } from '@nte-geoguess/shared'
import { api, describeApiError } from '../api'

export function useBootstrap() {
  const status = ref('idle') // idle | loading | ready | error
  const error = ref('')
  const mapConfig = shallowRef(null)
  const stats = shallowRef(null)
  const categories = shallowRef([])
  // 区域名标签的落点（标定像素）：地图上标出六块城区 + 薄暮区，出题时有个方位参照
  const regionPositions = shallowRef([])
  // geometry / index 里是上千个点位对象，用 shallowRef 避免 Vue 逐层做响应式代理
  const geometry = shallowRef(null)
  const index = shallowRef(null)

  async function load() {
    status.value = 'loading'
    error.value = ''
    try {
      const payload = await api.bootstrap({ includeAll: true })
      if (!payload?.map) throw new Error('启动数据缺少 map 字段')

      const nextGeometry = createGeometry(payload.map, payload.calibration)
      const nextIndex = buildPuzzleIndex(
        { categories: payload.categories || [], locations: payload.locations || [] },
        nextGeometry,
      )

      mapConfig.value = payload.map
      stats.value = payload.stats || null
      categories.value = payload.categories || []
      // 服务端下发的是数组；老版本服务端给的是整个文件对象，这里两种都认
      const positions = payload.regionPositions
      regionPositions.value = Array.isArray(positions)
        ? positions
        : (Array.isArray(positions?.regions) ? positions.regions : [])
      geometry.value = nextGeometry
      index.value = nextIndex
      status.value = 'ready'
      return true
    } catch (loadError) {
      status.value = 'error'
      error.value = describeApiError(loadError)
      return false
    }
  }

  // 新建分类后要让编辑器的分类下拉立刻能选到它（不为此重新拉一次 bootstrap）
  function addCategory(category) {
    if (!category?.id) return
    if (categories.value.some((item) => item.id === category.id)) return
    categories.value = [...categories.value, category]
    triggerRef(categories)
  }

  return { status, error, mapConfig, stats, categories, regionPositions, geometry, index, load, addCategory }
}
