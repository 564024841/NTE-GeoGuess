<script setup>
// 分类管理：列表 + 新建 + 删除。
//
// 删除前必须提示后果：契约里删分类不会连带删点位，
// 引用它的点位会被改到 question-bank 兜底分类——不说清楚运维不敢点。
import { reactive, ref } from 'vue'
import { resolveImageUrl } from '@nte-geoguess/shared'
import { ASSET_BASE } from '../api'
import { useConfirm } from '../composables/useConfirm'

const props = defineProps({
  items: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  loaded: { type: Boolean, default: false },
  creating: { type: Boolean, default: false },
  removingId: { type: String, default: '' },
  createCategory: { type: Function, required: true },
  deleteCategory: { type: Function, required: true },
})

const emit = defineEmits(['created', 'refresh'])

const { ask } = useConfirm()

const form = reactive({
  id: '',
  group: '自建题目',
  label: '',
  icon: '📷',
  color: '#8adfd6',
})
const formError = ref('')

// 分类 id 会进 URL 与 types 字段，限定成小写 slug，避免出现需要转义的字符
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

async function handleCreate() {
  const id = form.id.trim()
  const label = form.label.trim()

  if (!ID_PATTERN.test(id)) {
    formError.value = '分类 ID 只能用小写字母、数字和连字符，且不能以连字符开头'
    return
  }
  if (!label) {
    formError.value = '请填写分类名称'
    return
  }

  formError.value = ''
  const created = await props.createCategory({
    id,
    group: form.group.trim() || '自建题目',
    label,
    icon: form.icon.trim() || '📷',
    color: form.color,
  })

  if (created) {
    emit('created', created)
    form.id = ''
    form.label = ''
  }
}

async function handleRemove(item) {
  const affected = Number(item.count) || 0
  const confirmed = await ask({
    title: `删除分类「${item.label || item.id}」？`,
    message: affected
      ? `当前有 ${affected} 个点位引用了该分类。`
      : '当前没有点位引用该分类。',
    detail: '引用了该分类的点位会被改到 question-bank 兜底分类，点位本身不会被删除。',
    confirmLabel: '删除分类',
  })
  if (!confirmed) return
  await props.deleteCategory(item.id)
}

function iconUrlOf(item) {
  return item.iconUrl ? resolveImageUrl(item.iconUrl, ASSET_BASE) : null
}
</script>

<template>
  <div class="panel-scroll">
    <section class="panel-block">
      <header class="panel-block__head">
        <h2>分类管理</h2>
        <button type="button" class="link-button" :disabled="loading" @click="emit('refresh')">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </header>

      <p class="panel-note panel-note--tight">
        分类决定题目在游戏里的图标与配色。新建题目时若下拉里没有想要的分类，先在这里加一个。
      </p>

      <label class="field">
        <span>分类 ID（小写 slug，例如 custom-rooftop）</span>
        <input v-model="form.id" type="text" maxlength="40" placeholder="custom-cat" data-testid="category-id" />
      </label>

      <div class="field-row">
        <label class="field">
          <span>分类名称</span>
          <input v-model="form.label" type="text" maxlength="30" placeholder="自建分类" data-testid="category-label" />
        </label>
        <label class="field">
          <span>分组</span>
          <input v-model="form.group" type="text" maxlength="20" placeholder="自建题目" />
        </label>
      </div>

      <div class="field-row">
        <label class="field">
          <span>图标（emoji，可留空）</span>
          <input v-model="form.icon" type="text" maxlength="4" placeholder="📷" />
        </label>
        <label class="field">
          <span>配色</span>
          <span class="color-field">
            <input v-model="form.color" type="color" />
            <input v-model="form.color" type="text" maxlength="7" />
          </span>
        </label>
      </div>

      <p v-if="formError" class="status-banner status-banner--error" data-testid="category-error">
        {{ formError }}
      </p>

      <button
        type="button"
        class="primary-button"
        :disabled="creating"
        data-testid="category-create"
        @click="handleCreate"
      >
        {{ creating ? '正在新建…' : '新建分类' }}
      </button>
    </section>

    <section class="panel-block">
      <header class="panel-block__head">
        <h3>已有分类</h3>
        <small>{{ items.length }} 个</small>
      </header>

      <p v-if="loading && !items.length" class="panel-note">正在加载分类…</p>
      <p v-else-if="loaded && !items.length" class="panel-note">还没有任何分类。</p>

      <ul v-else class="category-list" data-testid="category-list">
        <li v-for="item in items" :key="item.id" class="category-card">
          <span class="category-card__icon" :style="{ borderColor: item.color || '#8adfd6' }">
            <img v-if="iconUrlOf(item)" :src="iconUrlOf(item)" alt="" />
            <template v-else>{{ item.icon || '📷' }}</template>
          </span>
          <div class="category-card__body">
            <strong>{{ item.label || item.id }}</strong>
            <small>{{ item.group || '未分组' }} · {{ item.id }}</small>
          </div>
          <span class="category-card__count" :title="`${item.count || 0} 个点位引用该分类`">
            {{ item.count || 0 }} 点
          </span>
          <button
            type="button"
            class="is-danger"
            :disabled="removingId === item.id"
            data-testid="category-delete"
            @click="handleRemove(item)"
          >
            {{ removingId === item.id ? '删除中…' : '删除' }}
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
