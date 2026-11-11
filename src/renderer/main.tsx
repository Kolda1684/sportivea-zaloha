import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './Shell'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)
