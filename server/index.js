import { config, validateConfig } from './config.js';
import app from './app.js';

try {
  validateConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`ActiveDev server running on port ${config.port}`);
  console.log(`Public URL: ${config.publicUrl}`);
  console.log(`GitHub App: ${config.github.appName}`);
});
