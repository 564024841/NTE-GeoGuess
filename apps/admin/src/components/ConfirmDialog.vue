<script setup>
// 破坏性操作的二次确认弹层（删除题目、删除分类）。
import { useConfirm } from '../composables/useConfirm'

const { state, confirm, cancel } = useConfirm()
</script>

<template>
  <div v-if="state.open" class="modal-backdrop" data-testid="confirm-dialog" @click.self="cancel">
    <div class="modal glass-panel" role="dialog" aria-modal="true">
      <h2>{{ state.title }}</h2>
      <p v-if="state.message" class="modal__message">{{ state.message }}</p>
      <p v-if="state.detail" class="modal__detail">{{ state.detail }}</p>
      <div class="modal__actions">
        <button type="button" class="ghost-button" @click="cancel">{{ state.cancelLabel }}</button>
        <button
          type="button"
          class="primary-button"
          :class="{ 'primary-button--danger': state.danger }"
          data-testid="confirm-accept"
          @click="confirm"
        >
          {{ state.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
