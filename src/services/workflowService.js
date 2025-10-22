const config = require('../config');
const logger = require('../utils/logger');
const { analyseBlueprint, saveUpdatedBlueprint } = require('./blueprintService');
const {
  fetchAppDefinition,
  scopesForModules,
  fetchConnectionForm,
  createConnection,
  fetchConsentUrl,
} = require('./makeService');
const { buildSpec } = require('./connectionSpecService');

function maskSensitive(payload) {
  const sensitivePattern = /(secret|token|key|password)/i;
  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (sensitivePattern.test(key)) {
      acc[key] = value ? '***redacted***' : value;
    } else if (Array.isArray(value)) {
      acc[key] = value;
    } else if (value && typeof value === 'object') {
      acc[key] = maskSensitive(value);
    } else {
      acc[key] = value;
    }
    return acc;
  }, {});
}

async function runConnectionWorkflow(options = {}) {
  config.ensureRequiredConfig();

  const {
    blueprint: providedBlueprint,
    accountName,
    overrides = {},
  } = options;

  const selectedBlueprint = providedBlueprint || config.defaultBlueprint;

  logger.step('Starting connection workflow');
  const analysis = await analyseBlueprint(selectedBlueprint);
  const { appName, moduleNames } = analysis.summary;

  const appDefinition = await fetchAppDefinition(appName);
  const scopes = scopesForModules(appDefinition, moduleNames);

  logger.step(`Fetching connection form schema for "${appName}"`);
  const formSchema = await fetchConnectionForm(appName);

  const mergedOverrides = { ...overrides };
  if (accountName) {
    mergedOverrides.accountName = accountName;
  }

  const payload = buildSpec(formSchema, appName, scopes, mergedOverrides);
  logger.info(`Connection spec payload:\n${JSON.stringify(maskSensitive(payload), null, 2)}`);

  logger.step(`Submitting connection creation for "${payload.accountName}"`);
  const createResponse = await createConnection(payload);
  const connection = createResponse?.connection;

  if (!connection) {
    throw new Error('Connection response did not include a connection object.');
  }

  const consentUrl = await fetchConsentUrl(connection.id);
  const updateResult = await saveUpdatedBlueprint(
    selectedBlueprint,
    analysis.blueprint,
    connection.id,
    config.updatedBlueprintDir,
  );

  return {
    consentUrl,
    connectionId: connection.id,
    spec: payload,
    connection,
    scopes,
    appName,
    moduleNames,
    blueprint: selectedBlueprint,
    updatedBlueprintPath: updateResult.targetPath,
    updatedModules: updateResult.updatedCount,
  };
}

module.exports = {
  runConnectionWorkflow,
};
