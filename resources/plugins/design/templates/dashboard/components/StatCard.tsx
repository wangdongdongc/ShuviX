interface StatCardProps {
  title: string
  value: string
  change?: string
}

export default function StatCard({ title, value, change }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
      <p className="text-sm text-gray-500 mb-1">{title}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {change && (
        <p className="text-xs text-green-600 mt-1">{change}</p>
      )}
    </div>
  )
}
