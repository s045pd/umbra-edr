<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { auth as authApi, users as usersApi } from '@/api/endpoints'
import type { OperatorUser } from '@/types/api'
import Btn from '@/components/ui/Btn.vue'
import Field from '@/components/ui/Field.vue'
import ExtensionDownload from '@/components/ExtensionDownload.vue'

const auth = useAuthStore()
const newPwd = ref('')
const newPwd2 = ref('')
const error = ref<string | null>(null)
const ok = ref<string | null>(null)
const saving = ref(false)
const totpSecret = ref('')
const totpUrl = ref('')
const totpCode = ref('')
const totpPassword = ref('')
const totpMsg = ref<string | null>(null)
const userList = ref<OperatorUser[]>([])
const newUser = ref('')
const newUserPwd = ref('')
const newUserRole = ref('operator')
const userMsg = ref<string | null>(null)

async function changePwd(): Promise<void> {
  error.value = null
  ok.value = null
  if (newPwd.value.length < 8) {
    error.value = 'Password must be at least 8 characters.'
    return
  }
  if (newPwd.value !== newPwd2.value) {
    error.value = 'Passwords do not match.'
    return
  }
  saving.value = true
  try {
    await auth.changePassword(newPwd.value)
    ok.value = 'Password updated.'
    newPwd.value = ''
    newPwd2.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'change password failed'
  } finally {
    saving.value = false
  }
}

function downloadCA(): void {
  window.location.href = '/api/v1/download_ca'
}

async function setupTotp(): Promise<void> {
  totpMsg.value = null
  try {
    const row = await authApi.totpSetup()
    totpSecret.value = row.secret
    totpUrl.value = row.otpauth_url
  } catch (e) {
    totpMsg.value = e instanceof Error ? e.message : 'setup failed'
  }
}

async function enableTotp(): Promise<void> {
  totpMsg.value = null
  try {
    await authApi.totpEnable(totpCode.value.trim())
    totpMsg.value = 'Authenticator enabled.'
    totpSecret.value = ''
    totpUrl.value = ''
    totpCode.value = ''
    await auth.refresh()
  } catch (e) {
    totpMsg.value = e instanceof Error ? e.message : 'enable failed'
  }
}

async function disableTotp(): Promise<void> {
  totpMsg.value = null
  try {
    await authApi.totpDisable(totpPassword.value)
    totpMsg.value = 'Authenticator disabled.'
    totpPassword.value = ''
    await auth.refresh()
  } catch (e) {
    totpMsg.value = e instanceof Error ? e.message : 'disable failed'
  }
}

async function loadUsers(): Promise<void> {
  if (!auth.isAdmin) return
  try {
    userList.value = (await usersApi.list()) ?? []
  } catch {
    userList.value = []
  }
}

async function createUser(): Promise<void> {
  userMsg.value = null
  try {
    await usersApi.create(newUser.value.trim(), newUserPwd.value, newUserRole.value)
    newUser.value = ''
    newUserPwd.value = ''
    userMsg.value = 'User created.'
    await loadUsers()
  } catch (e) {
    userMsg.value = e instanceof Error ? e.message : 'create failed'
  }
}

async function removeUser(id: string): Promise<void> {
  if (!window.confirm('Delete this operator?')) return
  userMsg.value = null
  try {
    await usersApi.remove(id)
    await loadUsers()
  } catch (e) {
    userMsg.value = e instanceof Error ? e.message : 'delete failed'
  }
}

onMounted(loadUsers)
</script>

<template>
  <div class="px-6 pt-5 pb-12 max-w-[720px] mx-auto space-y-6">
    <div>
      <h1 class="text-[20px] font-semibold tracking-tight">Settings</h1>
      <p class="text-[12px] text-fg-faint mt-0.5">
        Account preferences and proxy CA download.
      </p>
    </div>

    <section class="surface p-5 space-y-3">
      <h2 class="text-[13px] font-semibold">Account</h2>
      <p class="text-[12px] text-fg-muted">
        Signed in as <span class="mono">{{ auth.me?.username }}</span>.
        <span v-if="auth.mustChangePassword" class="ml-1 text-warn">
          (rotation required)
        </span>
      </p>

      <Field
        v-model="newPwd"
        label="New password"
        type="password"
        autocomplete="new-password"
        hint="At least 8 characters."
      />
      <Field
        v-model="newPwd2"
        label="Confirm new password"
        type="password"
        autocomplete="new-password"
      />

      <p v-if="error" class="text-danger text-[12px]">{{ error }}</p>
      <p v-if="ok" class="text-success text-[12px]">{{ ok }}</p>

      <Btn variant="primary" :loading="saving" @click="changePwd">
        Change password
      </Btn>
    </section>

    <section class="surface p-5 space-y-3">
      <h2 class="text-[13px] font-semibold">Two-factor authentication</h2>
      <p class="text-[12px] text-fg-muted">
        TOTP via any authenticator app. Currently
        <span class="mono">{{ auth.me?.totp_enabled ? 'enabled' : 'off' }}</span>.
      </p>
      <div v-if="!auth.me?.totp_enabled" class="space-y-2">
        <Btn size="sm" variant="subtle" @click="setupTotp">Generate secret</Btn>
        <p v-if="totpSecret" class="text-[12px] mono break-all">{{ totpSecret }}</p>
        <p v-if="totpUrl" class="text-[11px] text-fg-faint break-all">{{ totpUrl }}</p>
        <Field v-if="totpSecret" v-model="totpCode" label="Confirm code" autocomplete="one-time-code" />
        <Btn v-if="totpSecret" size="sm" variant="primary" @click="enableTotp">Enable</Btn>
      </div>
      <div v-else class="space-y-2">
        <Field v-model="totpPassword" label="Current password" type="password" />
        <Btn size="sm" variant="subtle" @click="disableTotp">Disable 2FA</Btn>
      </div>
      <p v-if="totpMsg" class="text-[12px] text-fg-muted">{{ totpMsg }}</p>
    </section>

    <section v-if="auth.isAdmin" class="surface p-5 space-y-3">
      <h2 class="text-[13px] font-semibold">Operators</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Field v-model="newUser" label="Username" />
        <Field v-model="newUserPwd" label="Password" type="password" />
        <label class="block">
          <span class="block text-[11px] uppercase tracking-wider text-fg-muted mb-1.5">Role</span>
          <select v-model="newUserRole" class="h-9 text-[13px] px-3 rounded bg-bg-overlay border border-border-subtle w-full">
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </label>
      </div>
      <Btn size="sm" variant="primary" @click="createUser">Add operator</Btn>
      <p v-if="userMsg" class="text-[12px] text-fg-muted">{{ userMsg }}</p>
      <ul class="text-[12px] divide-y divide-border-subtle">
        <li v-for="u in userList" :key="u.id" class="py-2 flex items-center justify-between">
          <span><span class="mono">{{ u.username }}</span> · {{ u.role }} · 2FA {{ u.totp_enabled ? 'on' : 'off' }}</span>
          <button class="text-danger text-[11px]" @click="removeUser(u.id)">Delete</button>
        </li>
      </ul>
    </section>

    <section class="surface p-5 space-y-3">
      <h2 class="text-[13px] font-semibold">Chrome / Edge policy pack</h2>
      <p class="text-[12px] text-fg-muted">
        Force-install Sensor and disable QUIC so the HTTPS proxy is not bypassed via HTTP/3.
        For Chrome Browser Cloud Management, upload the JSON. For AD, import the .reg.
      </p>
      <div class="flex flex-wrap gap-2">
        <a class="text-[12px] text-accent" href="/ext/chrome-policy.json">chrome-policy.json</a>
        <a class="text-[12px] text-accent" href="/ext/edge-policy.json">edge-policy.json</a>
        <a class="text-[12px] text-accent" href="/ext/chrome-policy.reg">chrome-policy.reg</a>
      </div>
    </section>

    <section class="surface p-5 space-y-3">
      <h2 class="text-[13px] font-semibold">Proxy CA certificate</h2>
      <p class="text-[12px] text-fg-muted">
        Required to use the HTTPS proxy. Install the CA cert in your client's trust store.
      </p>
      <Btn variant="subtle" @click="downloadCA">Download rootCA.crt</Btn>
    </section>

    <ExtensionDownload />
  </div>
</template>
