const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');

const BASE_HEADERS = {
  'Content-Type': 'application/json',
};

function getAuthHeaders() {
  return {
    ...BASE_HEADERS,
    Authorization: `Token ${config.authToken}`,
  };
}

async function handleResponse(response, context) {
  if (!response.ok) {
    const text = await response.text();
    const message = `Request to ${context} failed with status ${response.status}: ${text}`;
    throw new Error(message);
  }
  if (response.status === 204) {
    return null;
  }
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function fetchAppDefinition(appName) {
  const url = `${config.instanceUrl}/api/v2/imt/apps/${encodeURIComponent(appName)}`;
  logger.step(`Fetching app definition for "${appName}" from ${url}`);
  const response = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse(response, `/v2/imt/apps/${appName}`);
  logger.success(`Retrieved app definition for "${appName}"`);
  return data;
}

function normaliseName(name) {
  if (typeof name !== 'string') {
    return '';
  }
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scopesForModules(appDefinition, moduleNames) {
  const app = appDefinition.app || {};
  const buckets = ['actions', 'searches', 'triggers'];
  const scopeSet = new Set();
  logger.info(`Collecting scopes for modules: ${moduleNames.join(', ')}`);
  const available = buckets.reduce((acc, bucket) => {
    const entries = Array.isArray(app[bucket]) ? app[bucket].map((item) => item?.name).filter(Boolean) : [];
    acc[bucket] = entries;
    return acc;
  }, {});
  const lookup = buckets.reduce((acc, bucket) => {
    const items = Array.isArray(app[bucket]) ? app[bucket] : [];
    items.forEach((item) => {
      if (item && item.name) {
        acc[normaliseName(item.name)] = item;
      }
    });
    return acc;
  }, {});

  moduleNames.forEach((moduleName) => {
    const normalised = normaliseName(moduleName);
    const match = lookup[normalised];
    if (match) {
      const scopesRaw = match.scopes || match.scope || [];
      const scopes = Array.isArray(scopesRaw) ? scopesRaw : [scopesRaw].filter(Boolean);
      if (scopes.length === 0) {
        logger.error(`Module "${moduleName}" matched "${match.name}" but response has an empty scopes array. Raw definition: ${JSON.stringify(match, null, 2)}`);
      } else {
        logger.info(`Module "${moduleName}" scopes: ${scopes.join(', ')}`);
      }
      scopes.forEach((scope) => scopeSet.add(scope));
    } else {
      logger.warn(`Module "${moduleName}" not found in app definition buckets. Available ${bucketSummary(available)}.`);
    }
  });

  const scopes = [...scopeSet];
  if (scopes.length === 0) {
    logger.warn(`No scopes collected for modules [${moduleNames.join(', ')}]. Verify module names or blueprint contents.`);
  } else {
    logger.success(`Collected ${scopes.length} unique scopes: ${scopes.join(', ')}`);
  }
  return scopes;
}

function bucketSummary(available) {
  return Object.entries(available)
    .map(([bucket, names]) => `${bucket}: ${names.slice(0, 10).join(', ') || 'none'}`)
    .join(' | ');
}

async function fetchConnectionForm(appName) {
  const url = `${config.instanceUrl}/api/v2/imt-forms/connections/create?type=${encodeURIComponent(appName)}&teamId=${encodeURIComponent(config.teamId)}`;
  logger.step(`Fetching connection form for "${appName}" from ${url}`);
  const response = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse(response, '/api/v2/imt-forms/connections/create');
  logger.success(`Retrieved connection form for "${appName}"`);
  return data;
}

async function createConnection(payload) {
  const url = `${config.instanceUrl}/api/v2/connections?teamId=${encodeURIComponent(config.teamId)}&inspector=0`;
  logger.step(`Creating connection via ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await handleResponse(response, '/api/v2/connections');
  const connection = data && data.connection ? data.connection : data;
  if (!connection || !connection.id) {
    throw new Error(`Connection response missing id: ${JSON.stringify(data)}`);
  }
  logger.success(`Connection created with id ${connection.id}`);
  return { connection, raw: data };
}

async function fetchConsentUrl(connectionId) {
  const url = `${config.instanceUrl}/api/v2/oauth/auth/${encodeURIComponent(connectionId)}`;
  logger.step(`Requesting consent URL for connection ${connectionId}`);
  const response = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders(),
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`Consent URL not provided for connection ${connectionId}`);
  }
  logger.success(`Obtained consent URL for connection ${connectionId}`);
  return location;
}

async function testConnection(connectionId) {
  const url = `${config.instanceUrl}/api/v2/connections/${encodeURIComponent(connectionId)}/test`;
  logger.step(`Testing connection ${connectionId}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse(response, `/api/v2/connections/${connectionId}/test`);
  logger.success(`Test completed for connection ${connectionId}`);
  if (data && typeof data === 'object') {
    logger.info(`Test response payload: ${JSON.stringify(data, null, 2)}`);
  } else {
    logger.warn('Test response did not return JSON data.');
  }
  return data;
}

module.exports = {
  fetchAppDefinition,
  scopesForModules,
  fetchConnectionForm,
  createConnection,
  fetchConsentUrl,
  testConnection,
};
