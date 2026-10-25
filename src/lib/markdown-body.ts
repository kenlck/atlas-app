import type { Json } from './body-text'
import { formatDateLabel } from './date-label'

type Mark = { type: string; attrs?: Record<string, Json> }
type Node = {
  type: string
  text?: string
  attrs?: Record<string, Json>
  marks?: Mark[]
  content?: Node[]
}

const MARK_ORDER = ['code', 'bold', 'italic', 'strike', 'underline', 'link']

function asNode(value: Json): Node | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, Json>
  if (typeof record.type !== 'string') return null
  return value as Node
}

function nodesOf(value: Json | undefined): Node[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Node => asNode(item) !== null)
}

function escapeText(text: string) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/~/g, '\\~')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

function unescapeText(text: string) {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith('&lt;', i)) {
      out += '<'
      i += 3
      continue
    }
    if (text.startsWith('&amp;', i)) {
      out += '&'
      i += 4
      continue
    }
    if (text[i] === '\\' && i + 1 < text.length) {
      out += text[i + 1]
      i += 1
      continue
    }
    out += text[i]
  }
  return out
}

function attrString(attrs: Record<string, Json> | undefined, key: string) {
  const value = attrs?.[key]
  return typeof value === 'string' ? value : ''
}

function wrapMarks(text: string, marks: Mark[]) {
  let out = text
  for (const type of MARK_ORDER) {
    const mark = marks.find((item) => item.type === type)
    if (!mark) continue
    if (type === 'code') out = `\`${out}\``
    else if (type === 'bold') out = `**${out}**`
    else if (type === 'italic') out = `*${out}*`
    else if (type === 'strike') out = `~~${out}~~`
    else if (type === 'underline') out = `<u>${out}</u>`
    else if (type === 'link') out = emitLink(out, mark)
  }
  return out
}

function escapeAttr(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function decodeAttr(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function emitLink(text: string, mark: Mark) {
  const attrs = mark.attrs ?? {}
  const extra = Object.keys(attrs).filter((key) => key !== 'href')
  if (extra.length === 0) return `[${text}](${attrString(attrs, 'href')})`
  const parts = [`href="${escapeAttr(attrString(attrs, 'href'))}"`]
  for (const key of ['target', 'rel', 'class', 'title']) {
    if (!(key in attrs)) continue
    const value = attrs[key]
    parts.push(
      `data-${key}="${typeof value === 'string' ? escapeAttr(value) : ''}"`,
    )
  }
  return `<a ${parts.join(' ')}>${text}</a>`
}

function emitMention(node: Node) {
  const id = attrString(node.attrs, 'id')
  const label = attrString(node.attrs, 'label')
  const suggestion = node.attrs?.mentionSuggestionChar
  const query =
    typeof suggestion === 'string'
      ? `?mentionSuggestionChar=${encodeURIComponent(suggestion)}`
      : ''
  return wrapMarks(
    `[@${escapeText(label)}](atlas://user/${encodeURIComponent(id)}${query})`,
    node.marks ?? [],
  )
}

function emitDate(node: Node) {
  const date = attrString(node.attrs, 'date')
  return wrapMarks(
    `[${formatDateLabel(date)}](atlas://date/${date})`,
    node.marks ?? [],
  )
}

function emitInline(nodes: Node[]) {
  return nodes
    .map((node) => {
      if (node.type === 'text')
        return wrapMarks(escapeText(node.text ?? ''), node.marks ?? [])
      if (node.type === 'mention') return emitMention(node)
      if (node.type === 'dateChip') return emitDate(node)
      if (node.type === 'hardBreak') return '\\\n'
      return ''
    })
    .join('')
}

function cellAttrs(node: Node) {
  const attrs = node.attrs ?? {}
  const parts: string[] = []
  if ('colspan' in attrs) parts.push(`colspan="${String(attrs.colspan)}"`)
  if ('rowspan' in attrs) parts.push(`rowspan="${String(attrs.rowspan)}"`)
  if ('colwidth' in attrs) {
    const width = attrs.colwidth
    const value = Array.isArray(width)
      ? width.map((item) => String(item)).join(',')
      : ''
    parts.push(`data-colwidth="${value}"`)
  }
  if ('align' in attrs) {
    const align =
      typeof attrs.align === 'string' ? encodeURIComponent(attrs.align) : ''
    parts.push(`data-align="${align}"`)
  }
  return parts.length ? ` ${parts.join(' ')}` : ''
}

function emitTable(node: Node) {
  const rows = (node.content ?? [])
    .map((row) => {
      const cells = (row.content ?? [])
        .map((cell) => {
          const tag = cell.type === 'tableHeader' ? 'th' : 'td'
          const inner = (cell.content ?? [])
            .map((block) =>
              block.type === 'paragraph'
                ? emitInline(block.content ?? [])
                : emitBlocks([block]).join('\n\n'),
            )
            .join('')
          return `<${tag}${cellAttrs(cell)}>${inner}</${tag}>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return `<table>${rows}</table>`
}

function simpleItems(node: Node) {
  return (node.content ?? []).every((item) => {
    const content = item.content ?? []
    return content.length === 1 && content[0]?.type === 'paragraph'
  })
}

function emitList(node: Node) {
  if (
    !simpleItems(node) ||
    (node.attrs && Object.keys(node.attrs).length > 0)
  ) {
    return emitHtmlList(node)
  }
  return (node.content ?? [])
    .map((item, index) => {
      const text = emitInline(item.content?.[0]?.content ?? [])
      if (node.type === 'taskList') {
        const checked = item.attrs?.checked === true
        return `- [${checked ? 'x' : ' '}] ${text}`
      }
      if (node.type === 'orderedList') return `${index + 1}. ${text}`
      return `- ${text}`
    })
    .join('\n')
}

function emitHtmlList(node: Node) {
  const tag = node.type === 'orderedList' ? 'ol' : 'ul'
  let open = node.type === 'taskList' ? '<ul data-type="taskList">' : `<${tag}>`
  if (node.type === 'orderedList' && node.attrs) {
    const parts: string[] = []
    if ('start' in node.attrs)
      parts.push(`data-start="${String(node.attrs.start)}"`)
    if ('type' in node.attrs) {
      const value =
        typeof node.attrs.type === 'string'
          ? encodeURIComponent(node.attrs.type)
          : ''
      parts.push(`data-list-type="${value}"`)
    }
    open = `<ol${parts.length ? ` ${parts.join(' ')}` : ''}>`
  }
  const items = (node.content ?? [])
    .map((item) => {
      const checked =
        item.type === 'taskItem'
          ? ` data-checked="${item.attrs?.checked === true}"`
          : ''
      const inner = emitBlocks(item.content ?? []).join('')
      return `<li${checked}>${inner}</li>`
    })
    .join('')
  return `${open}${items}</${tag}>`
}

function emitBlocks(nodes: Node[]): string[] {
  return nodes.map((node) => {
    if (node.type === 'paragraph') {
      if (!node.content?.length) return '<p></p>'
      return emitInline(node.content)
    }
    if (node.type === 'heading') {
      const level =
        node.attrs?.level === 2 || node.attrs?.level === 3
          ? node.attrs.level
          : 1
      return `${'#'.repeat(level)} ${emitInline(node.content ?? [])}`
    }
    if (
      node.type === 'bulletList' ||
      node.type === 'orderedList' ||
      node.type === 'taskList'
    ) {
      return emitList(node)
    }
    if (node.type === 'blockquote') {
      const inner = emitBlocks(node.content ?? [])
      if ((node.content ?? []).every((child) => child.type === 'paragraph')) {
        return inner
          .map((line) => (line === '<p></p>' ? '>' : `> ${line}`))
          .join('\n')
      }
      return `<blockquote>${inner.join('')}</blockquote>`
    }
    if (node.type === 'codeBlock') {
      const text = (node.content ?? [])
        .map((child) => child.text ?? '')
        .join('')
      if (
        node.attrs &&
        'language' in node.attrs &&
        typeof node.attrs.language !== 'string'
      ) {
        return `<pre data-language=""><code>${escapeText(text)}</code></pre>`
      }
      return `\`\`\`${attrString(node.attrs, 'language')}\n${text}\n\`\`\``
    }
    if (node.type === 'horizontalRule') return '---'
    if (node.type === 'table') return emitTable(node)
    return ''
  })
}

export function tiptapToMarkdown(value: Json) {
  const node = asNode(value)
  if (!node || node.type !== 'doc') return ''
  return emitBlocks(nodesOf(node.content as Json | undefined)).join('\n\n')
}

function withMark(nodes: Node[], mark: Mark): Node[] {
  return nodes.map((node) => ({
    ...node,
    marks: [...(node.marks ?? []), mark],
  }))
}

function parseInline(input: string): Node[] {
  const nodes: Node[] = []
  let i = 0
  const pushText = (text: string) => {
    if (!text) return
    const last = nodes[nodes.length - 1]
    if (last?.type === 'text' && !last.marks?.length) {
      last.text = `${last.text ?? ''}${text}`
      return
    }
    nodes.push({ type: 'text', text })
  }
  while (i < input.length) {
    const rest = input.slice(i)
    if (rest.startsWith('\\\n')) {
      nodes.push({ type: 'hardBreak' })
      i += 2
      continue
    }
    if (rest.startsWith('\\') && rest.length > 1) {
      pushText(rest[1] ?? '')
      i += 2
      continue
    }
    const mention =
      /^\[@((?:\\.|[^\]])*)\]\(atlas:\/\/user\/([^?\s)]+)(\?[^)\s]*)?\)/.exec(
        rest,
      )
    if (mention) {
      const attrs: Record<string, Json> = {
        id: decodeURIComponent(mention[2] ?? ''),
        label: unescapeText(mention[1] ?? ''),
      }
      const suggestion = new URLSearchParams(
        (mention[3] ?? '').replace(/^\?/, ''),
      ).get('mentionSuggestionChar')
      if (suggestion !== null) attrs.mentionSuggestionChar = suggestion
      nodes.push({ type: 'mention', attrs })
      i += mention[0].length
      continue
    }
    const date =
      /^\[((?:\\.|[^\]])*)\]\(atlas:\/\/date\/(\d{4}-\d{2}-\d{2})\)/.exec(rest)
    if (date) {
      nodes.push({ type: 'dateChip', attrs: { date: date[2] ?? '' } })
      i += date[0].length
      continue
    }
    const anchor = /^<a ([^>]*)>([\s\S]*?)<\/a>/.exec(rest)
    if (anchor) {
      nodes.push(
        ...withMark(parseInline(anchor[2] ?? ''), {
          type: 'link',
          attrs: linkAttrs(anchor[1] ?? ''),
        }),
      )
      i += anchor[0].length
      continue
    }
    const link = /^\[((?:\\.|[^\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)/.exec(rest)
    if (link && !link[2]?.startsWith('atlas://')) {
      nodes.push(
        ...withMark(parseInline(link[1] ?? ''), {
          type: 'link',
          attrs: { href: link[2] ?? '' },
        }),
      )
      i += link[0].length
      continue
    }
    const wrapped = matchWrapped(rest)
    if (wrapped) {
      nodes.push(
        ...withMark(parseInline(wrapped.inner), { type: wrapped.type }),
      )
      i += wrapped.length
      continue
    }
    if (rest.startsWith('&lt;')) {
      pushText('<')
      i += 4
      continue
    }
    if (rest.startsWith('&amp;')) {
      pushText('&')
      i += 5
      continue
    }
    pushText(rest[0] ?? '')
    i += 1
  }
  return nodes
}

function matchWrapped(rest: string) {
  const patterns: Array<{ type: string; open: string; close: string }> = [
    { type: 'underline', open: '<u>', close: '</u>' },
    { type: 'strike', open: '~~', close: '~~' },
    { type: 'bold', open: '**', close: '**' },
    { type: 'italic', open: '*', close: '*' },
    { type: 'code', open: '`', close: '`' },
  ]
  for (const pattern of patterns) {
    if (!rest.startsWith(pattern.open)) continue
    const end = rest.indexOf(pattern.close, pattern.open.length)
    if (end === -1) continue
    return {
      type: pattern.type,
      inner: rest.slice(pattern.open.length, end),
      length: end + pattern.close.length,
    }
  }
  return null
}

function linkAttrs(source: string) {
  const attrs: Record<string, Json> = {}
  const href = /\bhref="([^"]*)"/.exec(source)
  if (href) attrs.href = decodeAttr(href[1] ?? '')
  for (const key of ['target', 'rel', 'class', 'title']) {
    const found = new RegExp(`\\bdata-${key}="([^"]*)"`).exec(source)
    if (!found) continue
    attrs[key] = found[1] ? decodeAttr(found[1]) : null
  }
  return attrs
}

function paragraph(text: string): Node {
  const content = parseInline(text)
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function readAttrs(source: string) {
  const attrs: Record<string, Json> = {}
  const colspan = /\bcolspan="(\d+)"/.exec(source)
  const rowspan = /\browspan="(\d+)"/.exec(source)
  if (colspan) attrs.colspan = Number(colspan[1])
  if (rowspan) attrs.rowspan = Number(rowspan[1])
  const width = /\bdata-colwidth="([^"]*)"/.exec(source)
  if (width) {
    attrs.colwidth = width[1]
      ? width[1].split(',').map((item) => Number(item))
      : null
  }
  const align = /\bdata-align="([^"]*)"/.exec(source)
  if (align) attrs.align = align[1] ? decodeURIComponent(align[1]) : null
  return attrs
}

function parseHtmlTable(source: string): Node {
  const rows: Node[] = []
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(source))) {
    const cells: Node[] = []
    const cellRe = /<t([hd])([^>]*)>([\s\S]*?)<\/t\1>/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRe.exec(rowMatch[1] ?? ''))) {
      const inner = cellMatch[3] ?? ''
      const attrs = readAttrs(cellMatch[2] ?? '')
      const cell: Node = {
        type: cellMatch[1] === 'h' ? 'tableHeader' : 'tableCell',
        content: [paragraph(inner)],
      }
      if (Object.keys(attrs).length) cell.attrs = attrs
      cells.push(cell)
    }
    rows.push({ type: 'tableRow', content: cells })
  }
  return { type: 'table', content: rows }
}

function parseHtmlList(source: string): Node {
  const task = source.startsWith('<ul data-type="taskList">')
  const ordered = source.startsWith('<ol')
  const items: Node[] = []
  const itemRe = /<li([^>]*)>([\s\S]*?)<\/li>/g
  let match: RegExpExecArray | null
  while ((match = itemRe.exec(source))) {
    const checked = /\bdata-checked="true"/.test(match[1] ?? '')
    const inner = match[2] ?? ''
    const content = inner.startsWith('<p>')
      ? parseBlocks(inner.replace(/<\/?p>/g, '\n')).filter(
          (node) =>
            node.type !== 'paragraph' || node.content || inner !== '<p></p>',
        )
      : [paragraph(inner.replace(/^<p>|<\/p>$/g, ''))]
    const item: Node = {
      type: task ? 'taskItem' : 'listItem',
      content: content.length ? content : [{ type: 'paragraph' }],
    }
    if (task) item.attrs = { checked }
    items.push(item)
  }
  const node: Node = {
    type: task ? 'taskList' : ordered ? 'orderedList' : 'bulletList',
    content: items,
  }
  if (ordered) {
    const attrs: Record<string, Json> = {}
    const start = /\bdata-start="(\d+)"/.exec(source)
    const listType = /\bdata-list-type="([^"]*)"/.exec(source)
    if (start) attrs.start = Number(start[1])
    if (listType)
      attrs.type = listType[1] ? decodeURIComponent(listType[1]) : null
    if (Object.keys(attrs).length) node.attrs = attrs
  }
  return node
}

function splitPipes(line: string) {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (line[i] === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += line[i]
  }
  cells.push(current.trim())
  if (cells[0] === '') cells.shift()
  if (cells[cells.length - 1] === '') cells.pop()
  return cells
}

function isSeparator(line: string) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim())
}

function parseGfmTable(lines: string[]): Node {
  const header = splitPipes(lines[0] ?? '')
  const body = lines.slice(2)
  const row = (cells: string[], headerRow: boolean): Node => ({
    type: 'tableRow',
    content: cells.map((cell) => ({
      type: headerRow ? 'tableHeader' : 'tableCell',
      content: [paragraph(cell)],
    })),
  })
  return {
    type: 'table',
    content: [
      row(header, true),
      ...body.map((line) => row(splitPipes(line), false)),
    ],
  }
}

function parseBlocks(source: string): Node[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Node[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (line.startsWith('<table')) {
      const chunk: string[] = []
      while (i < lines.length) {
        chunk.push(lines[i] ?? '')
        if ((lines[i] ?? '').includes('</table>')) {
          i += 1
          break
        }
        i += 1
      }
      blocks.push(parseHtmlTable(chunk.join('\n')))
      continue
    }
    if (line.startsWith('<ul') || line.startsWith('<ol')) {
      const chunk: string[] = []
      while (i < lines.length) {
        chunk.push(lines[i] ?? '')
        if (/<\/(ul|ol)>/.test(lines[i] ?? '')) {
          i += 1
          break
        }
        i += 1
      }
      blocks.push(parseHtmlList(chunk.join('')))
      continue
    }
    if (line.startsWith('<blockquote>')) {
      const chunk: string[] = []
      while (i < lines.length) {
        chunk.push(lines[i] ?? '')
        if ((lines[i] ?? '').includes('</blockquote>')) {
          i += 1
          break
        }
        i += 1
      }
      const inner = chunk
        .join('\n')
        .replace(/^<blockquote>|<\/blockquote>$/g, '')
      blocks.push({ type: 'blockquote', content: parseBlocks(inner) })
      continue
    }
    if (line.startsWith('<pre')) {
      const chunk: string[] = []
      while (i < lines.length) {
        chunk.push(lines[i] ?? '')
        if ((lines[i] ?? '').includes('</pre>')) {
          i += 1
          break
        }
        i += 1
      }
      const html = chunk.join('\n')
      const language = /\bdata-language="([^"]*)"/.exec(html)
      const code = /<code>([\s\S]*?)<\/code>/.exec(html)
      const text = unescapeText(code?.[1] ?? '')
      const node: Node = {
        type: 'codeBlock',
        content: text ? [{ type: 'text', text }] : [],
      }
      if (language)
        node.attrs = { language: language[1] ? decodeAttr(language[1]) : null }
      blocks.push(node)
      continue
    }
    if (line === '<p></p>') {
      blocks.push({ type: 'paragraph' })
      i += 1
      continue
    }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const code: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        code.push(lines[i] ?? '')
        i += 1
      }
      i += 1
      const node: Node = {
        type: 'codeBlock',
        content: [{ type: 'text', text: code.join('\n') }],
      }
      if (language) node.attrs = { language }
      blocks.push(node)
      continue
    }
    const heading = /^(#{1,3}) (.*)$/.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        attrs: { level: heading[1]?.length ?? 1 },
        content: parseInline(heading[2] ?? ''),
      })
      i += 1
      continue
    }
    if (line === '---') {
      blocks.push({ type: 'horizontalRule' })
      i += 1
      continue
    }
    if (line.startsWith('|')) {
      const tableLines = [line]
      i += 1
      while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
        tableLines.push(lines[i] ?? '')
        i += 1
      }
      if (tableLines.length >= 2 && isSeparator(tableLines[1] ?? '')) {
        blocks.push(parseGfmTable(tableLines))
      } else {
        blocks.push(paragraph(tableLines.join('\n')))
      }
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        quoted.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({
        type: 'blockquote',
        content: parseBlocks(quoted.join('\n')),
      })
      continue
    }
    if (/^- \[[ x]\] /.test(line)) {
      const items: Node[] = []
      while (i < lines.length && /^- \[[ x]\] /.test(lines[i] ?? '')) {
        const current = lines[i] ?? ''
        items.push({
          type: 'taskItem',
          attrs: { checked: current.startsWith('- [x] ') },
          content: [paragraph(current.replace(/^- \[[ x]\] /, ''))],
        })
        i += 1
      }
      blocks.push({ type: 'taskList', content: items })
      continue
    }
    if (/^- /.test(line)) {
      const items: Node[] = []
      while (i < lines.length && /^- /.test(lines[i] ?? '')) {
        items.push({
          type: 'listItem',
          content: [paragraph((lines[i] ?? '').replace(/^- /, ''))],
        })
        i += 1
      }
      blocks.push({ type: 'bulletList', content: items })
      continue
    }
    if (/^\d+\. /.test(line)) {
      const items: Node[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? '')) {
        items.push({
          type: 'listItem',
          content: [paragraph((lines[i] ?? '').replace(/^\d+\. /, ''))],
        })
        i += 1
      }
      blocks.push({ type: 'orderedList', content: items })
      continue
    }
    const text: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !blockStart(lines[i] ?? '')
    ) {
      text.push(lines[i] ?? '')
      i += 1
    }
    blocks.push(paragraph(text.join('\n')))
  }
  return blocks
}

function blockStart(line: string) {
  return (
    line.startsWith('<') ||
    line.startsWith('```') ||
    line.startsWith('#') ||
    line === '---' ||
    line.startsWith('|') ||
    line.startsWith('>') ||
    /^- \[[ x]\] /.test(line) ||
    /^- /.test(line) ||
    /^\d+\. /.test(line)
  )
}

export function markdownToTiptap(markdown: string): Json {
  const content = parseBlocks(markdown)
  return {
    type: 'doc',
    content: content.length ? (content as Json[]) : [{ type: 'paragraph' }],
  }
}
