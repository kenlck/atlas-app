import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.ATLAS_DRAIN_ROOT
const port = Number(process.env.ATLAS_DRAIN_PORT)
if (!root || !Number.isInteger(port) || port <= 0) {
  throw new Error('drain server is not configured')
}

const plugin = (await import(pathToFileURL(join(root, 'src/server/production-env.ts')).href)) as {
  default?: () => void
}
if (typeof plugin.default !== 'function') throw new Error('stop plugin missing')
plugin.default()

const pages = (await import(pathToFileURL(join(root, 'src/lib/pages.ts')).href)) as {
  savePage: (
    userId: string,
    input: { pageId: string; title: string; body: unknown; updatedAt: string },
  ) => Promise<{ updatedAt: string }>
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/save') {
    res.writeHead(404)
    res.end()
    return
  }
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  req.on('end', () => {
    let payload: { userId: string; pageId: string; title: string; body: unknown; updatedAt: string }
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof payload
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    void pages
      .savePage(payload.userId, payload)
      .then((view) => {
        if (res.writableEnded) return
        res.writeHead(204, { 'x-updated-at': view.updatedAt })
        res.end()
      })
      .catch((error: unknown) => {
        if (res.writableEnded) return
        const status =
          error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
            ? error.status
            : 500
        res.writeHead(status)
        res.end()
      })
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`drain-listen ${port}`)
})
