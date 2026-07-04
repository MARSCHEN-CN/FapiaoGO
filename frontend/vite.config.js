import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  root: 'src',

  plugins: [
    react(),
  ],
  publicDir: '../public',

  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../electron/shared'),
    },
  },

  build: {
    target: 'chrome150',
    // 代码分割优化（Vite 8 使用 Rolldown codeSplitting）
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-pdf',
              test: /[\\/]node_modules[\\/](react-pdf|pdfjs-dist)[\\/]/,
            },
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](react-dom|react)[\\/]/,
            },
            {
              name: 'vendor-utils',
              test: /[\\/]node_modules[\\/](react-dropzone|react-window)[\\/]/,
            },
          ],
        },
      },
    },
    // CSS 代码分割
    cssCodeSplit: true,
    // 压缩报告 & gzip/brotli 压缩
    reportCompressedSize: true,
    chunkSizeWarningLimit: 500,
    // 开启 CSS 代码压缩
    cssMinify: true,
    // 开启 JS 代码压缩（Oxc 为 Vite 8 默认压缩器）
    minify: true,
  },

  // 依赖预构建优化
  // ✅ 预构建所有常用依赖，确保 CJS 模块正确转换为 ESM
  // ⚠️ react-pdf 和 pdfjs-dist 也需要预构建，否则 worker 配置会失败
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dropzone', 'react-window', 'warning', 'tiny-invariant', 'prop-types', 'react-pdf', 'pdfjs-dist'],
  },

  server: {
    fs: {
      strict: false
    },
    // Windows 下 fsevents 不稳定，改用 polling 避免进程意外退出
    watch: {
      usePolling: true,
      interval: 500,
      binaryInterval: 1000,
    },
    hmr: {
      overlay: true,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/parse_invoice': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/get_pdf_pages': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/split_pdf': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
})
