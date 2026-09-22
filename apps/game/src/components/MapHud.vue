<script setup>
// 地图左下角的悬浮信息条：实时坐标 + 视图操作。
// 缩放用按钮而不是 Shift+拖拽：浏览器把 Shift+拖拽当成框选放大，会和地图平移冲突。
defineProps({
  cursors: { type: Object, required: true },
})

defineEmits(['reset-view', 'fit-round', 'zoom-in', 'zoom-out'])
</script>

<template>
  <div class="map-hud glass-panel">
    <div class="map-hud__coords">
      <span>游戏坐标</span>
      <strong>{{ Math.round(cursors.x) }}, {{ Math.round(cursors.y) }}</strong>
    </div>
    <div class="map-hud__coords">
      <span>标定像素</span>
      <strong>{{ Math.round(cursors.pixelX) }}, {{ Math.round(cursors.pixelY) }}</strong>
    </div>
    <div class="map-hud__actions">
      <button type="button" title="缩小" @click="$emit('zoom-out')">−</button>
      <button type="button" title="放大" @click="$emit('zoom-in')">＋</button>
      <button type="button" @click="$emit('fit-round')">看本回合</button>
      <button type="button" @click="$emit('reset-view')">复位视图</button>
    </div>
  </div>
</template>
