// 游戏站的数据入口。
//
// 与旧版最大的区别：地图元数据、坐标标定、分类与点位都不再打进前端包，
// 而是启动时从后端 /api/bootstrap 一次取回，再用共享包里的纯逻辑构造：
//
//   createGeometry(map, calibration)      → 坐标换算
//   buildPuzzleIndex({categories, locations}, geometry) → 题库索引
//
// 这样后台新增题目后，玩家刷新页面就能抽到，不需要重新构建前端。

import { ref, shallowRef } from 'vue'
import { buildPuzzleIndex, createGeometry } from '@nte-geoguess/shared'
import { getRegionPositions } from '@nte-geoguess/shared/regionPositions'
import { fetchBootstrap } from './api.js'

export function useGameData() {
  const status = ref('loading') // loading | ready | error
  const error = ref(null)
  const payload = shallowRef(null)
  const geometry = shallowRef(null)
  const puzzleIndex = shallowRef(null)
  // 区域名标签的落点（内容数据，不随题库变化）
  const regionPositions = shallowRef(getRegionPositions())

  async function load() {
    status.value = 'loading'
    error.value = null
    try {
      const bootstrap = await fetchBootstrap()
      if (!bootstrap?.map || !bootstrap?.calibration) {
        throw new Error('服务端返回的数据缺少 map 或 calibration')
      }

      payload.value = bootstrap
      geometry.value = createGeometry(bootstrap.map, bootstrap.calibration)
      puzzleIndex.value = buildPuzzleIndex(
        { categories: bootstrap.categories, locations: bootstrap.locations },
        geometry.value,
      )
      status.value = 'ready'
      return bootstrap
    } catch (caught) {
      status.value = 'error'
      error.value = caught.message || String(caught)
      return null
    }
  }

  return { status, error, payload, geometry, puzzleIndex, regionPositions, load }
}
