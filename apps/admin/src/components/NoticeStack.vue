<script setup>
// 全局提示条堆栈：所有接口失败、会话过期、限流提示都会出现在这里。
// 固定在地图右上角（侧栏左侧），不遮挡操作面板。
import { useNotices } from '../composables/useNotices'

const { notices, dismiss } = useNotices()
</script>

<template>
  <div v-if="notices.length" class="notice-stack" data-testid="notice-stack">
    <article
      v-for="notice in notices"
      :key="notice.id"
      class="notice glass-panel"
      :class="`notice--${notice.kind}`"
    >
      <div class="notice__body">
        <strong>{{ notice.message }}</strong>
        <ul v-if="notice.details.length" class="notice__details">
          <li v-for="(detail, index) in notice.details" :key="index">{{ detail }}</li>
        </ul>
      </div>
      <button type="button" class="notice__close" title="关闭" @click="dismiss(notice.id)">×</button>
    </article>
  </div>
</template>
