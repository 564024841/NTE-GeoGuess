// 出题流程的状态与动作。
//
// 流程（与游戏站的题库编辑页一致，只是落库换成线上接口）：
//   上传截图 → 在地图上点选答案 → 保存到待提交清单 → 可连续加多题 → 一次性 POST /questions/batch
//   编辑已有题目时：载入题目 → 改文字 / 换截图 / 重新点选坐标 → PUT /questions/:id
//
// 与游戏站的差别：
//   · 截图不再自己算路径，而是以 dataUrl 交给服务端落盘，服务端返回最终路径
//   · 题目 id 由服务端分配，本地只用一个临时 key 维护清单（v-for 与删除用）
import { computed, reactive, ref } from 'vue'
import {
  MAX_QUESTION_IMAGE_BYTES,
  createQuestionId,
  isSupportedImageType,
} from '@nte-geoguess/shared'
import { api, describeApiError, readFileAsDataUrl } from '../api'

// 分类为空时（例如分类表还没初始化）用它兜底，与服务端的兜底分类同名
const FALLBACK_CATEGORY_ID = 'question-bank'
const MAX_NAME_LENGTH = 60
const MAX_DISTRICT_LENGTH = 20
const MAX_DESCRIPTION_LENGTH = 120

function emptyDraft() {
  return {
    mode: 'create', // create | edit
    id: null, // edit 模式下的题目 id
    key: null, // 本地临时 key，只用于待提交清单
    name: '',
    categoryId: '',
    district: '',
    description: '',
    imageDataUrl: null, // 本次新选的截图
    imageMimeType: null,
    imageName: '',
    existingImages: [], // 编辑时服务端已有的截图路径
    point: null, // 游戏真实坐标 { x, y }
    // 按落点自动分类的结果（展示用）：{ label, confidence, nearestDistance, outside, source }
    autoRegion: null,
  }
}

function roundCoord(value) {
  return Number(Number(value).toFixed(3))
}

export function useQuestionEditor({ categories, regionInference, onChanged }) {
  const draft = reactive(emptyDraft())
  const pending = ref([])
  // 最近一次批量提交的持久记录：pending 清空后仍能看到「刚才入库了什么、哪几题失败」
  const lastSubmit = ref(null)
  const status = reactive({ kind: 'idle', message: '' })
  const submitting = ref(false)

  const categoryOptions = computed(() => {
    const list = categories.value || []
    if (list.length) return list
    return [{ id: FALLBACK_CATEGORY_ID, group: '兜底', label: '题库兜底分类' }]
  })

  const hasImage = computed(() => Boolean(draft.imageDataUrl) || draft.existingImages.length > 0)

  const draftReady = computed(() => hasImage.value && Boolean(draft.point))

  const draftMissing = computed(() => {
    const missing = []
    if (!hasImage.value) missing.push('截图')
    if (!draft.point) missing.push('地图位置')
    return missing
  })

  // 落点对应的区域推断结果。draft.autoRegion 是点选时算好的那一份，
  // 这里优先读它（编辑已有题目时 point 是从服务端带回来的，还没点过地图，就现算一次）。
  const draftRegion = computed(() => (
    draft.autoRegion || (draft.point && regionInference ? regionInference.infer(draft.point) : null)
  ))

  function setStatus(kind, message) {
    status.kind = kind
    status.message = message || ''
  }

  function resetDraft() {
    Object.assign(draft, emptyDraft())
  }

  // 新题默认选第一个分类，省掉一次必填的下拉操作
  function syncDefaultCategory() {
    if (draft.categoryId) return
    draft.categoryId = categoryOptions.value[0]?.id || FALLBACK_CATEGORY_ID
  }

  async function setImage(file) {
    if (!file) return false

    // 不信任文件名后缀，MIME 不在白名单就直接拒绝（契约里的 5 种图片类型）
    if (!isSupportedImageType(file.type)) {
      setStatus('error', `不支持的图片格式：${file.type || '未知'}（支持 PNG / JPEG / WebP / GIF / AVIF）`)
      return false
    }
    if (file.size > MAX_QUESTION_IMAGE_BYTES) {
      const size = (file.size / 1024 / 1024).toFixed(1)
      setStatus('error', `图片过大：${size} MB，单张上限 8 MB`)
      return false
    }

    try {
      draft.imageDataUrl = await readFileAsDataUrl(file)
      draft.imageMimeType = file.type
      draft.imageName = file.name
      setStatus('ok', `已选择截图：${file.name}`)
      return true
    } catch (error) {
      setStatus('error', describeApiError(error))
      return false
    }
  }

  function clearImage() {
    draft.imageDataUrl = null
    draft.imageMimeType = null
    draft.imageName = ''
    draft.existingImages = []
    setStatus('idle', '已移除截图。')
  }

  function setPoint(point) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return
    draft.point = { x: Number(point.x), y: Number(point.y) }
    autoClassify()
  }

  // 按答案落点自动定区域：填「区域」文本框，并把分类切到对应的区域分类
  // （用户之后可以手动改，改完只要不再点地图就不会被覆盖）。
  function autoClassify() {
    if (!draft.point || !regionInference) {
      syncDefaultCategory()
      return
    }

    const inferred = regionInference.infer(draft.point)
    if (!inferred) {
      syncDefaultCategory()
      return
    }

    draft.autoRegion = inferred
    draft.district = inferred.label

    // 区域名 → 分类 id：分类表里的区域分类标签与区域名同名（米格尔区 / 薄暮区 …）
    const match = categoryOptions.value.find((category) => category.label === inferred.label)
    if (match) draft.categoryId = match.id
    else syncDefaultCategory()
  }

  // 草稿 → 契约里的题目请求体。
  // 编辑已有题目时，没换截图就把原路径原样传回去（契约：images 是整体替换，带 path 的保留）。
  function buildPayload(item, position) {
    const point = item.point
    const categoryId = item.categoryId || FALLBACK_CATEGORY_ID
    const district = (item.district || '').trim().slice(0, MAX_DISTRICT_LENGTH)
    const images = item.imageDataUrl
      ? [{ mimeType: item.imageMimeType, dataUrl: item.imageDataUrl }]
      : (item.existingImages || []).map((path) => ({ path }))

    return {
      name: (item.name || '').trim().slice(0, MAX_NAME_LENGTH) || `自建题目 #${position}`,
      types: categoryId ? [categoryId] : [],
      district,
      description: (item.description || '').trim().slice(0, MAX_DESCRIPTION_LENGTH),
      // tags 与游戏站编辑页保持一致：分类 + 区域
      tags: [categoryId, district].filter(Boolean),
      x: roundCoord(point.x),
      y: roundCoord(point.y),
      images,
    }
  }

  function snapshotDraft() {
    return {
      key: createQuestionId(),
      name: draft.name,
      categoryId: draft.categoryId,
      district: draft.district,
      description: draft.description,
      imageDataUrl: draft.imageDataUrl,
      imageMimeType: draft.imageMimeType,
      imageName: draft.imageName,
      existingImages: [...draft.existingImages],
      point: draft.point ? { ...draft.point } : null,
    }
  }

  function savePending() {
    if (!draftReady.value) {
      setStatus('error', `还缺：${draftMissing.value.join('、')}`)
      return null
    }

    const saved = snapshotDraft()
    pending.value = [...pending.value, saved]
    resetDraft()
    syncDefaultCategory()
    setStatus('ok', `已保存到待提交清单，共 ${pending.value.length} 题。可以继续添加下一题。`)
    return saved
  }

  function removePending(key) {
    pending.value = pending.value.filter((item) => item.key !== key)
    setStatus('idle', `已从清单移除 1 题，剩余 ${pending.value.length} 题。`)
  }

  function clearPending() {
    pending.value = []
    setStatus('idle', '已清空待提交清单。')
  }

  async function submitBatch() {
    if (!pending.value.length) {
      setStatus('error', '待提交清单是空的，先保存至少 1 题。')
      return null
    }

    submitting.value = true
    setStatus('idle', '正在提交…')

    const batch = pending.value.map((item, index) => ({
      name: (item.name || '').trim() || `自建题目 #${index + 1}`,
      ...buildPayload(item, index + 1),
    }))

    try {
      const result = await api.batchCreateQuestions(batch)
      // 契约：批量提交 HTTP 始终 200，成功与失败都在 body 里
      const created = Number(result?.created) || 0
      const failed = Number(result?.failed) || 0
      const problems = Array.isArray(result?.problems) ? result.problems : []

      lastSubmit.value = {
        at: new Date().toISOString(),
        created,
        failed,
        problems,
        items: Array.isArray(result?.items) ? result.items : [],
        names: batch.map((item) => item.name),
      }

      if (created) {
        pending.value = []
        resetDraft()
        syncDefaultCategory()
      }

      if (failed) setStatus('error', `提交完成：成功 ${created} 题，失败 ${failed} 题。`)
      else setStatus('ok', `已入库 ${created} 题。`)

      await onChanged?.()
      return result
    } catch (error) {
      setStatus('error', `提交失败：${describeApiError(error)}`)
      return null
    } finally {
      submitting.value = false
    }
  }

  // ---------- 编辑已有题目 ----------

  function startEdit(item) {
    if (!item) return
    Object.assign(draft, emptyDraft(), {
      mode: 'edit',
      id: item.id,
      name: item.name || '',
      categoryId: item.types?.[0] || categoryOptions.value[0]?.id || FALLBACK_CATEGORY_ID,
      district: item.district || '',
      description: item.description || '',
      existingImages: Array.isArray(item.images) ? [...item.images] : [],
      point: Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y))
        ? { x: Number(item.x), y: Number(item.y) }
        : null,
    })
    // 已有题目的区域以库里存的为准，但把「按坐标推断的结果」也算出来，
    // 面板上会显示它，方便发现「这题的归属和坐标对不上」
    if (draft.point && regionInference) draft.autoRegion = regionInference.infer(draft.point)
    setStatus('idle', `正在编辑：${item.name || item.id}`)
  }

  function cancelEdit() {
    resetDraft()
    setStatus('idle', '已取消编辑。')
  }

  async function saveEdit() {
    if (draft.mode !== 'edit' || !draft.id) return null
    if (!draftReady.value) {
      setStatus('error', `还缺：${draftMissing.value.join('、')}`)
      return null
    }

    submitting.value = true
    setStatus('idle', '正在保存修改…')
    try {
      const payload = buildPayload(draft, 1)
      const updated = await api.updateQuestion(draft.id, payload)
      setStatus('ok', `已保存修改：${payload.name}`)
      resetDraft()
      await onChanged?.()
      return updated
    } catch (error) {
      setStatus('error', `保存失败：${describeApiError(error)}`)
      return null
    } finally {
      submitting.value = false
    }
  }

  return {
    draft,
    pending,
    lastSubmit,
    status,
    submitting,
    categoryOptions,
    hasImage,
    draftReady,
    draftMissing,
    draftRegion,
    setImage,
    clearImage,
    setPoint,
    autoClassify,
    syncDefaultCategory,
    savePending,
    removePending,
    clearPending,
    submitBatch,
    startEdit,
    cancelEdit,
    saveEdit,
    resetDraft,
    setStatus,
  }
}
