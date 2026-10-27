import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { apiProxyPlugin } from './dev-api-proxy.js'

// Windows 下文件被短暂占用（智能体临时目录、测试产物、杀毒软件扫描）时，
// fs.watch 可能抛 EBUSY/EPERM，Vite 未捕获会让 dev server 直接退出。
// 这里做兜底：只忽略“文件监听”类错误，其它异常照常抛出。
const IGNORABLE_WATCH_ERRORS = new Set(['EBUSY', 'EPERM', 'ENOSPC', 'UNKNOWN'])
globalThis.process?.on?.('uncaughtException', (error) => {
  const isWatchError = String(error?.syscall || '').includes('watch')
  if (isWatchError && IGNORABLE_WATCH_ERRORS.has(error?.code)) {
    console.warn(`[dev] 已忽略文件监听错误 ${error.code}: ${error?.path || error?.message}`)
    return
  }
  throw error
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiProxyPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    },
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true
    }
  },
  optimizeDeps: {
    include: ['@imgly/background-removal', 'onnxruntime-web']
  },
  resolve: {
    alias: {
      'onnxruntime-web/webgpu': 'onnxruntime-web',
      'onnxruntime-web/webnn': 'onnxruntime-web'
    }
  },
  server: {
    watch: {
      // 忽略编辑器/工具产生的临时目录和测试产物，避免 Windows 上 fs.watch 触发 EBUSY 导致 dev server 退出
      ignored: [
        '**/*.tmpdir/**',
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/.tmp-build/**',
        '**/edge-profile/**'
      ]
    }
  }
})
