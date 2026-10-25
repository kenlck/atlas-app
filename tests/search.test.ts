import { describe, expect, it } from 'vitest'
import { getSql } from '../src/lib/db'
import { archivePage, createPage, savePage } from '../src/lib/pages'
import { searchVisiblePages } from '../src/lib/search'
import { acceptInvite, createInvite, createTeam } from '../src/lib/teams'
import { createUser } from './helpers'

function paragraph(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

describe('searchVisiblePages', () => {
  it('returns only pages the caller can open', async () => {
    const ada = await createUser('Ada Search')
    const bea = await createUser('Bea Search')
    const alpha = await createTeam(ada.user.id, 'Alpha Search')
    const beta = await createTeam(bea.user.id, 'Beta Search')
    const token = `vis-${crypto.randomUUID().slice(0, 8)}`
    const teamPage = await createPage(ada.user.id, {
      spaceId: alpha.spaceId,
      title: `${token}-team`,
    })
    await createPage(bea.user.id, {
      spaceId: beta.spaceId,
      title: `${token}-other-team`,
    })
    const personal = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      title: `${token}-personal`,
    })
    const archived = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      title: `${token}-archived`,
    })
    const child = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      parentId: archived.id,
      title: `${token}-child`,
    })
    await archivePage(ada.user.id, archived.id)

    const beaHits = await searchVisiblePages(bea.user.id, token)
    expect(beaHits.map((hit) => hit.id)).not.toContain(teamPage.id)
    expect(beaHits.map((hit) => hit.id)).not.toContain(personal.id)
    expect(beaHits.map((hit) => hit.id)).not.toContain(archived.id)
    expect(beaHits.map((hit) => hit.id)).not.toContain(child.id)
    expect(beaHits.map((hit) => hit.title)).toContain(`${token}-other-team`)

    const adaHits = await searchVisiblePages(ada.user.id, token)
    expect(adaHits.map((hit) => hit.id)).toEqual(
      expect.arrayContaining([teamPage.id, personal.id]),
    )
    expect(adaHits.map((hit) => hit.id)).not.toContain(archived.id)
    expect(adaHits.map((hit) => hit.id)).not.toContain(child.id)
  })

  it('matches % _ and backslash literally', async () => {
    const owner = await createUser('Wildcard')
    const stamp = crypto.randomUUID().slice(0, 8)
    const percent = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: `${stamp} 100%`,
    })
    const percentWide = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: `${stamp} 100x`,
    })
    const underscore = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: `${stamp} a_b`,
    })
    const underscoreWide = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: `${stamp} axb`,
    })
    const slash = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: `${stamp} a\\b`,
    })
    const slashWide = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: `${stamp} ab`,
    })

    const percentHits = await searchVisiblePages(owner.user.id, `${stamp} 100%`)
    expect(percentHits.map((hit) => hit.id)).toEqual([percent.id])
    expect(percentHits.map((hit) => hit.id)).not.toContain(percentWide.id)

    const underscoreHits = await searchVisiblePages(
      owner.user.id,
      `${stamp} a_b`,
    )
    expect(underscoreHits.map((hit) => hit.id)).toEqual([underscore.id])
    expect(underscoreHits.map((hit) => hit.id)).not.toContain(underscoreWide.id)

    const slashHits = await searchVisiblePages(owner.user.id, `${stamp} a\\b`)
    expect(slashHits.map((hit) => hit.id)).toEqual([slash.id])
    expect(slashHits.map((hit) => hit.id)).not.toContain(slashWide.id)

    expect(await searchVisiblePages(owner.user.id, '%')).toEqual([])
    expect(await searchVisiblePages(owner.user.id, '_')).toEqual([])
  })

  it('finds a body_text match and ignores queries under two characters', async () => {
    const owner = await createUser('Body')
    const token = `body-${crypto.randomUUID().slice(0, 8)}`
    const page = await savePage(owner.user.id, {
      pageId: (
        await createPage(owner.user.id, {
          spaceId: owner.space.id,
          title: 'Quarter notes',
        })
      ).id,
      title: 'Quarter notes',
      body: paragraph(token),
    })
    const hits = await searchVisiblePages(owner.user.id, token)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe(page.id)
    expect(hits[0]?.group).toBe('content')
    expect(hits[0]?.snippet).toContain(token)
    expect(await searchVisiblePages(owner.user.id, 'Q')).toEqual([])
    expect(await searchVisiblePages(owner.user.id, '   ')).toEqual([])
  })

  it('ranks a title match ahead of a newer content match', async () => {
    const owner = await createUser('Rank')
    const token = `rank-${crypto.randomUUID().slice(0, 8)}`
    const titled = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: `${token} title`,
    })
    const body = await savePage(owner.user.id, {
      pageId: (
        await createPage(owner.user.id, {
          spaceId: owner.space.id,
          title: 'Other page',
        })
      ).id,
      title: 'Other page',
      body: paragraph(`${token} in the body`),
    })
    await getSql()`
      update page set updated_at = '2020-01-01' where id = ${titled.id}
    `
    await getSql()`
      update page set updated_at = '2024-06-01' where id = ${body.id}
    `
    const hits = await searchVisiblePages(owner.user.id, token)
    expect(hits.map((hit) => hit.id)).toEqual([titled.id, body.id])
    expect(hits[0]?.group).toBe('title')
    expect(hits[1]?.group).toBe('content')
    expect(
      hits[1]?.snippet.startsWith('…') || hits[1]?.snippet.includes(token),
    ).toBe(true)
  })

  it('finds table, mention, and date labels saved on the page', async () => {
    const owner = await createUser('Owner Label')
    const member = await createUser('Nia Quill')
    const team = await createTeam(owner.user.id, 'Label Team')
    const invite = await createInvite(owner.user.id, team.id, member.user.id)
    await acceptInvite(member.user.id, invite.id)
    const saved = await savePage(owner.user.id, {
      pageId: (
        await createPage(owner.user.id, {
          spaceId: team.spaceId,
          title: 'Labels',
        })
      ).id,
      title: 'Labels',
      body: {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'widget-cell' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'paragraph',
            content: [
              {
                type: 'mention',
                attrs: { id: member.user.id, label: 'Nia Quill' },
              },
              { type: 'text', text: ' ' },
              { type: 'dateChip', attrs: { date: '2024-08-19' } },
            ],
          },
        ],
      },
    })
    const tableHits = await searchVisiblePages(owner.user.id, 'widget-cell')
    const mentionHits = await searchVisiblePages(owner.user.id, 'Nia Quill')
    const dateHits = await searchVisiblePages(owner.user.id, 'Aug 19, 2024')
    expect(tableHits.map((hit) => hit.id)).toContain(saved.id)
    expect(mentionHits.map((hit) => hit.id)).toContain(saved.id)
    expect(dateHits.map((hit) => hit.id)).toContain(saved.id)
  })
})
