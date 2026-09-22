<script setup>
// 后台入口：先判断登录态，登录后再拉启动数据，两件事都成功了才渲染工作台。
//
// 为什么要 gate 住工作台：地图实例依赖 createGeometry 的几何数据，
// 而几何数据来自 /api/bootstrap。与其让地图组件自己处理「几何还没到」的中间态，
// 不如在这里用一个明确的加载/错误界面挡住，组件内部就能假设数据一定存在。
import { computed, onMounted } from 'vue'
import { useAuth } from './composables/useAuth'
import { useBootstrap } from './composables/useBootstrap'
import ConfirmDialog from './components/ConfirmDialog.vue'
import LoginView from './components/LoginView.vue'
import MapWorkspace from './components/MapWorkspace.vue'
import NoticeStack from './components/NoticeStack.vue'

const auth = useAuth()
const {
  state: authState,
  isAuthenticated,
  isChecking,
  checkSession,
  login,
  logout,
} = auth

const bootstrap = useBootstrap()
const {
  status: bootstrapStatus,
  error: bootstrapError,
  mapConfig,
  stats,
  categories,
  geometry,
  regionPositions,
  index,
  load: loadBootstrap,
  addCategory,
} = bootstrap

const workspaceReady = computed(
  () => isAuthenticated.value && bootstrapStatus.value === 'ready' && Boolean(geometry.value),
)

const bootStatus = computed(() => {
  if (isChecking.value) return 'checking'
  if (isAuthenticated.value && (bootstrapStatus.value === 'idle' || bootstrapStatus.value === 'loading')) {
    return 'loading'
  }
  if (isAuthenticated.value && bootstrapStatus.value === 'error') return 'error'
  return 'idle'
})

onMounted(async () => {
  // 会话探测走 /api/admin/session（未登录返回 200 { authenticated: false }，不会 401）
  await checkSession()
  // bootstrap 是公共接口，但没登录时不必白拉一份 1600+ 点位的启动数据
  if (isAuthenticated.value) await loadBootstrap()
})

async function handleLogin(password) {
  const ok = await login(password)
  if (ok && bootstrapStatus.value !== 'ready') await loadBootstrap()
  return ok
}

function handleCategoryCreated(category) {
  addCategory(category)
}
</script>

<template>
  <div class="admin-root">
    <template v-if="workspaceReady">
      <MapWorkspace
        :geometry="geometry"
        :region-positions="regionPositions"
        :map-config="mapConfig"
        :index="index"
        :categories="categories"
        :stats="stats"
        :expires-at="authState.expiresAt || ''"
        @logout="logout"
        @category-created="handleCategoryCreated"
      />
    </template>

    <LoginView
      v-else-if="!isAuthenticated && !isChecking"
      :submitting="authState.submitting"
      :checking="isChecking"
      :error="authState.error"
      @submit="handleLogin"
    />

    <div v-else-if="bootStatus === 'error'" class="boot-shell">
      <div class="boot-panel glass-panel" data-testid="boot-error">
        <h2>启动数据加载失败</h2>
        <p class="status-banner status-banner--error">{{ bootstrapError }}</p>
        <p class="panel-note">
          后台需要 <code>GET /api/bootstrap</code> 提供地图与标定数据。
          确认后端已启动（开发期 <code>npm run dev:server</code>，默认 127.0.0.1:8787）后重试。
        </p>
        <button type="button" class="primary-button" @click="loadBootstrap()">重新加载</button>
      </div>
    </div>

    <div v-else class="boot-shell">
      <div class="boot-panel glass-panel" data-testid="boot-loading">
        <span class="boot-spinner" />
        <strong>{{ isChecking ? '正在检查登录状态…' : '正在加载地图与题库数据…' }}</strong>
        <p class="panel-note panel-note--tight">首次加载需要拉取地图标定与点位索引。</p>
      </div>
    </div>

    <NoticeStack />
    <ConfirmDialog />
  </div>
</template>
