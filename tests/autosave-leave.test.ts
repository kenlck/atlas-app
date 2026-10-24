import { describe, expect, it } from 'vitest'
import { flushEditor, registerEditorFlush } from '../src/lib/editor-flush'
import {
  deliverPageSave,
  type PageSaveTransport,
} from '../src/lib/page-save-keepalive'

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
})
