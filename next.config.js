/** @type {import('next').NextConfig} */
module.exports = {
  experimental: { serverComponentsExternalPackages: ['playwright', '@react-pdf/renderer'] },
  // The marketing page is a static file (public/landing.html) so design changes do not need
  // a rebuild. Serve it AT "/" rather than redirecting there, so the address bar stays on the
  // bare domain. There is deliberately no app route for "/", which is what lets this rewrite
  // take effect.
  async rewrites() {
    return [{ source: '/', destination: '/landing.html' }];
  },
};
