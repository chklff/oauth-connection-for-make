const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const env = process.env;

const config = {
  instanceUrl: env.INSTANCE_URL ? env.INSTANCE_URL.replace(/\/$/, '') : null,
  authToken: env.AUTH_TOKEN || null,
  teamId: env.TEAM_ID || null,
  accountName: env.ACCOUNT_NAME || null,
  accountType: env.ACCOUNT_TYPE || null,
  property: env.PROPERTY || null,
  host: env.HOST || 'http://localhost',
  port: Number(env.PORT) || 777,
  blueprintDir: path.resolve(rootDir, 'blueprints'),
  updatedBlueprintDir: path.resolve(rootDir, 'Updated Blueprints'),
  defaultBlueprint: env.BLUEPRINT_FILE || null,
};

function ensureRequiredConfig() {
  const missing = [];
  if (!config.instanceUrl) missing.push('INSTANCE_URL');
  if (!config.authToken) missing.push('AUTH_TOKEN');
  if (!config.teamId) missing.push('TEAM_ID');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = {
  ...config,
  rootDir,
  ensureRequiredConfig,
};
