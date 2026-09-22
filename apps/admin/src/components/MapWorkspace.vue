<script setup>
// 后台工作台：左边地图、右边操作面板、上面顶栏。
//
// 三块功能共用一个地图实例：
//   · 新建题目 / 编辑题目 —— 地图点选答案位置
//   · 题库列表 —— 「定位」把地图移到该题坐标
//   · 分类管理 —— 不碰地图
//
// 地图实例只在几何数据就绪后创建（父级 App 负责 gate），
// 所以这里可以安全地假设 props.geometry 已经是 createGeometry 的返回值。
import { computed, onMounted, ref } from 'vue'
import { api, describeApiError, DEFAULT_TIMEOUT_MS } from '../api'
import { useConfirm } from '../composables/useConfirm'
import { useCategories } from '../composables/useCategories'
import { useMap } from '../composables/useMap'
import { useNotices } from '../composables/useNotices'
import { useQuestionEditor } from '../composables/useQuestionEditor'
import { useQuestionList } from '../composables/useQuestionList'
import { createRegionResolver, regionLabelPoints as regionLabelPointsFor } from '../utils/region'
import MapHud from './MapHud.vue'
import QuestionEditorPanel from './QuestionEditorPanel.vue'
import QuestionListPanel from './QuestionListPanel.vue'
import CategoryPanel from './CategoryPanel.vue'

const props = defineProps({
  geometry: { type: Object, required: true },
  // 区域落点（来自 bootstrap；薄暮区靠它补上，因为它没有参考点）
  regionPositions: { type: Array, default: () => [] },
  mapConfig: { type: Object, required: true },
  index: { type: Object, required: true },
  categories: { type: Array, default: () => [] },
  stats: { type: Object, default: null },
  expiresAt: { type: String, default: '' },
})

const emit = defineEmits(['logout', 'category-created'])

const notices = useNotices()
const { ask } = useConfirm()

const tab = ref('editor')

// 游戏坐标 → 标定像素 → 区域。判据是 400 个带真实区域名的参考点做 kNN 投票
// （见 shared/regionClassify 与 utils/region 的说明）。
const regionResolver = createRegionResolver(props.geometry)
const toPixel = (point) => props.geometry.gameToMapPixel(point)
const regionOf = (point, location = null) => (point ? regionResolver(point, location) : null)

// 地图上的区域名标记：6 个城区的落点由参考点重心算出，
// 薄暮区没有参考点（它是「覆盖之外」的兜底区域），用数据文件里的落点补上
const regionLabelPoints = computed(() => regionLabelPointsFor(props.geometry, props.regionPositions || []))
const showRegionLabels = ref(true)

const categoriesRef = computed(() => props.categories)

const editor = useQuestionEditor({
  categories: categoriesRef,
  regionResolver: regionOf,
  onChanged: handleQuestionsChanged,
})

const {
  draft,
  pending,
  lastSubmit,
  status: editorStatus,
  submitting,
  categoryOptions,
  draftReady,
  draftMissing,
  setImage,
  clearImage,
  setPoint,
  savePending,
  removePending,
  clearPending,
  submitBatch,
  startEdit,
  cancelEdit,
  saveEdit,
  syncDefaultCategory,
  autoCategory,
  autoCategoryApplied,
} = editor

const list = useQuestionList()
const {
  items: listItems,
  loading: listLoading,
  loaded: listLoaded,
  query: listQuery,
  source: listSource,
  category: listCategory,
  categoryOptions: listCategoryOptions,
  optionsLoading: listOptionsLoading,
  page: listPage,
  pageCount: listPageCount,
  hasPrev: listHasPrev,
  hasNext: listHasNext,
  rangeLabel: listRangeLabel,
  load: loadList,
  loadCategoryOptions: loadListCategoryOptions,
  setQuery: setListQuery,
  setSource: setListSource,
  setCategory: setListCategory,
  goPage: goListPage,
  reloadFirstPage: reloadListFirstPage,
} = list

const categoriesState = useCategories()
const { items: categoryItems, loading: categoryLoading, loaded: categoryLoaded, creating: categoryCreating, removingId: categoryRemovingId } = categoriesState

const categoriesById = computed(() => props.index.categoriesById || new Map())

const pinPoint = computed(() => draft.point)

const { mapElement, zoom, cursors, focusPoint, shiftZoom, resetView } = useMap({
  geometry: props.geometry,
  mapConfig: props.mapConfig,
  pinPoint,
  regionPoints: regionLabelPoints,
  showRegionLabels,
  onMapClick: handleMapClick,
})

// 手动改了分类：撤销「已按区域自动选择」的标记，免得界面还宣称是自动选的
function handleCategoryChanged() {
  autoCategoryApplied.value = false
}

function handleMapClick(point) {
  // 只有出题/改题时才把点击当作答案位置；其它页面点地图不该悄悄改草稿
  if (tab.value !== 'editor') {
    notices.info('点击地图设定答案位置需要先切到「新建题目」。')
    return
  }
  setPoint(point)
}

async function handleQuestionsChanged() {
  // 入库/改题后列表与分类计数都会变，就地刷新，避免用户手动点刷新
  await Promise.all([reloadListFirstPage(), categoriesState.load()])
}

function handleFocus(point) {
  if (point) focusPoint(point, 1)
}

function handleEdit(item) {
  startEdit(item)
  tab.value = 'editor'
  if (Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y))) {
    focusPoint({ x: Number(item.x), y: Number(item.y) }, 1)
  }
}

async function handleRemove(item) {
  const confirmed = await ask({
    title: `删除题目「${item.name || item.id}」？`,
    message: '删除后无法恢复，仅被这道题引用的截图也会一起清理。',
    detail: item.id,
    confirmLabel: '删除题目',
  })
  if (!confirmed) return

  try {
    await api.deleteQuestion(item.id)
    notices.ok(`已删除：${item.name || item.id}`)
    // 正在编辑的就是被删掉的那题时，退出编辑态，避免对着不存在的 id 提交
    if (draft.mode === 'edit' && draft.id === item.id) cancelEdit()
    await handleQuestionsChanged()
  } catch (error) {
    notices.error(`删除失败：${describeApiError(error)}`)
  }
}

async function handleCreateCategory(payload) {
  return categoriesState.create(payload)
}

async function handleCategoryCreated(category) {
  // 让出题面板的分类下拉立刻能选到新分类，不必重新拉 bootstrap
  emit('category-created', category)
}

onMounted(async () => {
  syncDefaultCategory()

  // 开发期调试出口：自动化自查脚本用它定位地图、读取当前状态。
  // 必须放在任何 await 之前安装——接口挂住时也应该能读到状态，否则排查时反而瞎了。
  if (import.meta.env.DEV) {
    window.__NTE_ADMIN__ = {
      focusPoint,
      resetView,
      shiftZoom,
      setTab: (value) => { tab.value = value },
      getTab: () => tab.value,
      getDraft: () => JSON.parse(JSON.stringify(draft)),
      getPending: () => pending.value.map((item) => ({ ...item, point: { ...item.point } })),
      getList: () => list.items.value.map((item) => ({ id: item.id, name: item.name, x: item.x, y: item.y })),
      getListTotal: () => list.total.value,
      getCategories: () => categoryItems.value.map((item) => ({ id: item.id, label: item.label, count: item.count })),
      regionOf,
      toPixel,
      // 本次运行生效的请求超时，自查脚本据此决定等多久（见 scripts/selfcheck.mjs）
      apiTimeoutMs: DEFAULT_TIMEOUT_MS,
    }
  }

  // 列表、分类选项、分类管理各自独立拉取，互不阻塞（某一边失败不影响另一边渲染）
  await Promise.all([loadListCategoryOptions(), loadList(), categoriesState.load()])
})

const pendingCount = computed(() => pending.value.length)
const questionTotalLabel = computed(() => {
  const stats = props.stats
  if (!stats) return '—'
  return Number(stats.questionBank) || 0
})
</script>

<template>
  <div class="app-shell">
    <div ref="mapElement" class="map-canvas" />

    <header class="topbar glass-panel">
      <div class="brand">
        <span class="brand__mark">图寻</span>
        <div class="brand__text">
          <strong>题库后台</strong>
          <small>截图 + 坐标 = 一道题</small>
        </div>
      </div>

      <nav class="view-tabs">
        <button
          type="button"
          :class="{ 'is-active': tab === 'editor' }"
          data-testid="tab-editor"
          @click="tab = 'editor'"
        >
          新建题目
          <b v-if="pendingCount">{{ pendingCount }}</b>
        </button>
        <button
          type="button"
          :class="{ 'is-active': tab === 'list' }"
          data-testid="tab-list"
          @click="tab = 'list'"
        >
          题库列表
        </button>
        <button
          type="button"
          :class="{ 'is-active': tab === 'categories' }"
          data-testid="tab-categories"
          @click="tab = 'categories'"
        >
          分类管理
        </button>
      </nav>

      <div class="topbar__stats">
        <div class="stat">
          <span>后台题库</span>
          <strong>{{ questionTotalLabel }}</strong>
        </div>
        <div class="stat">
          <span>视角</span>
          <strong>{{ zoom }}</strong>
        </div>
        <button
          type="button"
          class="ghost-button ghost-button--compact"
          data-testid="logout"
          @click="emit('logout')"
        >
          退出登录
        </button>
      </div>
    </header>

    <MapHud
      :cursors="cursors"
      @zoom-in="shiftZoom(1)"
      @zoom-out="shiftZoom(-1)"
      @reset-view="resetView"
    />

    <aside class="sidebar glass-panel sidebar--admin">
      <QuestionEditorPanel
        v-if="tab === 'editor'"
        :draft="draft"
        :pending="pending"
        :last-submit="lastSubmit"
        :status="editorStatus"
        :submitting="submitting"
        :draft-ready="draftReady"
        :draft-missing="draftMissing"
        :category-options="categoryOptions"
        :auto-category="autoCategory"
        :auto-category-applied="autoCategoryApplied"
        :show-region-labels="showRegionLabels"
        :to-pixel="toPixel"
        :region-of="regionOf"
        @upload="setImage"
        @clear-image="clearImage"
        @save="savePending"
        @save-edit="saveEdit"
        @cancel-edit="cancelEdit"
        @remove="removePending"
        @clear-pending="clearPending"
        @submit="submitBatch"
        @focus="handleFocus"
        @category-changed="handleCategoryChanged"
        @toggle-region-labels="(value) => (showRegionLabels = value)"
      />

      <QuestionListPanel
        v-else-if="tab === 'list'"
        :items="listItems"
        :loading="listLoading"
        :loaded="listLoaded"
        :query="listQuery"
        :source="listSource"
        :category="listCategory"
        :category-options="listCategoryOptions"
        :options-loading="listOptionsLoading"
        :range-label="listRangeLabel"
        :page="listPage"
        :page-count="listPageCount"
        :has-prev="listHasPrev"
        :has-next="listHasNext"
        :categories-by-id="categoriesById"
        :editing-id="draft.mode === 'edit' ? draft.id : ''"
        @search="setListQuery"
        @filter="setListSource"
        @filter-category="setListCategory"
        @prev="goListPage(-1)"
        @next="goListPage(1)"
        @refresh="loadList"
        @edit="handleEdit"
        @remove="handleRemove"
        @focus="handleFocus"
      />

      <CategoryPanel
        v-else
        :items="categoryItems"
        :loading="categoryLoading"
        :loaded="categoryLoaded"
        :creating="categoryCreating"
        :removing-id="categoryRemovingId"
        :create-category="handleCreateCategory"
        :delete-category="categoriesState.remove"
        @created="handleCategoryCreated"
        @refresh="categoriesState.load"
      />
    </aside>
  </div>
</template>
