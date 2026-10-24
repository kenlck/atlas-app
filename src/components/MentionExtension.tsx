import Mention from '@tiptap/extension-mention'
import type { SuggestionProps } from '@tiptap/suggestion'
import { fetchMentionCandidates } from '#/server/fns'
import { initials } from '#/lib/relative-time'
import {
  applyMentionQuery,
  createMentionCache,
  mentionChipText,
} from '#/lib/mention-label'
import type { MentionCandidate, MentionPerson } from '#/lib/mention-label'

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
  let generation = 0
  let onRefresh: (() => void) | null = null
  const cache = createMentionCache()
  const chipFor = (id: string) => {
    const person = cache.person(id, input.getPeople())
    return {
      text: mentionChipText(person, null),
      className: !person
        ? 'mention unknown'
        : person.member
          ? 'mention'
          : 'mention former',
    }
  }
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
    const ticket = ++generation
    const filtered = query.trim() !== ''
    try {
      const rows = await fetchMentionCandidates({
        data: { spaceId: input.spaceId, mentionQuery: query },
      })
      if (ticket !== generation) return []
      if (!Array.isArray(rows)) throw new Error('Mention lookup failed')
      mentionFailed = false
      applyMentionQuery(cache, query, rows)
      onRefresh?.()
      return rows
    } catch {
      if (ticket !== generation) return []
      mentionFailed = true
      if (!filtered) cache.clear()
      onRefresh?.()
      paintError()
      return []
    }
  }
  const extension = Mention.extend({
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
      return chipFor(id).text
    },
    renderHTML({ node }) {
      const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
      const chip = chipFor(id)
      return [
        'span',
        {
          'data-type': 'mention',
          'data-id': node.attrs.id,
          class: chip.className,
        },
        chip.text,
      ]
    },
    suggestion: {
      char: '@',
      items: ({ query }) => load(query),
      command: ({ editor, range, props }) => {
        const person = props as MentionCandidate
        cache.remember(person)
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
              if (latest.items.length === 0) return false
              latest.command(latest.items[selected])
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
  return {
    extension,
    clear() {
      generation += 1
      cache.clear()
    },
    sync(root: ParentNode) {
      root
        .querySelectorAll<HTMLElement>('[data-type="mention"]')
        .forEach((el) => {
          const chip = chipFor(el.getAttribute('data-id') ?? '')
          el.textContent = chip.text
          el.className = chip.className
        })
    },
    setOnRefresh(fn: (() => void) | null) {
      onRefresh = fn
    },
  }
}
