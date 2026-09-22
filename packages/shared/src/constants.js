// 全局常量：视图默认值、评分尺度、分类与区域约定。
// 前端与后端共用，避免两边对「一题多少分」这类规则理解不一致。

// 视图默认值（沿用 MaaNTE-Map：地图 26112px、瓦片 512px、初始缩放 -3）
export const INITIAL_ZOOM = -3
export const MIN_ZOOM = -3
export const MAX_ZOOM = 1

// 评分尺度说明：
// 游戏真实坐标与地图不是等比关系（1 底图像素 ≈ 122 游戏单位，见 geometry.js），
// 把游戏坐标当「米」会让分数曲线完全失真——偏几个像素就等于扣掉大半分。
// 所以评分统一换算到「底图像素」这个玩家能直接感知的尺度。

export const ROUND_MAX_POINTS = 100
export const SCORE_HALF_LIFE_PIXELS = 50

export const DEFAULT_ROUND_COUNT = 5
export const ROUND_COUNT_OPTIONS = [3, 5, 10]
export const MAX_ROUND_COUNT = 50

// 偏差评价分档（单位：底图像素）
export const DISTANCE_TIERS = [
  { id: 'perfect', maxPixels: 12, label: '神了', color: '#5ddc9a' },
  { id: 'great', maxPixels: 40, label: '非常接近', color: '#8adfd6' },
  { id: 'good', maxPixels: 90, label: '还不错', color: '#ffd27d' },
  { id: 'fair', maxPixels: 180, label: '偏了', color: '#ffab6e' },
  { id: 'far', maxPixels: Number.POSITIVE_INFINITY, label: '差得远', color: '#ff8080' },
]

// 区域分类：区域归属改用「区域分类」表达，不再用九宫格方位（北西/中中…）。
// 这张表把区域分类 id 映射成区域名，供后端与后台复用；
// 实际分类清单以数据里的 categories 为准，这里只是 id ↔ 名称的约定。
export const REGION_CATEGORY_IDS = {
  向阳岛: 'region-hyuga',
  新赫兰德区: 'region-new-holland',
  未闻浦: 'region-miminoura',
  桥间地: 'region-hashima',
  米格尔区: 'region-miguel',
  绘空町: 'region-ekuumachi',
  薄暮区: 'region-twilight',
}

// 区域分类的 group 名，也是「哪些分类算区域分类」的判据
export const REGION_CATEGORY_GROUP = '区域'

export const REGION_NAME_BY_CATEGORY_ID = Object.fromEntries(
  Object.entries(REGION_CATEGORY_IDS).map(([name, id]) => [id, name]),
)

// 数据来源标记
export const SOURCE_MAP_DATA = 'map-data'
export const SOURCE_QUESTION_BANK = 'question-bank'

// 自建题目的归类
export const CUSTOM_REGION_LABEL = '自建题目'
export const DISTRICT_PLACEHOLDER = '全地图'

// 截图路径约定
export const LOCATION_IMAGE_PREFIX = '/images/locations/'
export const QUESTION_IMAGE_PREFIX = '/images/questions/'
export const MAX_QUESTION_IMAGE_BYTES = 8 * 1024 * 1024

// 支持的图片类型（扩展名按 MIME 决定，不信任上传文件名后缀）
export const EXTENSION_BY_MIME_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}
