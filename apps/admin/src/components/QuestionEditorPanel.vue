<script setup>
// 出题 / 改题面板。
//
// 布局与交互沿用游戏站的 QuestionBankEditor（步骤引导 → 截图 → 答案位置 → 题目信息 →
// 待提交清单 → 提交结果记录），差别是这里的每一步都打到线上接口。
//
// 注意「地图上点选答案」始终只有当前这一题的点位会显示在地图上：
// 地图本身不画任何题库点位，避免后台自己先把答案看光了。
import { computed, ref } from 'vue'
import { resolveImageUrl } from '@nte-geoguess/shared'
import { ASSET_BASE } from '../api'

const props = defineProps({
  draft: { type: Object, required: true },
  pending: { type: Array, required: true },
  lastSubmit: { type: Object, default: null },
  status: { type: Object, required: true },
  submitting: { type: Boolean, default: false },
  draftReady: { type: Boolean, default: false },
  draftMissing: { type: Array, default: () => [] },
  categoryOptions: { type: Array, default: () => [] },
  // 落点后按区域自动判定的结果；null = 还没落点或判不出来
  autoCategory: { type: Object, default: null },
  // 当前分类是不是「自动选上的」（用户没手动改过）
  autoCategoryApplied: { type: Boolean, default: false },
  // 地图上的区域名标记开关
  showRegionLabels: { type: Boolean, default: true },
  // 由工作台注入：游戏坐标 → 标定像素 / 参考区域（都来自 shared 的 geometry 与题库索引）
  toPixel: { type: Function, required: true },
  regionOf: { type: Function, required: true },
})

const emit = defineEmits([
  'upload',
  'clear-image',
  'save',
  'save-edit',
  'cancel-edit',
  'remove',
  'clear-pending',
  'submit',
  'focus',
  'category-changed',
  'toggle-region-labels',
])

const fileInput = ref(null)
const dragging = ref(false)

const isEditing = computed(() => props.draft.mode === 'edit')

const previewUrl = computed(() => {
  if (props.draft.imageDataUrl) return props.draft.imageDataUrl
  const existing = props.draft.existingImages[0]
  return existing ? resolveImageUrl(existing, ASSET_BASE) : null
})

const draftPixel = computed(() => (props.draft.point ? props.toPixel(props.draft.point) : null))
const draftRegion = computed(() => (props.draft.point ? props.regionOf(props.draft.point) : null))

// 清单里每题的展示信息：序号、底图像素、参考区域都由这里补齐，模板保持干净
const pendingWithMeta = computed(() => props.pending.map((item, index) => ({
  ...item,
  position: index + 1,
  pixel: props.toPixel(item.point),
  region: props.regionOf(item.point),
})))

function emitUpload(file) {
  if (file) emit('upload', file)
}

function handleFileInput(event) {
  emitUpload(event.target.files?.[0])
  // 清空 input，保证同一张图再次选择也能触发 change
  event.target.value = ''
}

function handleDrop(event) {
  dragging.value = false
  emitUpload(event.dataTransfer?.files?.[0])
}

function openFilePicker() {
  fileInput.value?.click()
}

// 参考区域 = 用 400 个带真实区域名的参考点做 kNN 判出来的区域（见 shared/regionClassify）。
// 这是「推断」不是「权威」，所以：置信度低时标出来、落在参考点覆盖之外时说明原因，
// 并把距离一起给出去，让人能自己判断要不要改。
function regionText(region) {
  if (!region) return '—'
  if (region.reason === 'declared') return `${region.label}（已标注）`
  if (region.outsideCoverage) return `${region.label}（覆盖之外）`
  if (region.confidence < 0.6) return `${region.label}（交界，待复核）`
  return region.label
}

function regionTitle(region) {
  if (!region) return '先在地图上点选答案位置'
  const distance = `${region.nearestDistance} 标定像素`
  const base = `按 400 个带区域名的参考点做 kNN 投票，落点判为「${region.label}」：`
  if (region.reason === 'declared') return '该点位数据里已写明区域，直接采信。'

  const detail = region.outsideCoverage
    ? `离最近参考点 ${distance}，超出覆盖半径，说明落在参考点覆盖之外`
      + `（投票本来会给「${region.votedLabel || '?'}」），因此归入兜底区域`
    : `置信度 ${(region.confidence * 100).toFixed(0)}%，离最近参考点 ${distance}`

  return `${base}${detail}。该区域有 ${region.referenceCount} 个参考点；`
    + '留一法自检准确率 96.8%，交界处投票会分散，置信度低时建议人工确认。'
}

// 分类下拉被手动改过：撤销「已按区域自动选择」的标记，
// 免得界面还宣称是自动选的，而实际值已经被人改掉了。
function handleCategoryChange() {
  emit('category-changed')
}
</script>

<template>
  <div class="panel-scroll">
    <section class="panel-block">
      <header class="panel-block__head">
        <h2>{{ isEditing ? '编辑题目' : '新建题目' }}</h2>
        <small v-if="isEditing" class="panel-tag">{{ draft.id }}</small>
      </header>

      <ol class="steps">
        <li :class="{ 'is-done': Boolean(previewUrl), 'is-active': !previewUrl }">
          <b>1</b> 上传游戏截图
        </li>
        <li :class="{ 'is-done': Boolean(draft.point), 'is-active': Boolean(previewUrl) && !draft.point }">
          <b>2</b> 在地图上点选答案位置
        </li>
        <li :class="{ 'is-active': draftReady }">
          <b>3</b> {{ isEditing ? '保存修改' : '保存这一题，继续加下一题' }}
        </li>
        <li :class="{ 'is-active': pending.length > 0 }">
          <b>4</b> 全部加完后一次性提交入库
        </li>
      </ol>

      <p v-if="isEditing" class="warn-note">
        正在编辑已有题目：改完点「保存修改」写回服务端；点「取消编辑」放弃改动。
      </p>
    </section>

    <!-- 步骤 1：截图 -->
    <section class="panel-block">
      <header class="panel-block__head">
        <h3>截图</h3>
        <button v-if="previewUrl" type="button" class="link-button" @click="emit('clear-image')">
          移除
        </button>
      </header>

      <div
        class="drop-zone"
        :class="{ 'is-dragging': dragging, 'has-image': Boolean(previewUrl) }"
        data-testid="drop-zone"
        @click="openFilePicker"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="handleDrop"
      >
        <img v-if="previewUrl" :src="previewUrl" alt="题目截图预览" />
        <div v-else class="drop-zone__hint">
          <strong>点击选择，或把图片拖到这里</strong>
          <span>PNG / JPEG / WebP / GIF / AVIF，单张 ≤ 8 MB</span>
        </div>
      </div>

      <input
        ref="fileInput"
        class="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        data-testid="file-input"
        @change="handleFileInput"
      />

      <p v-if="draft.imageName" class="panel-note panel-note--tight">已选：{{ draft.imageName }}</p>
      <p v-else-if="isEditing && draft.existingImages.length" class="panel-note panel-note--tight">
        当前保留服务端已有截图，重新选择图片会整体替换它。
      </p>
    </section>

    <!-- 步骤 2：答案位置 -->
    <section class="panel-block">
      <header class="panel-block__head">
        <h3>答案位置</h3>
        <label class="switch switch--inline" title="区域名标记不泄露具体点位，只是区域级参照">
          <input
            type="checkbox"
            :checked="showRegionLabels"
            data-testid="toggle-region-labels"
            @change="emit('toggle-region-labels', $event.target.checked)"
          />
          <span>显示区域名</span>
        </label>
        <button
          v-if="draft.point"
          type="button"
          class="link-button"
          @click="emit('focus', draft.point)"
        >
          定位到该点
        </button>
      </header>

      <div class="answer-slot" :class="{ 'is-set': Boolean(draft.point) }" data-testid="answer-slot">
        <template v-if="draft.point">
          <div>
            <span>游戏坐标</span>
            <strong>{{ Math.round(draft.point.x) }}, {{ Math.round(draft.point.y) }}</strong>
          </div>
          <div>
            <span>底图像素</span>
            <strong>{{ Math.round(draftPixel.pixelX) }}, {{ Math.round(draftPixel.pixelY) }}</strong>
          </div>
          <div>
            <span>参考区域</span>
            <strong :title="regionTitle(draftRegion)">{{ regionText(draftRegion) }}</strong>
          </div>
        </template>
        <p v-else class="panel-note panel-note--tight">
          点击左侧地图即可设为答案位置。缩放用左下角的 − / + 按钮
          （Shift+拖拽是框选放大，会和拖拽地图冲突）。
        </p>
      </div>
      <p class="panel-note panel-note--tight">
        参考区域按 400 个带区域名的参考点做 kNN 投票判出来，并会用它自动预选下面的「分类」；
        交界处置信度会下降，可随手改。
      </p>
    </section>

    <!-- 步骤 3：题目信息 -->
    <section class="panel-block">
      <h3>题目信息</h3>

      <label class="field">
        <span>题目名称（留空自动生成）</span>
        <input
          v-model="draft.name"
          type="text"
          maxlength="60"
          placeholder="例如：绘空町 · 屋顶的猫"
          data-testid="field-name"
        />
      </label>

      <div class="field-row">
        <label class="field">
          <span>分类</span>
          <select
            v-model="draft.categoryId"
            data-testid="field-category"
            @change="handleCategoryChange"
          >
            <option v-for="category in categoryOptions" :key="category.id" :value="category.id">
              {{ category.label }}（{{ category.group || '未分组' }}）
            </option>
          </select>
        </label>

        <label class="field">
          <span>区域（可选）</span>
          <input
            v-model="draft.district"
            type="text"
            maxlength="20"
            placeholder="留空则归入自建题目"
            data-testid="field-district"
          />
        </label>
      </div>

      <!-- 落点后按区域自动选分类的结果；手动改过分类就不再宣称「自动」 -->
      <p
        v-if="autoCategory && autoCategoryApplied && autoCategory.categoryId"
        class="panel-note panel-note--tight"
        data-testid="auto-category"
      >
        已按落点自动选择「{{ autoCategory.label }}」
        <template v-if="autoCategory.needsReview">
          · <b class="warn-inline">建议复核</b>（{{
            autoCategory.outsideCoverage
              ? '落在参考点覆盖之外'
              : `交界处，置信度 ${(autoCategory.confidence * 100).toFixed(0)}%`
          }}）
        </template>
      </p>
      <p v-else-if="autoCategory && !autoCategory.categoryId" class="panel-note panel-note--tight">
        落点判为「{{ autoCategory.label }}」，但分类表里没有同名区域分类，请手动选择。
      </p>
      <p v-else-if="autoCategory" class="panel-note panel-note--tight">
        已手动指定分类（落点判为「{{ autoCategory.label }}」）。
      </p>

      <label class="field">
        <span>备注（可选）</span>
        <input
          v-model="draft.description"
          type="text"
          maxlength="120"
          placeholder="例如：线索提示"
          data-testid="field-description"
        />
      </label>

      <div class="panel-actions">
        <template v-if="isEditing">
          <button
            type="button"
            class="primary-button"
            :disabled="!draftReady || submitting"
            data-testid="save-edit"
            @click="emit('save-edit')"
          >
            {{ submitting ? '正在保存…' : '保存修改' }}
          </button>
          <button type="button" class="ghost-button" @click="emit('cancel-edit')">取消编辑</button>
        </template>
        <button
          v-else
          type="button"
          class="primary-button"
          :disabled="!draftReady"
          data-testid="save-pending"
          @click="emit('save')"
        >
          保存到待提交清单
        </button>
        <p v-if="!draftReady" class="warn-note">还缺：{{ draftMissing.join('、') }}</p>
      </div>
    </section>

    <!-- 步骤 4：待提交清单 -->
    <section class="panel-block">
      <header class="panel-block__head">
        <h3>待提交清单</h3>
        <div class="head-actions">
          <small>{{ pending.length }} 题</small>
          <button
            v-if="pending.length"
            type="button"
            class="link-button"
            @click="emit('clear-pending')"
          >
            清空
          </button>
        </div>
      </header>

      <p v-if="!pending.length" class="panel-note panel-note--tight">
        还没有保存的题目。保存后可以继续添加，最后一次性提交。
      </p>

      <ol v-else class="pending-list" data-testid="pending-list">
        <li v-for="item in pendingWithMeta" :key="item.key">
          <img :src="item.imageDataUrl" alt="" />
          <div class="pending-list__body">
            <strong>#{{ item.position }} {{ item.name || '未命名' }}</strong>
            <small>
              {{ item.region?.label || '未标区域' }} ·
              像素 {{ Math.round(item.pixel.pixelX) }}, {{ Math.round(item.pixel.pixelY) }}
            </small>
          </div>
          <div class="pending-list__actions">
            <button type="button" title="定位到该点" @click="emit('focus', item.point)">定位</button>
            <button type="button" class="is-danger" title="移除" @click="emit('remove', item.key)">删</button>
          </div>
        </li>
      </ol>
    </section>

    <!-- 提交后 pending 会清空，这里保留一份持久记录，说明刚才入库了什么、哪几题失败 -->
    <section v-if="lastSubmit" class="submit-record" data-testid="submit-record">
      <header>
        <strong>
          入库结果：成功 {{ lastSubmit.created }} 题<template v-if="lastSubmit.failed">，失败 {{ lastSubmit.failed }} 题</template>
        </strong>
        <small>{{ new Date(lastSubmit.at).toLocaleTimeString('zh-CN') }}</small>
      </header>
      <ul v-if="lastSubmit.names.length">
        <li v-for="(name, position) in lastSubmit.names" :key="position">{{ name }}</li>
      </ul>
      <div v-if="lastSubmit.problems.length" class="problem-list">
        <p
          v-for="(problem, index) in lastSubmit.problems"
          :key="index"
          class="warn-note"
        >
          失败原因{{ problem?.index !== undefined ? `（第 ${Number(problem.index) + 1} 题）` : '' }}：
          {{ problem?.message || problem?.error || '服务端未给出原因' }}
        </p>
      </div>
    </section>

    <div class="panel-actions panel-actions--sticky">
      <button
        type="button"
        class="primary-button"
        data-testid="submit-batch"
        :disabled="!pending.length || submitting"
        @click="emit('submit')"
      >
        {{ submitting ? '正在提交…' : `提交入库（${pending.length} 题）` }}
      </button>
      <p
        v-if="status.message"
        class="status-banner"
        :class="`status-banner--${status.kind}`"
        data-testid="editor-status"
      >
        {{ status.message }}
      </p>
    </div>
  </div>
</template>
