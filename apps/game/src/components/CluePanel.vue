<script setup>
import { computed } from 'vue'
import { resolveImageUrl } from '@nte-geoguess/shared/images'

const props = defineProps({
  round: { type: Object, default: null },
  roundLabel: { type: String, default: '' },
  clueImage: { type: String, default: null },
  phase: { type: String, default: 'playing' },
  guessHint: { type: String, default: '' },
  hasGuess: { type: Boolean, default: false },
  category: { type: Object, default: null },
  showAnswerMeta: { type: Boolean, default: true },
})

const emit = defineEmits(['confirm', 'next', 'quit'])

const imageUrl = computed(() => (props.clueImage ? resolveImageUrl(props.clueImage, import.meta.env.VITE_API_BASE || '') : null))
const isRevealed = computed(() => props.phase === 'revealed')
const imageCount = computed(() => props.round?.puzzle?.images?.length || 0)
</script>

<template>
  <div class="panel-scroll">
    <section class="panel-block">
      <header class="panel-block__head">
        <h2>第 {{ roundLabel }} 题</h2>
        <button type="button" class="link-button" @click="emit('quit')">退出本局</button>
      </header>

      <div class="clue-frame">
        <img v-if="imageUrl" :src="imageUrl" :alt="`第 ${roundLabel} 题截图`" />
        <div v-else class="clue-frame__empty">该点位没有可用截图</div>
        <span v-if="imageCount > 1" class="clue-frame__badge">{{ imageCount }} 张</span>
      </div>

      <ul class="clue-meta">
        <li>
          <span>线索类型</span>
          <strong>{{ category?.label || '未分类' }}</strong>
        </li>
        <li>
          <span>所在区域</span>
          <strong>{{ isRevealed && showAnswerMeta ? (round?.puzzle?.regionLabel || '未知') : '???' }}</strong>
        </li>
        <li>
          <span>目标名称</span>
          <strong>{{ isRevealed && showAnswerMeta ? round?.puzzle?.name : '???' }}</strong>
        </li>
      </ul>

      <p class="panel-note panel-note--tight">
        提示：截图里的地形、建筑、植被与地图纹理是对应的，先用可辨识的地标缩小范围，再精确定位。
        偏差按底图像素计算，偏 50 px 大约扣掉一半分。
      </p>
    </section>

    <div class="panel-actions">
      <template v-if="!isRevealed">
        <p class="status-line">{{ guessHint || '在地图上点击你认为的位置' }}</p>
        <button type="button" class="primary-button" :disabled="!hasGuess" @click="emit('confirm')">
          确认落点（空格）
        </button>
      </template>
      <template v-else>
        <p class="status-line">已揭晓答案，地图上虚线连接的是你的落点与真实位置。</p>
        <button type="button" class="primary-button" @click="emit('next')">
          下一题（空格）
        </button>
      </template>
    </div>
  </div>
</template>
