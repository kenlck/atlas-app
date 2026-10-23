import type { ReactNode } from 'react'

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="card">
        <div className="logo">
          <i />
          Atlas
        </div>
        {children}
      </div>
    </div>
  )
}
