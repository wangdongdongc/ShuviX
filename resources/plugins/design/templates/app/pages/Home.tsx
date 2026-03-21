import { useState } from 'react'
import Button from '../components/Button'

export default function Home() {
  const [count, setCount] = useState(0)

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8">
      <h1 className="text-3xl font-bold">Design Preview</h1>
      <p className="text-gray-500">
        Edit files in <code className="bg-gray-200 px-1.5 py-0.5 rounded text-sm">.shuvix/design/</code> to see changes in real-time.
      </p>
      <div className="flex items-center gap-3">
        <Button onClick={() => setCount((c) => c + 1)}>
          Count: {count}
        </Button>
        <Button variant="secondary" onClick={() => setCount(0)}>
          Reset
        </Button>
      </div>
    </div>
  )
}
