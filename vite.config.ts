import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'harmograph-debug-save',
      configureServer(server) {
        server.middlewares.use('/__debug/save', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
          }

          try {
            const chunks: Uint8Array[] = []
            req.on('data', (chunk) => chunks.push(chunk))
            await new Promise<void>((resolve, reject) => {
              req.on('end', () => resolve())
              req.on('error', (err) => reject(err))
            })

            const body = Buffer.concat(chunks).toString('utf-8')
            const now = new Date()
            const stamp = now.toISOString().replace(/[:.]/g, '-')
            const debugDir = path.resolve(process.cwd(), 'debug')
            await mkdir(debugDir, { recursive: true })

            const latestPath = path.join(debugDir, 'latest-analysis.json')
            const historyPath = path.join(debugDir, `analysis-${stamp}.json`)
            await writeFile(latestPath, body, 'utf-8')
            await writeFile(historyPath, body, 'utf-8')

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, latestPath, historyPath }))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : 'unknown error',
              }),
            )
          }
        })
      },
    },
  ],
})
