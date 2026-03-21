import StatCard from '../components/StatCard'

export default function Dashboard() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Overview</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Users" value="12,345" change="+12% from last month" />
        <StatCard title="Revenue" value="$48,200" change="+8% from last month" />
        <StatCard title="Orders" value="1,024" change="+3% from last month" />
        <StatCard title="Active Now" value="573" />
      </div>
    </div>
  )
}
