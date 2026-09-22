<script setup>
// 题库列表：搜索（q）+ 来源筛选 + 分类筛选 + 分页，走 GET /api/admin/questions。
//
// 分类选项由 /api/admin/questions/category-options 提供（按当前来源统计），
// 所以下拉里只会出现这个来源下真的有题的分类。
//
// 列表项直接给「编辑 / 删除」，删除会经过二次确认（在 MapWorkspace 里统一走确认弹层）。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { formatDateTimeShort, resolveImageUrl } from '@nte-geoguess/shared'
import { ASSET_BASE } from '../api'
import { SOURCE_OPTIONS } from '../composables/useQuestionList'

const props = defineProps({
  items: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  loaded: { type: Boolean, default: false },
  query: { type: String, default: '' },
  source: { type: String, default: 'all' },
  category: { type: String, default: '' },
  categoryOptions: { type: Array, default: () => [] },
  optionsLoading: { type: Boolean, default: false },
  rangeLabel: { type: String, default: '' },
  page: { type: Number, default: 1 },
  pageCount: { type: Number, default: 1 },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  // index.categoriesById，用于把 types[0] 翻成中文标签
  categoriesById: { type: Map, default: () => new Map() },
  editingId: { type: String, default: '' },
})

const emit = defineEmits([
  'search', 'filter', 'filter-category', 'prev', 'next', 'refresh', 'edit', 'remove', 'focus',
])

const searchText = ref(props.query)
let debounceTimer = null

// 父级重置搜索（例如切换来源）时同步输入框，避免两边显示不一致
watch(() => props.query, (value) => {
  if (value !== searchText.value) searchText.value = value
})

// 搜索防抖：后台搜的是名称/id，逐字敲不必每个字符都打一次接口
function handleSearchInput() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => emit('search', searchText.value), 300)
}

onBeforeUnmount(() => clearTimeout(debounceTimer))

const sourceOptions = SOURCE_OPTIONS

// 分类下拉按 group 分组（区域 / 资源 / 怪物…），并带上该分类的题数
const groupedCategoryOptions = computed(() => {
  const groups = new Map()
  for (const option of props.categoryOptions) {
    const key = option.group || '其他'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(option)
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
})

const categoryTotal = computed(() => (
  props.categoryOptions.reduce((sum, option) => sum + (option.count || 0), 0)
))

function imageOf(item) {
  return item.images?.length ? resolveImageUrl(item.images[0], ASSET_BASE) : null
}

function categoryLabel(item) {
  const id = item.types?.[0]
  if (!id) return '未分类'
  return props.categoriesById.get(id)?.label || id
}

function sourceLabel(item) {
  return item.source === 'question-bank' ? '后台题库' : '内置点位'
}

const isEmpty = computed(() => props.loaded && !props.loading && props.items.length === 0)

const hasFilter = computed(() => Boolean(props.query.trim() || props.category || props.source !== 'all'))
</script>

<template>
  <div class="panel-scroll">
    <section class="panel-block">
      <header class="panel-block__head">
        <h2>题库列表</h2>
        <button type="button" class="link-button" :disabled="loading" @click="emit('refresh')">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </header>

      <div class="field-row">
        <label class="field">
          <span>搜索（名称 / ID）</span>
          <input
            v-model="searchText"
            type="search"
            placeholder="输入关键字后自动搜索"
            data-testid="list-search"
            @input="handleSearchInput"
          />
        </label>
        <label class="field">
          <span>来源</span>
          <select
            :value="source"
            data-testid="list-source"
            @change="emit('filter', $event.target.value)"
          >
            <option v-for="option in sourceOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
      </div>

      <label class="field">
        <span>
          分类筛选
          <small v-if="optionsLoading">（加载中…）</small>
        </span>
        <select
          :value="category"
          data-testid="list-category"
          :disabled="optionsLoading"
          @change="emit('filter-category', $event.target.value)"
        >
          <option value="">全部分类（{{ categoryTotal }} 题）</option>
          <optgroup
            v-for="entry in groupedCategoryOptions"
            :key="entry.group"
            :label="entry.group"
          >
            <option v-for="option in entry.items" :key="option.id" :value="option.id">
              {{ option.label }}（{{ option.count }}）
            </option>
          </optgroup>
        </select>
      </label>

      <div class="list-filter-status">
        <p class="panel-note panel-note--tight">{{ rangeLabel }}</p>
        <button
          v-if="hasFilter"
          type="button"
          class="link-button"
          data-testid="list-reset"
          @click="emit('search', ''); emit('filter', 'all'); emit('filter-category', '')"
        >
          清除筛选
        </button>
      </div>
    </section>

    <section class="panel-block">
      <p v-if="loading && !items.length" class="panel-note">正在加载题库…</p>
      <p v-else-if="isEmpty" class="panel-note">
        <template v-if="category">
          这个分类下没有符合条件的题目。换个分类，或点上面的「清除筛选」。
        </template>
        <template v-else>
          没有符合条件的题目。换个关键字，或把来源切成「全部」试试。
        </template>
      </p>

      <ul v-else class="question-list" data-testid="question-list">
        <li
          v-for="item in items"
          :key="item.id"
          class="question-card"
          :class="{ 'is-editing': item.id === editingId }"
          data-testid="question-item"
        >
          <img v-if="imageOf(item)" class="question-card__thumb" :src="imageOf(item)" alt="" />
          <div v-else class="question-card__thumb question-card__thumb--empty">无图</div>

          <div class="question-card__body">
            <strong class="question-card__name">{{ item.name || item.id }}</strong>
            <small class="question-card__id">{{ item.id }}</small>
            <div class="question-card__meta">
              <span>{{ categoryLabel(item) }}</span>
              <span>{{ Math.round(item.x) }}, {{ Math.round(item.y) }}</span>
            </div>
            <div class="question-card__meta">
              <span :class="['badge', item.source === 'question-bank' ? 'badge--own' : 'badge--seed']">
                {{ sourceLabel(item) }}
              </span>
              <span>{{ formatDateTimeShort(item.createdAt) }}</span>
            </div>
          </div>

          <div class="question-card__actions">
            <button type="button" data-testid="question-edit" @click="emit('edit', item)">编辑</button>
            <button type="button" title="定位到该点" @click="emit('focus', item)">定位</button>
            <button
              type="button"
              class="is-danger"
              data-testid="question-delete"
              @click="emit('remove', item)"
            >
              删除
            </button>
          </div>
        </li>
      </ul>

      <div v-if="items.length" class="pager">
        <button type="button" :disabled="!hasPrev || loading" @click="emit('prev')">上一页</button>
        <span>{{ page }} / {{ pageCount }}</span>
        <button type="button" :disabled="!hasNext || loading" @click="emit('next')">下一页</button>
      </div>
    </section>
  </div>
</template>
