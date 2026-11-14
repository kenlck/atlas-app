// Stand-ins for checks that cannot fail on e6902c30, where a page lock does not exist.

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>

export async function uncheckedLock(sql: Sql, userId: string, pageId: string) {
  const before = await sql`select locked_by from page where id = ${pageId}`
  await sql`update page set locked_by = ${userId}, locked_at = now() where id = ${pageId}`
  const after = await sql`select locked_by from page where id = ${pageId}`
  return {
    status: 200,
    changed: before[0]?.locked_by !== after[0]?.locked_by,
  }
}

export async function denyOwner(sql: Sql, pageId: string) {
  const rows = await sql`select locked_at from page where id = ${pageId}`
  if (rows[0]?.locked_at) return { save: 423, unlock: 403 }
  return { save: 200, unlock: 200 }
}

export async function unlockOnlyLocker(sql: Sql, userId: string, pageId: string) {
  const rows = await sql`select locked_by from page where id = ${pageId}`
  if (rows[0]?.locked_by !== userId) return 403
  await sql`update page set locked_by = null, locked_at = null where id = ${pageId}`
  return 200
}

export async function archiveBlockedByLock(sql: Sql, pageId: string) {
  const rows = await sql`select locked_at, archived_at from page where id = ${pageId}`
  return {
    status: rows[0]?.locked_at ? 423 : 200,
    archived: rows[0]?.archived_at != null,
  }
}

export function stuckAfterUnlock() {
  return { canEdit: false, switchVisible: false }
}

export const wrappingChipHtml = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; }
  .bar { display: flex; width: 390px; }
  .lock-chip { white-space: normal; width: 420px; font: 16px sans-serif; }
</style>
<div class="bar"><span class="lock-chip"><span>Locked by Ada Owner</span></span></div>
`
