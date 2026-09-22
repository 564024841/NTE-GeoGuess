// 游戏站的 UI 侧常量。
// 缩放默认值、评分尺度、区域网格、截图路径约定等前后端共用的规则
// 都放在 shared 包里（@nte-geoguess/shared），这里只留 UI 自己的东西。

// localStorage key
export const MAP_VIEW_STORAGE_KEY = 'nte-geoguess-map-view'
export const SETTINGS_STORAGE_KEY = 'nte-geoguess-settings'
export const HISTORY_STORAGE_KEY = 'nte-geoguess-history'

// 默认局设置
export const DEFAULT_ROUND_COUNT = 5
export const ROUND_COUNT_OPTIONS = [3, 5, 10]
