import { computed, ref, watch } from 'vue'
import {
  DEFAULT_ROUND_COUNT,
  ROUND_MAX_POINTS,
} from '@nte-geoguess/shared/constants'
import { countCandidates, createSeed, groupPuzzleCategories, selectRounds } from '@nte-geoguess/shared/puzzles'
import { evaluateRound, summarizeSession } from '@nte-geoguess/shared/scoring'
import { persistHistory, persistSettings, readStoredHistory, readStoredSettings } from '../utils/storage'

// 一局「图寻」的状态机：
//   setup → playing →（点地图落点）→ revealed → 下一题 → … → finished
//
// 题库索引与坐标换算都由外部注入（见 store.js）：
// 数据来自服务端 /api/bootstrap，本模块只负责游戏规则。

export function useGame({ puzzleIndex, geometry }) {
  // 列出全部可见分类（包括点位暂时都没有截图的区域分类），
  // 这样用户能看到完整的分类框架；点了没题时开始按钮会给出提示。
  const categoryGroups = computed(() => (
    puzzleIndex.value ? groupPuzzleCategories(puzzleIndex.value) : []
  ))

  const storedSettings = readStoredSettings() || {}

  const phase = ref('setup') // setup | playing | revealed | finished
  const settings = ref({
    count: Number(storedSettings.count) > 0 ? Number(storedSettings.count) : DEFAULT_ROUND_COUNT,
    categoryIds: Array.isArray(storedSettings.categoryIds) ? storedSettings.categoryIds : [],
    // 结算后在题面卡片上显示「所在区域 / 目标名称」，方便复盘
    showAnswerMeta: storedSettings.showAnswerMeta !== false,
    // 在地图上标注区域名（放大到 -2 及以上才出现），作为定位参照
    showRegionLabels: storedSettings.showRegionLabels !== false,
  })

  const rounds = ref([])
  const currentIndex = ref(0)
  const seed = ref(createSeed())
  const history = ref(readStoredHistory())

  const candidateCount = computed(() => (
    puzzleIndex.value ? countCandidates(puzzleIndex.value, settings.value) : 0
  ))
  const currentRound = computed(() => rounds.value[currentIndex.value] || null)
  const answerPoint = computed(() => currentRound.value?.puzzle || null)
  const guessPoint = computed(() => currentRound.value?.guess || null)
  const revealAnswer = computed(() => phase.value === 'revealed' || phase.value === 'finished')
  const interactive = computed(() => phase.value === 'playing')
  const isLastRound = computed(() => currentIndex.value >= rounds.value.length - 1)
  const summary = computed(() => summarizeSession(rounds.value))

  // 地图上的点位图标已关闭：标记会遮挡底图纹理，也等于提前剧透所有出题位置。
  // 保留这个 computed 是为了将来做「答对后才显示」时有个明确的接入点。
  const markerPuzzles = computed(() => [])

  function persistCurrentSettings() {
    persistSettings({
      count: settings.value.count,
      categoryIds: settings.value.categoryIds,
      showAnswerMeta: settings.value.showAnswerMeta,
      showRegionLabels: settings.value.showRegionLabels,
    })
  }

  watch(settings, persistCurrentSettings, { deep: true })

  function toggleCategory(id) {
    const list = new Set(settings.value.categoryIds)
    if (list.has(id)) list.delete(id)
    else list.add(id)
    settings.value.categoryIds = [...list]
  }

  function setCategoryGroup(groupItems, selected) {
    const list = new Set(settings.value.categoryIds)
    for (const category of groupItems) {
      if (selected) list.add(category.id)
      else list.delete(category.id)
    }
    settings.value.categoryIds = [...list]
  }

  function clearSettings() {
    settings.value = { ...settings.value, categoryIds: [] }
  }

  function startGame() {
    if (!puzzleIndex.value) return
    const count = Math.max(1, Number(settings.value.count) || DEFAULT_ROUND_COUNT)
    const chosen = selectRounds(puzzleIndex.value, { ...settings.value, count, seed: seed.value })
    rounds.value = chosen.map((puzzle) => ({ puzzle, guess: null, result: null }))
    currentIndex.value = 0
    phase.value = rounds.value.length ? 'playing' : 'setup'
  }

  function reroll() {
    seed.value = createSeed()
    startGame()
  }

  function placeGuess(point) {
    if (phase.value !== 'playing' || !currentRound.value) return
    currentRound.value.guess = { x: Number(point.x), y: Number(point.y) }
  }

  function confirmGuess() {
    const round = currentRound.value
    if (phase.value !== 'playing' || !round?.guess || !geometry.value) return
    round.result = evaluateRound({
      answer: round.puzzle,
      guess: round.guess,
      geometry: geometry.value,
    })
    phase.value = 'revealed'
  }

  function finishGame() {
    phase.value = 'finished'
    const finished = {
      id: `session-${Date.now()}`,
      playedAt: new Date().toISOString(),
      rounds: rounds.value.length,
      totalPoints: summary.value.totalPoints,
      maxPoints: summary.value.maxPoints,
      averageDistancePixels: summary.value.averageDistancePixels,
    }
    if (finished.rounds > 0) {
      history.value = [finished, ...history.value].slice(0, 20)
      persistHistory(history.value)
    }
  }

  function nextRound() {
    if (phase.value !== 'revealed') return
    if (isLastRound.value) {
      finishGame()
      return
    }
    currentIndex.value += 1
    phase.value = 'playing'
  }

  function resetToSetup() {
    phase.value = 'setup'
    rounds.value = []
    currentIndex.value = 0
    seed.value = createSeed()
  }

  return {
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
    maxRoundPoints: ROUND_MAX_POINTS,
    toggleCategory,
    setCategoryGroup,
    clearSettings,
    startGame,
    reroll,
    placeGuess,
    confirmGuess,
    nextRound,
    finishGame,
    resetToSetup,
  }
}
