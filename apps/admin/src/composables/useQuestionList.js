// 题库列表状态：搜索（q）、来源筛选、分类筛选、分页。
//
// 来源默认是 all：内置 476 道题都在 source=map-data 里，只看 question-bank
// 会得到空列表，加再多筛选也没东西可筛。
//
// 分类选项从 /api/admin/questions/category-options 拉，并且带上当前 source，
// 所以下拉里只会出现「这个来源下真的有题」的分类，不会出现选了没结果的空选项。
import { computed, ref } from 'vue'
import { api, describeApiError } from '../api'
import { useNotices } from './useNotices'

export const SOURCE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'question-bank', label: '后台题库' },
  { value: 'map-data', label: '内置点位' },
]

export function useQuestionList() {
  const notices = useNotices()

  const items = ref([])
  const total = ref(0)
  const query = ref('')
  const source = ref('all')
  // 当前选中的分类 id（空字符串 = 不按分类筛选）
  const category = ref('')
  const categoryOptions = ref([])
  const optionsLoading = ref(false)
  const limit = ref(20)
  const offset = ref(0)
  const loading = ref(false)
  const loaded = ref(false)

  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
  const page = computed(() => Math.floor(offset.value / limit.value) + 1)
  const hasPrev = computed(() => offset.value > 0)
  const hasNext = computed(() => offset.value + limit.value < total.value)

  const activeCategory = computed(() => (
    categoryOptions.value.find((item) => item.id === category.value) || null
  ))

  const rangeLabel = computed(() => {
    const filterNote = activeCategory.value ? `，分类「${activeCategory.value.label}」` : ''
    if (!total.value) return `共 0 题${filterNote}`
    const from = offset.value + 1
    const to = Math.min(offset.value + limit.value, total.value)
    return `第 ${from}–${to} 题 / 共 ${total.value} 题${filterNote}`
  })

  async function load() {
    loading.value = true
    try {
      const payload = await api.listQuestions({
        q: query.value.trim(),
        source: source.value,
        // 契约里 category 支持逗号分隔的多选；界面目前是单选
        category: category.value,
        limit: limit.value,
        offset: offset.value,
      })
      items.value = Array.isArray(payload?.items) ? payload.items : []
      total.value = Number(payload?.total) || 0
      loaded.value = true
      return true
    } catch (error) {
      items.value = []
      total.value = 0
      loaded.value = true
      notices.error(`加载题库失败：${describeApiError(error)}`)
      return false
    } finally {
      loading.value = false
    }
  }

  // 拉分类选项。选项与 source 相关，所以切换来源时要重新拉。
  async function loadCategoryOptions() {
    optionsLoading.value = true
    try {
      const payload = await api.listQuestionCategoryOptions({ source: source.value })
      categoryOptions.value = Array.isArray(payload?.items) ? payload.items : []
      // 当前选中的分类在新来源下不存在时自动清掉，避免界面显示一个查不出结果的筛选
      if (category.value && !categoryOptions.value.some((item) => item.id === category.value)) {
        category.value = ''
      }
      return true
    } catch (error) {
      categoryOptions.value = []
      notices.error(`加载分类选项失败：${describeApiError(error)}`)
      return false
    } finally {
      optionsLoading.value = false
    }
  }

  function setQuery(value) {
    query.value = value
    offset.value = 0
    return load()
  }

  async function setSource(value) {
    source.value = value
    offset.value = 0
    // 分类选项跟着来源变，先刷新选项再查列表
    await loadCategoryOptions()
    return load()
  }

  function setCategory(value) {
    category.value = value || ''
    offset.value = 0
    return load()
  }

  function clearCategory() {
    return setCategory('')
  }

  function goPage(delta) {
    const next = offset.value + delta * limit.value
    if (next < 0) return Promise.resolve(false)
    if (next >= total.value && delta > 0) return Promise.resolve(false)
    offset.value = next
    return load()
  }

  // 新建/编辑/删除之后回到第一页重新拉，避免删除后停在空页。
  // 分类计数可能也变了，所以顺带刷新选项。
  async function reloadFirstPage() {
    offset.value = 0
    await loadCategoryOptions()
    return load()
  }

  return {
    items,
    total,
    query,
    source,
    category,
    categoryOptions,
    optionsLoading,
    limit,
    offset,
    loading,
    loaded,
    page,
    pageCount,
    hasPrev,
    hasNext,
    rangeLabel,
    load,
    loadCategoryOptions,
    setQuery,
    setSource,
    setCategory,
    clearCategory,
    goPage,
    reloadFirstPage,
  }
}
