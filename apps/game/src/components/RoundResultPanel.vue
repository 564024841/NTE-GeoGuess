<script setup>
// 单题结算卡片：偏差、得分、评价。
// 地图上同时用虚线把「你的落点 → 真实位置」标出来（见 useMap.js 的 renderOverlay）。
defineProps({
  round: { type: Object, default: null },
  formatPixels: { type: Function, required: true },
  formatGameUnits: { type: Function, required: true },
})
</script>

<template>
  <section v-if="round?.result" class="result-card" :style="{ '--tier-color': round.result.tier.color }">
    <header class="result-card__head">
      <span class="result-card__tier">{{ round.result.tier.label }}</span>
      <strong class="result-card__points">+{{ round.result.points }}</strong>
    </header>

    <dl class="result-grid">
      <div>
        <dt>地图偏差</dt>
        <dd>{{ formatPixels(round.result.distancePixels) }}</dd>
      </div>
      <div>
        <dt>游戏坐标距离</dt>
        <dd>{{ formatGameUnits(round.result.gameDistance) }}</dd>
      </div>
      <div>
        <dt>真实位置</dt>
        <dd>{{ round.puzzle.name }}</dd>
      </div>
      <div>
        <dt>所在区域</dt>
        <dd>{{ round.puzzle.regionLabel || '未知' }}</dd>
      </div>
    </dl>
  </section>
</template>
