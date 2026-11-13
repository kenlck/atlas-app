import { describe, expect, it } from 'vitest'
import {
  createEditorSave,
  flushEditor,
  registerEditorFlush,
} from '../src/lib/editor-flush'
import {
  deliverPageSave,
  UNLOAD_FLUSH_MAX_BYTES,
} from '../src/lib/page-save-keepalive'
import type { PageSaveTransport } from '../src/lib/page-save-keepalive'

const payload = {
  pageId: 'page-1',
  title: 'Notes',
  body: { type: 'doc', content: [{ type: 'paragraph' }] },
}

function transport(
  impl: Partial<PageSaveTransport> & Pick<PageSaveTransport, 'syncPost'>,
): PageSaveTransport & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    syncPost(url, body) {
      calls.push('sync')
      return impl.syncPost(url, body)
    },
    beacon(url, body) {
      calls.push('beacon')
      return impl.beacon ? impl.beacon(url, body) : false
    },
    fetchKeepalive(url, body) {
      calls.push('fetch')
      impl.fetchKeepalive?.(url, body)
    },
  }
}

describe('in-progress save before leaving the editor', () => {
  it('finishes the in-progress save synchronously before leaving', () => {
    const via = transport({
      syncPost: (_url, body) => {
        expect(body).toContain('"pageId":"page-1"')
        return true
      },
      beacon: () => true,
    })
    expect(deliverPageSave(payload, via)).toBe('sync')
    expect(via.calls).toEqual(['sync'])
  })

  it('falls back when page dismissal rejects the synchronous save', () => {
    const via = transport({
      syncPost: () => {
        throw new Error('synchronous XHR blocked')
      },
      beacon: (_url, body) => {
        expect(body).toContain('page-1')
        return true
      },
    })
    expect(deliverPageSave(payload, via)).toBe('beacon')
    expect(via.calls).toEqual(['sync', 'beacon'])
  })

  it('uses fetch keepalive when both the synchronous post and the beacon decline', () => {
    const via = transport({
      syncPost: () => false,
      beacon: () => false,
    })
    expect(deliverPageSave(payload, via)).toBe('fetch')
    expect(via.calls).toEqual(['sync', 'beacon', 'fetch'])
  })

  it('flushes a body at the 64 KB cap and still syncs a larger one', () => {
    const shell = {
      pageId: 'page-1',
      title: '',
      body: { type: 'doc', content: [{ type: 'paragraph' }] },
    }
    const empty = new TextEncoder().encode(JSON.stringify(shell)).length
    const atCap = {
      pageId: shell.pageId,
      title: 'a'.repeat(UNLOAD_FLUSH_MAX_BYTES - empty),
      body: shell.body,
    }
    const over = {
      pageId: shell.pageId,
      title: 'a'.repeat(UNLOAD_FLUSH_MAX_BYTES - empty + 1),
      body: shell.body,
    }
    expect(new TextEncoder().encode(JSON.stringify(atCap)).length).toBe(
      UNLOAD_FLUSH_MAX_BYTES,
    )
    expect(new TextEncoder().encode(JSON.stringify(over)).length).toBe(
      UNLOAD_FLUSH_MAX_BYTES + 1,
    )
    const allowed = transport({ syncPost: () => true })
    expect(deliverPageSave(atCap, allowed)).toBe('sync')
    expect(allowed.calls).toEqual(['sync'])
    const skipped = transport({
      syncPost: () => true,
      beacon: () => true,
    })
    expect(deliverPageSave(over, skipped)).toBe('sync')
    expect(skipped.calls).toEqual(['sync'])
  })
})

describe('flush while a save is in flight', () => {
  it('awaits the save in flight, then saves the latest content', async () => {
    const saved: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queue = createEditorSave(async (snapshot) => {
      saved.push(snapshot.title)
      if (snapshot.title === 'stale') await gate
    })
    queue.update({ pageId: 'p', title: 'stale', body: null })
    const inflight = queue.flush()
    await Promise.resolve()
    expect(saved).toEqual(['stale'])
    queue.update({ pageId: 'p', title: 'latest', body: null })
    let finished = false
    const flushed = queue.flush().then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    release()
    await Promise.all([inflight, flushed])
    expect(saved).toEqual(['stale', 'latest'])
    expect(finished).toBe(true)
  })
})

describe('save the open page before creating another one', () => {
  it('waits for the open page save before the caller continues', async () => {
    let release: () => void = () => undefined
    const saved = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const unregister = registerEditorFlush(async () => {
      order.push('save-start')
      await saved
      order.push('save-end')
    })
    const creating = flushEditor().then(() => {
      order.push('create')
    })
    await Promise.resolve()
    expect(order).toEqual(['save-start'])
    release()
    await creating
    expect(order).toEqual(['save-start', 'save-end', 'create'])
    unregister()
    await flushEditor()
    expect(order).toEqual(['save-start', 'save-end', 'create'])
  })

  it('stops a hung flush within five seconds so create does not continue', async () => {
    const unregister = registerEditorFlush(() => new Promise(() => undefined))
    const started = Date.now()
    let continued = false
    await expect(
      flushEditor(80).then(() => {
        continued = true
      }),
    ).rejects.toThrow('Save timed out')
    expect(continued).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
    unregister()
  })

  it('rejects a failed flush so create does not continue', async () => {
    const unregister = registerEditorFlush(async () => {
      throw new Error('save failed')
    })
    let continued = false
    await expect(
      flushEditor().then(() => {
        continued = true
      }),
    ).rejects.toThrow('save failed')
    expect(continued).toBe(false)
    unregister()
  })
})
