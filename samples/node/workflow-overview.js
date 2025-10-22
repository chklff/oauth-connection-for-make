'use strict';

/**
 *  MAKE CONNECTION WORKFLOW (ONE-PAGER)
 *
 *  This file is intentionally standalone and heavily commented so a developer can
 *  translate the logic to another language or platform without digging through
 *  the rest of the project. It mirrors the behaviour of the service in a
 *  streamlined, readable form.
 *
 *  The real implementation lives inside the src/ folder. This file keeps the
 *  same structure but swaps most implementation details for concise helpers and
 *  comments that describe the intent of each step.
 */

// ---------------------------------------------------------------------------
// 1. REQUIRED SETTINGS
// ---------------------------------------------------------------------------
const path = require('path');
const ROOT_DIR = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.resolve(ROOT_DIR, '.env') });
const fs = require('fs/promises');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const readline = require('readline');

const SETTINGS = {
  instanceUrl: process.env.INSTANCE_URL?.replace(/\/$/, ''),
  authToken: process.env.AUTH_TOKEN,
  teamId: process.env.TEAM_ID,
  blueprintDir: path.resolve(ROOT_DIR, 'blueprints'),
  updatedDir: __dirname,
  port: Number(process.env.PORT) || 777,
};

function ensureSettings() {
  const missing = Object.entries({
    INSTANCE_URL: SETTINGS.instanceUrl,
    AUTH_TOKEN: SETTINGS.authToken,
    TEAM_ID: SETTINGS.teamId,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 2. TOP-LEVEL WORKFLOW
// ---------------------------------------------------------------------------
/**
 *  runWorkflow
 *  ----------
 *  High-level orchestration that mirrors the production flow:
 *    - parse the blueprint and pick an app
 *    - collect required scopes for every relevant module
 *    - request the connection form and build the payload
 *    - create the connection + fetch consent URL
 *    - (optional) test the connection
 *    - save a remapped copy of the blueprint with the new connection id
 */
async function runWorkflow({ blueprintName, accountNameOverride }) {
  ensureSettings();

  const blueprint = await loadBlueprint(blueprintName);
  const { appName, moduleNames } = analyseBlueprint(blueprint);

  const appDefinition = await fetchJSON(`/api/v2/imt/apps/${appName}`);
  const scopes = collectScopes(appDefinition, moduleNames);

  const formSchema = await fetchJSON(`/api/v2/imt-forms/connections/create?type=${appName}&teamId=${SETTINGS.teamId}`);
  const payload = buildConnectionPayload({
    formSchema,
    appName,
    accountNameOverride,
    scopes,
  });

  const connection = await createConnection(payload);
  const consentUrl = await fetchConsentUrl(connection.id);

  const updatedBlueprintPath = await saveUpdatedBlueprint({
    originalName: blueprintName,
    blueprint,
    connectionId: connection.id,
  });

  return {
    connectionId: connection.id,
    consentUrl,
    payload,
    scopes,
    updatedBlueprintPath,
  };
}

// ---------------------------------------------------------------------------
// 3. BLUEPRINT HANDLING
// ---------------------------------------------------------------------------
async function loadBlueprint(name) {
  const candidates = [
    name,
    path.join(SETTINGS.blueprintDir, name || ''),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw new Error(`Blueprint not found: ${name}`);
}

function analyseBlueprint(blueprint) {
  /**
   *  Blueprints store modules inside the `flow` array. Each module has a string
   *  like "hubspotcrm:getContact". We gather every module, skip the Facebook
   *  helper app, and target the first remaining app.
   */
  const allModules = [];

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.module === 'string') {
        const [app, action] = node.module.split(':');
        if (app && action) {
          allModules.push({ app, action });
        }
      }
      Object.values(node).forEach(walk);
    }
  }

  walk(blueprint.flow);

  const filtered = allModules.filter(({ app }) => app !== 'facebook-conversion-leads');
  if (!filtered.length) {
    throw new Error('No eligible modules found in blueprint.');
  }

  const appName = filtered[0].app;
  const moduleNames = filtered.filter(({ app }) => app === appName).map(({ action }) => action);

  return { appName, moduleNames };
}

// ---------------------------------------------------------------------------
// 4. COLLECT SCOPES
// ---------------------------------------------------------------------------
function collectScopes(appDefinition, moduleNames) {
  /**
   *  The Make app definition groups modules into actions/searches/triggers.
   *  Each module has a `scopes` array that we merge together.
   */
  const buckets = ['actions', 'searches', 'triggers'];
  const lookup = new Map();

  buckets.forEach((bucket) => {
    const items = appDefinition.app?.[bucket] || [];
    items.forEach((item) => {
      if (item?.name) {
        lookup.set(item.name.toLowerCase(), item.scopes || item.scope || []);
      }
    });
  });

  const combined = new Set();
  moduleNames.forEach((name) => {
    const scopes = lookup.get(name.toLowerCase()) || [];
    scopes.forEach((scope) => combined.add(scope));
  });

  return [...combined];
}

// ---------------------------------------------------------------------------
// 5. BUILD CONNECTION PAYLOAD
// ---------------------------------------------------------------------------
function buildConnectionPayload({ formSchema, appName, accountNameOverride, scopes }) {
  /**
   *  The connection form schema describes all expected fields (accountName,
   *  accountType, property, custom scopes, etc.). We traverse the schema, fill
   *  defaults, apply overrides, and ensure required fields are not empty.
   */
  const fields = [];

  function collect(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (typeof node === 'object') {
      const identifier = typeof node.key === 'string' && node.key.length
        ? node.key
        : typeof node.name === 'string' && node.name.length
          ? node.name
          : null;
      const resolvedType = node.type || node?.templateOptions?.type;
      if (identifier && !['button', 'content', 'htmlelement'].includes(String(resolvedType || '').toLowerCase())) {
        const resolvedDefault = node.defaultValue !== undefined
          ? node.defaultValue
          : node?.templateOptions?.defaultValue !== undefined
            ? node.templateOptions.defaultValue
            : node?.templateOptions?.default !== undefined
              ? node.templateOptions.default
              : node.default !== undefined
                ? node.default
                : undefined;
        fields.push({
          key: identifier,
          defaultValue: resolvedDefault,
          type: resolvedType,
          data: node.data,
          templateOptions: node.templateOptions,
        });
      }

      Object.entries(node).forEach(([propKey, value]) => {
        if (propKey === 'components') {
          return;
        }
        if (propKey === 'options' && value && typeof value === 'object' && Array.isArray(value.store)) {
          const store = value.store;
          if (store.length) {
            const selected = store.find((option) => option && (option.default === true || option.selected === true)) || store[0];
            if (selected) {
              collect(selected);
            }
          }
          return;
        }
        if (propKey === 'nested' && Array.isArray(value)) {
          value.forEach((entry) => collect(entry));
          return;
        }
        collect(value);
      });
    }
  }

  collect(formSchema);

  const payload = {};
  fields.forEach((field) => {
    const { key, defaultValue } = field;
    payload[key] = defaultValue !== undefined ? defaultValue : getFieldFallback(field);
  });

  if (typeof payload.accountName === 'string' && /{{.*}}/.test(payload.accountName)) {
    payload.accountName = '';
  }

  payload.accountType = payload.accountType || appName;
  payload.accountName =
    accountNameOverride ||
    payload.accountName ||
    `${appName.replace(/[-_]/g, ' ')} connection`;

  payload.customScopes = scopes;
  if (!payload.customScopes.length) {
    console.warn('customScopes is empty; the connection may lack permissions.');
  }

  if ('property' in payload && !payload.property) {
    throw new Error('The Make API expects the property field for this connection.');
  }

  return payload;
}

function getFieldFallback(field) {
  const type = typeof field.type === 'string' ? field.type.toLowerCase() : '';
  const templateType = typeof field?.templateOptions?.type === 'string'
    ? field.templateOptions.type.toLowerCase()
    : '';
  if (type === 'boolean' || templateType === 'boolean') {
    return false;
  }

  const dataValue = pickOptionFallback(field);
  if (dataValue !== undefined) {
    return dataValue;
  }

  return '';
}

function pickOptionFallback(field) {
  const sources = [field?.data, field?.templateOptions].filter(Boolean);
  if (!sources.length) {
    return undefined;
  }

  for (const source of sources) {
    if (typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, 'defaultValue')) {
      return source.defaultValue;
    }
  }

  const optionLists = sources
    .flatMap((source) => (typeof source === 'object' ? extractOptionLists(source) : []));
  if (!optionLists.length) {
    return undefined;
  }

  const flattened = optionLists.flat();
  const preferred = flattened.find((option) => option && typeof option === 'object' && option.default === true)
    || flattened.find((option) => option && typeof option === 'object' && option.selected === true);

  const firstOption = preferred || flattened.find((option) => {
    if (option === null || option === undefined) {
      return false;
    }
    if (typeof option === 'object') {
      return option.value !== undefined || option.id !== undefined || option.code !== undefined;
    }
    return true;
  });

  if (!firstOption) {
    return undefined;
  }

  if (typeof firstOption === 'object') {
    return firstOption.value ?? firstOption.id ?? firstOption.code;
  }
  return firstOption;
}

function extractOptionLists(source) {
  if (!source || typeof source !== 'object') {
    return [];
  }

  const lists = [];
  ['options', 'values', 'items', 'enum'].forEach((key) => {
    const value = source[key];
    if (Array.isArray(value) && value.length) {
      lists.push(value);
    } else if (value && typeof value === 'object' && Array.isArray(value.store) && value.store.length) {
      lists.push(value.store);
    }
  });
  return lists;
}

// ---------------------------------------------------------------------------
// 6. MAKE API CALLS
// ---------------------------------------------------------------------------
async function createConnection(payload) {
  const body = JSON.stringify(payload);
  const response = await fetchJSON(`/api/v2/connections?teamId=${SETTINGS.teamId}&inspector=0`, {
    method: 'POST',
    body,
  });
  const connection = response?.connection || response;
  if (!connection || !connection.id) {
    throw new Error(`Connection response missing id: ${JSON.stringify(response)}`);
  }
  return connection;
}

async function fetchConsentUrl(connectionId) {
  const response = await fetchRaw(`/api/v2/oauth/auth/${connectionId}`, {
    method: 'GET',
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  if (!location) {
    throw new Error('Consent URL missing in response headers.');
  }
  return location;
}

async function testConnection(connectionId) {
  return fetchJSON(`/api/v2/connections/${connectionId}/test`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// 7. UPDATED BLUEPRINT SAVING
// ---------------------------------------------------------------------------
async function saveUpdatedBlueprint({ originalName, blueprint, connectionId }) {
  const clone = JSON.parse(JSON.stringify(blueprint));
  let updated = 0;

  function rewrite(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(rewrite);
      return;
    }
    if (typeof node === 'object') {
      if (
        typeof node.module === 'string' &&
        !node.module.startsWith('facebook-conversion-leads')
      ) {
        if (node.parameters && node.parameters.__IMTCONN__) {
          node.parameters.__IMTCONN__ = connectionId;
          updated += 1;
        }
      }
      Object.keys(node).forEach((key) => rewrite(node[key]));
    }
  }

  rewrite(clone.flow);

  await fs.mkdir(SETTINGS.updatedDir, { recursive: true });
  const baseName = path.basename(originalName, path.extname(originalName) || '.json');
  const targetPath = path.join(
    SETTINGS.updatedDir,
    `${baseName}-updated.json`
  );
  await fs.writeFile(targetPath, `${JSON.stringify(clone, null, 4)}\n`);

  console.log(`Updated ${updated} module(s) in ${targetPath}`);
  return targetPath;
}

// ---------------------------------------------------------------------------
// 8. LIGHTWEIGHT FETCH HELPERS
// ---------------------------------------------------------------------------
async function fetchJSON(relativeUrl, init = {}) {
  const response = await fetchRaw(relativeUrl, init);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON from ${relativeUrl} but received: ${text}`);
  }
}

function fetchRaw(relativeUrl, init = {}) {
  const url = `${SETTINGS.instanceUrl}${relativeUrl}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Token ${SETTINGS.authToken}`,
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// 9. SAMPLE USAGE
// ---------------------------------------------------------------------------
/**
 *  This block is optional. It demonstrates how to invoke the workflow directly
 *  from the command line:
 *
 *    node docs/workflow-overview.js "Hubspot - FBcapi.json" "My Friendly Name"
 */
function launchBrowser(url) {
  const platform = process.platform;
  const escape = (value) => value.replace(/"/g, '\\"');

  const attempts =
    platform === 'darwin'
      ? [
          { command: '/usr/bin/open', args: [url] },
          { command: '/usr/bin/open', args: ['-g', url] },
          { command: '/usr/bin/osascript', args: ['-e', `open location "${escape(url)}"`] },
        ]
      : platform === 'win32'
        ? [
            { command: 'cmd', args: ['/c', 'start', '', url] },
            { command: 'powershell', args: ['-NoProfile', 'Start-Process', url] },
          ]
        : [
            { command: 'xdg-open', args: [url] },
            { command: 'gio', args: ['open', url] },
            { command: 'gnome-open', args: [url] },
          ];

  function tryNext(list) {
    if (!list.length) {
      console.warn('Unable to launch browser automatically. Open the consent URL manually.');
      return;
    }

    const { command, args } = list[0];
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => tryNext(list.slice(1)));
      child.on('exit', (code) => {
        if (code === 0 || code === null) {
          child.unref();
        } else {
          tryNext(list.slice(1));
        }
      });
      child.unref();
    } catch (error) {
      tryNext(list.slice(1));
    }
  }

  tryNext(attempts);
}

function waitForEnter(message) {
  if (!process.stdin.isTTY) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

if (require.main === module) {
  const [blueprintName, accountNameOverride] = process.argv.slice(2);

  if (!blueprintName) {
    console.error('Usage: node workflow-overview.js <blueprint.json> [accountName]');
    process.exit(1);
  }

  runWorkflow({ blueprintName, accountNameOverride })
    .then(async (result) => {
      console.log('Connection created:', result.connectionId);
      console.log('Consent URL:', result.consentUrl);
      console.log('Updated blueprint:', result.updatedBlueprintPath);
      launchBrowser(result.consentUrl);
      console.log('If the consent page did not open automatically, open the URL above in your browser.');
      await waitForEnter('Complete the consent flow, then press Enter to trigger the Make test...');
      const testResponse = await testConnection(result.connectionId);
      console.log('Test response:', JSON.stringify(testResponse, null, 2));
    })
    .catch((error) => {
      console.error('Workflow failed:', error);
      process.exit(1);
    });
}

module.exports = {
  runWorkflow,
  testConnection,
};
