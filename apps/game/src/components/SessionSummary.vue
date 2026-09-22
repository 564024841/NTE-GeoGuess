<script setup>
import { computed } from 'vue'

const props = defineProps({
  summary: { type: Object, required: true },
  rounds: { type: Array, required: true },
  formatPixels: { type: Function, required: true },
})

defineEmits(['again', 'setup'])

const grade = computed(() => {
  const ratio = props.summary.maxPoints ? props.summary.totalPoints / props.summary.maxPoints : 0
  if (ratio >= 0.9) return { label: '地图大师', color: '#5ddc9a' }
  if (ratio >= 0.7) return { label: '老练探索者', color: '#8adfd6' }
  if (ratio >= 0.45) return { label: '渐入佳境', color: '#ffd27d' }
  if (ratio > 0) return { label: '还需多跑图', color: '#ffab6e' }
  return { label: '未完成', color: '#ff8080' }
})

function barWidth(points) {
  return `${Math.max(0, Math.min(100, (points / 100) * 100))}%`
}
</script>

<template>
  <div class="panel-scroll">
    <section class="panel-block">
      <h2>本局结束</h2>
      <div class="score-hero" :style="{ '--tier-color': grade.color }">
        <strong>{{ summary.totalPoints }}</strong>
        <span>/ {{ summary.maxPoints }} 分</span>
        <em>{{ grade.label }}</em>
      </div>

      <dl class="result-grid">
        <div>
          <dt>平均每题</dt>
          <dd>{{ summary.averagePoints }}</dd>
        </div>
        <div>
          <dt>平均偏差</dt>
          <dd>{{ formatPixels(summary.averageDistancePixels) }}</dd>
        </div>
        <div>
          <dt>最佳一题</dt>
          <dd>{{ summary.bestRound ? formatPixels(summary.bestRound.result.distancePixels) : '—' }}</dd>
        </div>
        <div>
          <dt>最差一题</dt>
          <dd>{{ summary.worstRound ? formatPixels(summary.worstRound.result.distancePixels) : '—' }}</dd>
        </div>
      </dl>
    </section>

    <section class="panel-block">
      <h3>逐题复盘</h3>
      <ol class="round-list">
        <li v-for="(round, position) in rounds" :key="round.puzzle.id">
          <div class="round-list__head">
            <span>#{{ position + 1 }} {{ round.puzzle.name }}</span>
            <strong>{{ round.result ? round.result.points : 0 }}</strong>
          </div>
          <div class="round-list__bar">
            <i
              :style="{
                width: barWidth(round.result ? round.result.points : 0),
                background: round.result ? round.result.tier.color : '#444',
              }"
            />
          </div>
          <small v-if="round.result">
            {{ round.puzzle.regionLabel || '未知区域' }} · 偏差
            {{ formatPixels(round.result.distancePixels) }} ·
            {{ round.result.tier.label }}
          </small>
        </li>
      </ol>
    </section>

    <div class="panel-actions">
      <button type="button" class="primary-button" @click="$emit('again')">再来一局（同设置）</button>
      <button type="button" class="ghost-button" @click="$emit('setup')">返回设置</button>
    </div>
  </div>
</template>
