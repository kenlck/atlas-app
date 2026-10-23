import { describe, expect, it } from 'vitest'
import { tiptapToText } from '../src/lib/body-text'

describe('tiptapToText', () => {
  it('flattens text nodes', () => {
    expect(
      tiptapToText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
        ],
      }),
    ).toBe('Hello World')
  })
})
