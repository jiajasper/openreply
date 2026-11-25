import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  // No marketing landing page: the root is an entry point into the app, not a
  // pitch. Runs before `proxy.ts`, so an unauthenticated visitor is bounced
  // straight to the login screen and never renders a dashboard frame.
  // Temporary (307) rather than permanent, so restoring a landing page later
  // is not defeated by browsers that cached the 308.
  async redirects() {
    return [
      {
        source: "/",
        destination: "/dashboard",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
