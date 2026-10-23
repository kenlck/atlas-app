import Mention from '@tiptap/extension-mention'
import type { SuggestionProps } from '@tiptap/suggestion'
import { fetchMentionCandidates } from '#/server/fns'
import { initials } from '#/lib/relative-time'
import {
  mentionChipText,
  mentionPerson,
  type MentionCandidate,
  type MentionPerson,
} from '#/lib/mention-label'

function paintList(
  root: HTMLElement,
  props: SuggestionProps<MentionCandidate, MentionCandidate>,
  selected: number,
  failed: boolean,
  onRetry: () => void,
  onHover?: (index: number) => void,
) {
  root.replaceChildren()
  root.className = 'menu mention-list'
  root.setAttribute('role', 'listbox')
  root.setAttribute('aria-label', 'Mention someone')
  if (failed) {
    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.append("Couldn't load mentions.")
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Retry'
    retry.addEventListener('mousedown', (event) => {
      event.preventDefault()
      onRetry()
    })
    banner.append(retry)
    root.append(banner)
    return
  }
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
    if (index === selected) button.className = 'on'
    const avatar = document.createElement('span')
    avatar.className = 'me'
    avatar.textContent = initials(item.name)
    const label = document.createElement('span')
    label.textContent = item.name
    button.append(avatar, label)
    button.addEventListener('mouseenter', () => onHover?.(index))
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
  let mentionFailed = false
  let listRoot: HTMLElement | null = null
  let retryQuery = ''
  const listed = new Map<string, MentionCandidate>()
  const paintError = () => {
    if (!listRoot) return
    listRoot.replaceChildren()
    listRoot.className = 'menu mention-list'
    listRoot.setAttribute('role', 'listbox')
    listRoot.setAttribute('aria-label', 'Mention someone')
    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.append("Couldn't load mentions.")
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Retry'
    retry.addEventListener('mousedown', (event) => {
      event.preventDefault()
      void load(retryQuery)
    })
    banner.append(retry)
    listRoot.append(banner)
  }
  const load = async (query: string) => {
    retryQuery = query
    try {
      const rows = await fetchMentionCandidates({
        data: { spaceId: input.spaceId, mentionQuery: query },
      })
      if (!Array.isArray(rows)) throw new Error('Mention lookup failed')
      mentionFailed = false
      for (const row of rows) listed.set(row.id, row)
      return rows
    } catch {
      mentionFailed = true
      paintError()
      return []
    }
  }
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
      const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
      const person = mentionPerson(id, input.getPeople(), listed.values())
      return mentionChipText(
        person,
        typeof node.attrs.label === 'string' ? node.attrs.label : null,
      )
    },
    renderHTML({ node }) {
      const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
      const person = mentionPerson(id, input.getPeople(), listed.values())
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
      items: ({ query }) => load(query),
      command: ({ editor, range, props }) => {
        const person = props as MentionCandidate
        listed.set(person.id, person)
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
          paintList(
            root,
            props,
            selected,
            mentionFailed,
            () => {
              const query = props.query
              paintList(
                root,
                { ...props, loading: true, items: [] },
                0,
                false,
                () => undefined,
              )
              void load(query).then((items) => {
                if (latest !== props) return
                paint({ ...props, items, loading: false })
              })
            },
            (index) => {
              if (selected === index) return
              selected = index
              paint(props)
            },
          )
        }
        return {
          onStart: (props) => {
            listRoot = root
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
            listRoot = null
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
