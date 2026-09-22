<script setup>
// 登录页。
//
// 后端没起来时这里也必须能正常渲染——后台是运维工具，
// 「服务不可用」本身就是要展示的状态，不能白屏。
import { ref } from 'vue'

const props = defineProps({
  submitting: { type: Boolean, default: false },
  checking: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['submit'])

const password = ref('')

function handleSubmit() {
  if (props.submitting) return
  emit('submit', password.value)
}
</script>

<template>
  <div class="login-shell">
    <form class="login-panel glass-panel" data-testid="login-panel" @submit.prevent="handleSubmit">
      <div class="brand">
        <span class="brand__mark">图寻</span>
        <div class="brand__text">
          <strong>题库后台</strong>
          <small>出题 · 改题 · 分类管理</small>
        </div>
      </div>

      <label class="field">
        <span>后台密码</span>
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="请输入 ADMIN_PASSWORD"
          data-testid="login-password"
          :disabled="submitting"
        />
      </label>

      <!-- 401（密码错/剩余次数）与 429（限流）都在这里展示 -->
      <p v-if="error" class="status-banner status-banner--error" data-testid="login-error">
        {{ error }}
      </p>

      <button
        type="submit"
        class="primary-button"
        data-testid="login-submit"
        :disabled="submitting || !password"
      >
        {{ submitting ? '正在登录…' : '登录' }}
      </button>

      <p class="panel-note panel-note--tight">
        会话保存在 httpOnly Cookie 里（nte_admin_session），前端不接触密码之外的凭据。
        连续输错会被服务端限流。
      </p>
      <p v-if="checking" class="panel-note panel-note--tight" data-testid="login-checking">
        正在检查登录状态…
      </p>
      <p class="panel-note panel-note--tight">
        第一次部署请用服务端的 ADMIN_PASSWORD 登录；忘记密码时改环境变量重启后端即可。
      </p>
    </form>
  </div>
</template>
