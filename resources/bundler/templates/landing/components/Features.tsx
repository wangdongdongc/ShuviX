const features = [
  { title: 'Fast', desc: 'Optimized for speed and performance out of the box.' },
  { title: 'Flexible', desc: 'Easily customize and extend to fit your needs.' },
  { title: 'Reliable', desc: 'Built with best practices for production use.' }
]

export default function Features() {
  return (
    <section className="px-6 py-20 bg-gray-50">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">Features</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {features.map((f) => (
            <div key={f.title} className="bg-white rounded-xl p-6 shadow-sm">
              <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
