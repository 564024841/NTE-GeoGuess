<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { formatGameUnits, formatPixels } from '@nte-geoguess/shared/format'
import { useGameData } from './game/store'
import { useGame } from './game/useGame'
import { useMap } from './game/useMap'
import CluePanel from './components/CluePanel.vue'
import SetupPanel from './components/SetupPanel.vue'
import RoundResultPanel from './components/RoundResultPanel.vue'
import SessionSummary from './components/SessionSummary.vue'
import MapHud from './components/MapHud.vue'

// 数据来自服务端：地图元数据、坐标标定、分类与点位
const data = useGameData()
const { status, error, payload, geometry, puzzleIndex, regionPositions } = data

const game = useGame({ puzzleIndex, geometry })
const {
  categoryGroups,
  settings,
  phase,
  rounds,
  currentIndex,
  currentRound,
  answerPoint,
  guessPoint,
  revealAnswer,
  interactive,
  isLastRound,
  summary,
  markerPuzzles,
  candidateCount,
  history,
  toggleCategory,
  setCategoryGroup,
  clearSettings,
  startGame,
  reroll,
  placeGuess,
  confirmGuess,
  nextRound,
  resetToSetup,
} = game

const mapApi = useMap({
  geometry,
  mapConfig: computed(() => payload.value?.map || {}),
  regionPositions,
  showRegionLabels: computed(() => settings.value.showRegionLabels),
  markerPuzzles,
  markerClusterEnabled: computed(() => true),
  guessPoint,
  revealAnswer,
  answerPoint,
  onMapClick: (latlng) => {
    if (!interactive.value || !geometry.value) return
    placeGuess(geometry.value.mapLatLngToGame(latlng))
  },
})

const { mapElement, cursors, zoom, fitToPoints, focusPoint, centerGamePoint, shiftZoom, resetView } = mapApi

const isReady = computed(() => status.value === 'ready')
const isSetup = computed(() => phase.value === 'setup')
const isFinished = computed(() => phase.value === 'finished')

const clueImage = computed(() => currentRound.value?.puzzle?.images?.[0] || null)
const roundLabel = computed(() => `${currentIndex.value + 1} / ${rounds.value.length}`)
const runningPoints = computed(() => summary.value.totalPoints)

const index = computed(() => puzzleIndex.value || {
  puzzles: [],
  allLocations: [],
  categories: [],
  categoriesById: new Map(),
  locationCountByCategory: {},
  categoriesWithPuzzles: [],
  customPuzzleCount: 0,
})

const currentCategory = computed(() => {
  const categoryId = currentRound.value?.puzzle?.primaryCategoryId
  return categoryId ? index.value.categoriesById.get(categoryId) : null
})

const confirmHint = computed(() => {
  if (phase.value !== 'playing') return ''
  if (!guessPoint.value) return '在地图上点击你认为的位置'
  const guess = guessPoint.value
  return `已选点（游戏坐标 ${Math.round(guess.x)}, ${Math.round(guess.y)}）`
})

const customPuzzleCount = computed(() => index.value.customPuzzleCount || 0)

// 每个分类下的点位数量：用于在筛选面板上标注「这个分类有多少点位、能不能出题」。
// 注意 buildPuzzleIndex 里是 Map，但数据经 HTTP（JSON）传过来会退化成普通对象，
// 所以这里统一转成 Map，模板才能用 .get()。
const categoryLocationCounts = computed(() => {
  const source = index.value.locationCountByCategory
  if (source instanceof Map) return source
  return new Map(Object.entries(source || {}))
})
const categoriesWithPuzzles = computed(() => new Set(index.value.categoriesWithPuzzles || []))

// 键盘推进：空格确认/下一题，R 换一批题
function handleKeydown(event) {
  if (event.target instanceof HTMLInputElement) return
  if (event.code === 'Space' || event.code === 'Enter') {
    event.preventDefault()
    if (phase.value === 'playing' && guessPoint.value) confirmGuess()
    else if (phase.value === 'revealed') handleNext()
  }
  if (event.key.toLowerCase() === 'r' && phase.value !== 'finished') reroll()
}

// 揭晓答案后把「玩家落点 + 正确答案」一起拉进视野
function handleFitRound() {
  const points = [guessPoint.value, answerPoint.value].filter(Boolean)
  fitToPoints(points, { animate: true })
}

function handleStart() {
  startGame()
  resetView()
}

function handleNext() {
  nextRound()
  resetView()
}

async function reload() {
  const bootstrap = await data.load()
  if (bootstrap) resetView()
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  await data.load()

  // 开发期调试出口：让自动化校验脚本能把地图定位到任意游戏坐标，
  // 用来核对「题面截图」和「地图位置」是否真的对应。生产构建里不存在。
  if (import.meta.env.DEV) {
    window.__NTE_GEOGUESS__ = {
      focusPoint,
      resetView,
      fitToPoints,
      // 坐标口径：给自动化校验直接验证「标定像素 ⇄ Leaflet 坐标」往返
      toLatLng: (pixel) => geometry.value?.mapLocatorToMapLatLng(pixel),
      toPixel: (latlng) => geometry.value?.mapLatLngToMapLocator(latlng),
      getPuzzles: () => puzzleIndex.value?.puzzles || [],
      getRegionPositions: () => regionPositions.value || [],
      // 让校验脚本能把视图拉到指定 zoom（标签有显示门槛，默认视图看不到）
      getMap: () => mapApi.map.value,
      setZoom: (value) => mapApi.map.value?.setZoom(value),
      getCategories: () => puzzleIndex.value?.categories || [],
      getGeometryInfo: () => (geometry.value
        ? {
            gameUnitsPerMapPixel: geometry.value.unitsPerMapPixel,
            mapWidth: geometry.value.mapWidth,
            locatorSourceWidth: geometry.value.locatorWidth,
            // 标定样本与解出的仿射系数：用来在浏览器里直接验证换算公式
            calibrationPoints: payload.value?.calibration?.points || [],
            affine: geometry.value.affine,
          }
        : null),
      reload,
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="app-shell">
    <div ref="mapElement" class="map-canvas" />

    <header class="topbar glass-panel">
      <div class="brand">
        <span class="brand__mark">图寻</span>
        <div class="brand__text">
          <strong>NTE 图寻</strong>
          <small>看截图 · 猜位置 · 偏差越小分越高</small>
        </div>
      </div>

      <div class="topbar__stats">
        <div class="stat">
          <span>题号</span>
          <strong>{{ isSetup ? '—' : roundLabel }}</strong>
        </div>
        <div class="stat">
          <span>本局得分</span>
          <strong>{{ runningPoints }}</strong>
        </div>
        <div class="stat">
          <span>视角</span>
          <strong>{{ zoom }}</strong>
        </div>
      </div>
    </header>

    <MapHud
      v-if="isReady"
      :cursors="cursors"
      @zoom-in="shiftZoom(1)"
      @zoom-out="shiftZoom(-1)"
      @reset-view="resetView"
      @fit-round="handleFitRound"
    />

    <aside class="sidebar glass-panel">
      <!-- 加载中 / 加载失败：数据没到之前不建地图 -->
      <div v-if="status === 'loading'" class="panel-scroll">
        <section class="panel-block">
          <h2>正在载入地图数据</h2>
          <p class="panel-note">首次访问需要从服务端取回地图元数据与题库，请稍候。</p>
          <div class="loading-bar"><i /></div>
        </section>
      </div>

      <div v-else-if="status === 'error'" class="panel-scroll">
        <section class="panel-block">
          <h2>无法载入地图数据</h2>
          <p class="status-banner status-banner--error">{{ error }}</p>
          <p class="panel-note panel-note--tight">
            请确认服务端已启动（默认 http://127.0.0.1:8787），
            或在部署环境里把 /api 反代到后端。
          </p>
        </section>
        <div class="panel-actions">
          <button type="button" class="primary-button" @click="reload">重试</button>
        </div>
      </div>

      <template v-else>
        <SetupPanel
          v-if="isSetup"
          :category-groups="categoryGroups"
          :settings="settings"
          :candidate-count="candidateCount"
          :puzzle-total="index.puzzles.length"
          :location-total="index.locationCount || index.allLocations.length"
          :custom-puzzle-count="customPuzzleCount"
          :category-location-counts="categoryLocationCounts"
          :categories-with-puzzles="categoriesWithPuzzles"
          :history="history"
          @toggle-category="toggleCategory"
          @toggle-group="setCategoryGroup"
          @clear="clearSettings"
          @update-count="(value) => (settings.count = value)"
          @update-answer-meta="(value) => (settings.showAnswerMeta = value)"
          @update-region-labels="(value) => (settings.showRegionLabels = value)"
          @start="handleStart"
          @reroll="reroll"
        />

        <template v-else-if="!isFinished">
          <CluePanel
            :round="currentRound"
            :round-label="roundLabel"
            :clue-image="clueImage"
            :phase="phase"
            :guess-hint="confirmHint"
            :has-guess="Boolean(guessPoint)"
            :category="currentCategory"
            :show-answer-meta="settings.showAnswerMeta"
            @confirm="confirmGuess"
            @next="handleNext"
            @quit="resetToSetup"
          />

          <RoundResultPanel
            v-if="phase === 'revealed'"
            :round="currentRound"
            :format-pixels="formatPixels"
            :format-game-units="formatGameUnits"
          />
        </template>

        <SessionSummary
          v-else
          :summary="summary"
          :rounds="rounds"
          :format-pixels="formatPixels"
          @again="handleStart"
          @setup="resetToSetup"
        />
      </template>
    </aside>
  </div>
</template>
