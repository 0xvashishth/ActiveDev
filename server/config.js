const config = {
  port: parseInt(process.env.PORT, 10) || 3000,

  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },

  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${parseInt(process.env.PORT, 10) || 3000}`).replace(/\/+$/, ''),

  stateTtlMs: 10 * 60 * 1000,

  rateLimit: {
    windowMs: 60 * 1000,
    maxRequests: 30,
  },
};

function validateConfig() {
  const missing = [];
  if (!config.github.clientId) missing.push('GITHUB_CLIENT_ID');
  if (!config.github.clientSecret) missing.push('GITHUB_CLIENT_SECRET');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!config.publicUrl.startsWith('https://') && !config.publicUrl.startsWith('http://localhost')) {
    console.warn('Warning: PUBLIC_URL should be HTTPS in production for security.');
  }
}

export { config, validateConfig };
