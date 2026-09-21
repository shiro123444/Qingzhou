import { networkInterfaces } from 'node:os';

import { defineConfig } from './src/libs/next/config/define-config';

const isVercel = !!process.env.VERCEL_ENV;

const vercelConfig = {
  // Vercel serverless optimization: exclude musl binaries from all routes
  // Vercel uses Amazon Linux (glibc), not Alpine Linux (musl)
  // This saves ~45MB (29MB canvas-musl + 16MB sharp-musl) per serverless function
  outputFileTracingExcludes: {
    '*': [
      'node_modules/.pnpm/@napi-rs+canvas-*-musl*',
      'node_modules/.pnpm/@img+sharp-libvips-*musl*',
      // Exclude SPA/desktop/mobile build artifacts from serverless functions
      'public/_spa/**',
      'dist/desktop/**',
      'dist/mobile/**',
      'apps/desktop/**',
      'packages/database/migrations/**',
    ],
  },
};

const getLocalIPs = () => {
  const ips = ['localhost', '127.0.0.1'];
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          ips.push(net.address);
        }
      }
    }
  } catch (error) {
    console.warn('[next.config] Failed to get local IPs:', error);
  }
  return ips;
};

const nextConfig = defineConfig({
  ...(isVercel ? vercelConfig : {}),
  experimental: {
    // PPTX templates allow 100 MiB files. Leave bounded multipart overhead so
    // Next's proxy does not truncate an otherwise valid upload.
    proxyClientMaxBodySize: '110mb',
  },
});

if (process.env.NODE_ENV === 'development') {
  const allowedOrigins = getLocalIPs();
  (nextConfig as any).allowedDevOrigins = allowedOrigins;
}

export default nextConfig;
