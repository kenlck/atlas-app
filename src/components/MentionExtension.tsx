import Mention from '@tiptap/extension-mention'
import type { SuggestionProps } from '@tiptap/suggestion'
import { fetchMentionCandidates } from '#/server/fns'
import {
  mentionChipText,
  type MentionCandidate,
  type MentionPerson,
} from '#/lib/mention-label'

function paintList(
  root: HTMLElement,
  props: SuggestionProps<MentionCandidate, MentionCandidate>,
  selected: number,
) {
  root.replaceChildren()
  root.className = 'menu mention-list'
  root.setAttribute('role', 'listbox')
  root.setAttribute('aria-label', 'Mention someone')
  if (props.loading) {
    const skel = document.createElement('div')
    skel.className = 'skel'
    root.append(skel)
    return
  }
  if (props.items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty mention-empty'
    empty.textContent = 'No matches.'
    root.append(empty)
    return
  }
  props.items.forEach((item, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', index === selected ? 'true' : 'false')
    button.textContent = item.name
    if (index === selected) button.className = 'on'
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      props.command(item)
    })
    root.append(button)
  })
}

export function createMentionExtension(input: {
  spaceId: string
  getPeople: () => MentionPerson[]
}) {
  return Mention.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        label: {
          default: null,
          parseHTML: (element: HTMLElement) =>
            element.getAttribute('data-label'),
          renderHTML: () => ({}),
        },
      }
    },
  }).configure({
    HTMLAttributes: { class: 'mention' },
    renderText({ node }) {
      const people = input.getPeople()
      const person = people.find((item) => item.id === node.attrs.id) ?? null
      return mentionChipText(
        person,
        typeof node.attrs.label === 'string' ? node.attrs.label : null,
      )
    },
    renderHTML({ node }) {
      const people = input.getPeople()
      const person = people.find((item) => item.id === node.attrs.id) ?? null
      const text = mentionChipText(
        person,
        typeof node.attrs.label === 'string' ? node.attrs.label : null,
      )
      const former = !person?.member
      return [
        'span',
        {
          'data-type': 'mention',
          'data-id': node.attrs.id,
          class: former ? 'mention former' : 'mention',
        },
        text,
      ]
    },
    suggestion: {
      char: '@',
      items: async ({ query }) => {
        try {
          return await fetchMentionCandidates({
            data: { spaceId: input.spaceId, mentionQuery: query },
          })
        } catch {
          return []
        }
      },
      command: ({ editor, range, props }) => {
        const person = props as MentionCandidate
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: 'mention',
              attrs: { id: person.id, label: person.name },
            },
            { type: 'text', text: ' ' },
          ])
          .run()
      },
      render: () => {
        if (typeof document === 'undefined') return {}
        const root = document.createElement('div')
        let selected = 0
        let latest: SuggestionProps<MentionCandidate, MentionCandidate> | null =
          null
        let unmount: (() => void) | null = null
        const paint = (
          props: SuggestionProps<MentionCandidate, MentionCandidate>,
        ) => {
          latest = props
          if (selected >= props.items.length) selected = 0
          paintList(root, props, selected)
        }
        return {
          onStart: (props) => {
            selected = 0
            paint(props)
            unmount = props.mount(root)
          },
          onUpdate: (props) => {
            paint(props)
          },
          onKeyDown: ({ event }) => {
            if (!latest) return false
            if (event.key === 'ArrowDown') {
              selected =
                latest.items.length === 0
                  ? 0
                  : (selected + 1) % latest.items.length
              paint(latest)
              return true
            }
            if (event.key === 'ArrowUp') {
              selected =
                latest.items.length === 0
                  ? 0
                  : (selected - 1 + latest.items.length) % latest.items.length
              paint(latest)
              return true
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = latest.items[selected]
              if (!item) return false
              latest.command(item)
              return true
            }
            return false
          },
          onExit: () => {
            unmount?.()
            unmount = null
            latest = null
            root.remove()
          },
        }
      },
    },
  })
}
