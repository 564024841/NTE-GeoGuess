// 分类管理：GET / POST / DELETE /api/admin/categories。
//
// 契约要点：
//   · 列表项带 count（引用该分类的点位数），删除前据此提示影响面
//   · 删除分类不会连带删点位，引用它的点位会被改到 question-bank 兜底分类
import { ref } from 'vue'
import { api, describeApiError } from '../api'
import { useNotices } from './useNotices'

export function useCategories() {
  const notices = useNotices()

  const items = ref([])
  const loading = ref(false)
  const loaded = ref(false)
  const creating = ref(false)
  const removingId = ref('')

  async function load() {
    loading.value = true
    try {
      const payload = await api.listCategories()
      items.value = Array.isArray(payload?.items) ? payload.items : []
      loaded.value = true
      return true
    } catch (error) {
      items.value = []
      loaded.value = true
      notices.error(`加载分类失败：${describeApiError(error)}`)
      return false
    } finally {
      loading.value = false
    }
  }

  async function create(payload) {
    creating.value = true
    try {
      const created = await api.createCategory(payload)
      notices.ok(`已新建分类：${created?.label || payload.label || payload.id}`)
      await load()
      return created || payload
    } catch (error) {
      notices.error(`新建分类失败：${describeApiError(error)}`)
      return null
    } finally {
      creating.value = false
    }
  }

  async function remove(id) {
    removingId.value = id
    try {
      await api.deleteCategory(id)
      notices.ok('分类已删除，原本引用它的点位已改到兜底分类。')
      await load()
      return true
    } catch (error) {
      notices.error(`删除分类失败：${describeApiError(error)}`)
      return false
    } finally {
      removingId.value = ''
    }
  }

  return { items, loading, loaded, creating, removingId, load, create, remove }
}
