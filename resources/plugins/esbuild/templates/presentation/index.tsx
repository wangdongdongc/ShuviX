import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <pre
          style={{
            color: '#f38ba8',
            background: '#1e1e2e',
            padding: '2rem',
            margin: 0,
            height: '100%',
            fontSize: '13px',
            overflow: 'auto',
          }}
        >
          <b>React Rendering Error</b>
          {'\n\n'}
          {this.state.error.stack || this.state.error.message}
        </pre>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
