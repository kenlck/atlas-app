import { describe, expect, it } from 'vitest'
import type { Json } from '../src/lib/body-text'
import { markdownToTiptap, tiptapToMarkdown } from '../src/lib/markdown-body'

function roundTrip(doc: Json) {
  const markdown = tiptapToMarkdown(doc)
  expect(markdownToTiptap(markdown)).toEqual(doc)
  expect(tiptapToMarkdown(markdownToTiptap(markdown))).toBe(markdown)
}

describe('markdown body', () => {
  it('keeps tables, mentions, and date chips', () => {
    roundTrip({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Meet ' },
            { type: 'mention', attrs: { id: 'user-1', label: 'Ada' } },
            { type: 'text', text: ' on ' },
            { type: 'dateChip', attrs: { date: '2026-10-23' } },
            { type: 'text', text: '.' },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: {
                    colspan: 1,
                    rowspan: 1,
                    colwidth: null,
                    align: null,
                  },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Who' }],
                    },
                  ],
                },
                {
                  type: 'tableHeader',
                  attrs: {
                    colspan: 1,
                    rowspan: 1,
                    colwidth: null,
                    align: null,
                  },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'When' }],
                    },
                  ],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: {
                    colspan: 1,
                    rowspan: 1,
                    colwidth: [120],
                    align: 'left',
                  },
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'mention',
                          attrs: { id: 'user-1', label: 'Ada' },
                        },
                      ],
                    },
                  ],
                },
                {
                  type: 'tableCell',
                  attrs: {
                    colspan: 2,
                    rowspan: 1,
                    colwidth: null,
                    align: null,
                  },
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'dateChip', attrs: { date: '2026-10-23' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it('keeps the attrs the editor stores on mentions, links, lists, and code', () => {
    roundTrip({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hi ' },
            {
              type: 'mention',
              attrs: { id: 'u1', label: 'Ada', mentionSuggestionChar: '@' },
            },
            {
              type: 'text',
              text: 'link',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com',
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                    class: null,
                    title: null,
                  },
                },
              ],
            },
            { type: 'dateChip', attrs: { date: '2026-10-23' } },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
              ],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: 'code' }],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: {
                    colspan: 1,
                    rowspan: 1,
                    colwidth: null,
                    align: null,
                  },
                  content: [{ type: 'paragraph' }],
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it('keeps marks, lists, and a plain table', () => {
    roundTrip({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [
            {
              type: 'text',
              text: 'Plan',
              marks: [{ type: 'bold' }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
              ],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Later' }],
                },
              ],
            },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'A' }],
                    },
                  ],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'B' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  })
})
