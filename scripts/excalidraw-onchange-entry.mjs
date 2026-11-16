import React from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw } from '@excalidraw/excalidraw'

const initial = JSON.parse(document.getElementById('initial').textContent)
createRoot(document.getElementById('root')).render(
  React.createElement(Excalidraw, {
    initialData: {
      elements: initial.elements,
      appState: initial.appState ?? {},
    },
    onChange: (elements) => {
      window.__changed = JSON.parse(JSON.stringify(elements))
    },
  }),
)
