/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Playwright is native/CJS-heavy and does its own dynamic requires - let API routes
  // `require()` it directly at runtime instead of having webpack try (and fail) to bundle it.
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
