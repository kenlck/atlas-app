const KEY = 'atlas.sidebar.collapsed'

export function readSidebarCollapsed() {
  if (typeof sessionStorage === 'undefined') return false
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(collapsed: boolean) {
  try {
    sessionStorage.setItem(KEY, collapsed ? '1' : '0')
  } catch {
    // Ignore storage failures.
  }
}
