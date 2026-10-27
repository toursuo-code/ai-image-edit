import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { apiProxyPlugin } from './dev-api-proxy.js'

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
      // 忽略编辑器/工具产生的临时目录，避免 Windows 上 fs.watch 触发 EBUSY 导致 dev server 退出
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/.*.tmpdir/**']
    }
  }
})
