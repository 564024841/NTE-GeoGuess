<script setup>
// 地图左下角的 HUD：鼠标所在位置的坐标回显 + 缩放/复位按钮。
// 与游戏站同一套交互（Shift+拖拽框选会和平移冲突，所以缩放只给按钮）。
const props = defineProps({
  cursors: { type: Object, required: true },
})

defineEmits(['zoom-in', 'zoom-out', 'reset-view'])
</script>

<template>
  <div class="map-hud glass-panel" data-testid="map-hud">
    <div class="map-hud__coords">
      <span>游戏坐标</span>
      <strong>{{ Math.round(cursors.x) }}, {{ Math.round(cursors.y) }}</strong>
    </div>
    <div class="map-hud__coords">
      <span>底图像素</span>
      <strong>{{ Math.round(cursors.pixelX) }}, {{ Math.round(cursors.pixelY) }}</strong>
    </div>
    <div class="map-hud__actions">
      <button type="button" title="缩小" @click="$emit('zoom-out')">−</button>
      <button type="button" title="放大" @click="$emit('zoom-in')">+</button>
      <button type="button" title="回到全图" @click="$emit('reset-view')">复位</button>
    </div>
  </div>
</template>
