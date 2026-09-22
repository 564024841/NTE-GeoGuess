<script setup>
import { computed } from 'vue'
import { ROUND_COUNT_OPTIONS } from '../constants/mapApp'

const props = defineProps({
  categoryGroups: { type: Array, required: true },
  settings: { type: Object, required: true },
  candidateCount: { type: Number, required: true },
  puzzleTotal: { type: Number, required: true },
  locationTotal: { type: Number, required: true },
  customPuzzleCount: { type: Number, default: 0 },
  categoriesWithPuzzles: { type: Set, default: () => new Set() },
  history: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'toggle-category',
  'toggle-group',
  'clear',
  'update-count',
  'update-answer-meta',
  'update-region-labels',
  'start',
  'reroll',
])

const selectedCategories = computed(() => new Set(props.settings.categoryIds))

function groupState(items) {
  const selected = items.filter((item) => selectedCategories.value.has(item.id)).length
  return {
    all: selected === items.length && items.length > 0,
    partial: selected > 0 && selected < items.length,
  }
}

const enoughPuzzles = computed(() => props.candidateCount >= props.settings.count)

const recentBest = computed(() => {
  if (!props.history.length) return null
  return [...props.history].sort((a, b) => b.totalPoints - a.totalPoints)[0]
})
</script>

<template>
  <div class="panel-scroll">
    <section class="panel-block">
      <h2>开始一局图寻</h2>
      <p class="panel-note">
        系统给出一张游戏内截图，你需要在大地图上标出你认为的位置。
        落点离真实位置越近，得分越高。
      </p>

      <div class="data-facts">
        <div class="fact">
          <strong>{{ puzzleTotal }}</strong>
          <span>可出题截图</span>
        </div>
        <div class="fact">
          <strong>{{ locationTotal }}</strong>
          <span>底图点位</span>
        </div>
        <div class="fact">
          <strong>{{ candidateCount }}</strong>
          <span>当前筛选可出题</span>
        </div>
      </div>

      <p v-if="customPuzzleCount" class="panel-note panel-note--tight">
        其中 {{ customPuzzleCount }} 题来自自建题库（由管理后台添加）。
      </p>

      <label class="field">
        <span>题目数量</span>
        <div class="segmented">
          <button
            v-for="option in ROUND_COUNT_OPTIONS"
            :key="option"
            type="button"
            :class="{ 'is-active': settings.count === option }"
            @click="emit('update-count', option)"
          >
            {{ option }} 题
          </button>
        </div>
      </label>

      <label class="switch">
        <input
          type="checkbox"
          :checked="settings.showAnswerMeta"
          @change="emit('update-answer-meta', $event.target.checked)"
        />
        <span>结算时显示区域与目标名称</span>
      </label>

      <label class="switch">
        <input
          type="checkbox"
          :checked="settings.showRegionLabels"
          data-testid="toggle-region-labels"
          @change="emit('update-region-labels', $event.target.checked)"
        />
        <span>在地图上标注区域名（放大到 -2 及以上时出现）</span>
      </label>
    </section>

    <section class="panel-block">
      <header class="panel-block__head">
        <h3>分类筛选</h3>
        <button type="button" class="link-button" @click="emit('clear')">清空筛选</button>
      </header>
      <p class="panel-note panel-note--tight">不选则全部分类参与出题。</p>

      <div v-for="group in categoryGroups" :key="group.group" class="category-group">
        <label class="category-group__head">
          <input
            type="checkbox"
            :checked="groupState(group.items).all"
            :indeterminate.prop="groupState(group.items).partial"
            @change="emit('toggle-group', group.items, $event.target.checked)"
          />
          <strong>{{ group.group }}</strong>
          <small>{{ group.items.length }}</small>
        </label>
        <div class="chip-grid">
          <button
            v-for="category in group.items"
            :key="category.id"
            type="button"
            class="chip"
            :class="{ 'is-active': selectedCategories.has(category.id) }"
            :style="{ '--chip-color': category.color || '#8adfd6' }"
            @click="emit('toggle-category', category.id)"
          >
            <i />
            <span class="chip__label">{{ category.label }}</span>
            <b
              class="chip__count"
              :class="{ 'is-empty': !categoriesWithPuzzles.has(category.id) }"
              :title="categoriesWithPuzzles.has(category.id)
                ? `该分类有 ${category.count || 0} 个点位`
                : `该分类有 ${category.count || 0} 个点位，但目前都没有截图，出不了题`"
            >{{ category.count || 0 }}</b>
          </button>
        </div>
      </div>
    </section>

    <section v-if="history.length" class="panel-block">
      <header class="panel-block__head">
        <h3>本地战绩</h3>
        <small>{{ history.length }} 局</small>
      </header>
      <ul class="history-list">
        <li v-for="item in history.slice(0, 5)" :key="item.id">
          <span>{{ new Date(item.playedAt).toLocaleString('zh-CN') }}</span>
          <strong>{{ item.totalPoints }} / {{ item.maxPoints }}</strong>
        </li>
      </ul>
      <p v-if="recentBest" class="panel-note panel-note--tight">
        最高分：{{ recentBest.totalPoints }} / {{ recentBest.maxPoints }}
      </p>
    </section>

    <div class="panel-actions">
      <button
        type="button"
        class="primary-button"
        :disabled="!enoughPuzzles"
        @click="emit('start')"
      >
        开始游戏
      </button>
      <button type="button" class="ghost-button" @click="emit('reroll')">换一批题</button>
      <p v-if="!enoughPuzzles" class="warn-note">
        当前筛选只有 {{ candidateCount }} 道题，请减少筛选条件或降低题目数量。
      </p>
    </div>
  </div>
</template>
