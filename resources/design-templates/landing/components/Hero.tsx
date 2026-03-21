export default function Hero() {
  return (
    <section className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <h1 className="text-5xl font-bold tracking-tight mb-4">
        Build Something Amazing
      </h1>
      <p className="text-lg text-gray-500 max-w-xl mb-8">
        A modern landing page template with clean sections. Customize this to showcase your product.
      </p>
      <div className="flex gap-3">
        <button className="px-6 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
          Get Started
        </button>
        <button className="px-6 py-3 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">
          Learn More
        </button>
      </div>
    </section>
  )
}
