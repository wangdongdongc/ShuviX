import { Outlet, NavLink } from 'react-router'

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/analytics', label: 'Analytics' },
  { to: '/settings', label: 'Settings' }
]

export default function App() {
  return (
    <div className="min-h-screen flex bg-gray-50">
      <aside className="w-56 bg-white border-r border-gray-200 p-4 flex flex-col gap-1">
        <h1 className="text-lg font-bold px-3 py-2 mb-2">Dashboard</h1>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `block px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  )
}
