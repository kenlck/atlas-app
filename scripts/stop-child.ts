import type { ChildProcess } from 'node:child_process'

export async function stopChild(child: ChildProcess, graceMs = 1000) {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      return
    }
  }
  await new Promise<void>((resolve) => {
    let force: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
      force = setTimeout(resolve, 500)
    }, graceMs)
    child.once('exit', () => {
      clearTimeout(timer)
      if (force) clearTimeout(force)
      resolve()
    })
  })
}
