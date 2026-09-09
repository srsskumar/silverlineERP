/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  // Static export for Cloudflare Pages (hard constraint — do not remove).
  // Export mode is ON for verification/production builds only. It MUST stay
  // OFF in `next dev`: with `output: 'export'`, dev 500s every dynamic route
  // whose param is not in generateStaticParams (all real [id] URLs).
  // Verification builds (NEXT_VERIFY_BUILD=1) use an isolated directory so
  // `next build` never poisons the running dev server's `.next`.
  ...(process.env.NEXT_VERIFY_BUILD === '1'
    ? { output: 'export', distDir: '.next-verify' }
    : {}),
};

module.exports = nextConfig;
