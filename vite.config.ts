import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
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
        const readBody = async (req: IncomingMessage): Promise<string> => {
          const chunks: Uint8Array[] = []
          req.on('data', (chunk) => chunks.push(chunk))
          await new Promise<void>((resolve, reject) => {
            req.on('end', () => resolve())
            req.on('error', (err) => reject(err))
          })
          return Buffer.concat(chunks).toString('utf-8')
        }

        const dbRoot = path.resolve(process.cwd(), '.harmograph-db')
        const projectsDir = path.join(dbRoot, 'projects')

        server.middlewares.use('/__db/projects', async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))

            if (req.method === 'GET' && (id === '' || id === '/')) {
              await mkdir(projectsDir, { recursive: true })
              const files = await readdir(projectsDir)
              const projects = await Promise.all(
                files
                  .filter((name) => name.endsWith('.json'))
                  .map(async (name) => {
                    const text = await readFile(path.join(projectsDir, name), 'utf-8')
                    return JSON.parse(text)
                  }),
              )
              projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, projects }))
              return
            }

            if (req.method === 'PUT' && id !== '') {
              await mkdir(projectsDir, { recursive: true })
              const body = await readBody(req)
              const filePath = path.join(projectsDir, `${id}.json`)
              await writeFile(filePath, body, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }

            if (req.method === 'DELETE' && id !== '') {
              const filePath = path.join(projectsDir, `${id}.json`)
              await rm(filePath, { force: true })
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }

            res.statusCode = 405
            res.end('Method Not Allowed')
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

        server.middlewares.use('/__debug/save', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
          }

          try {
            const body = await readBody(req)
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
