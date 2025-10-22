const config = require('../config');
const logger = require('../utils/logger');
const { BlueprintError } = require('../services/blueprintService');
const { runConnectionWorkflow } = require('../services/workflowService');
const { testConnection } = require('../services/makeService');

async function createConnectionHandler(req, res) {
  try {
    const { blueprint: blueprintName, overrides = {}, accountName } = req.body || {};

    const result = await runConnectionWorkflow({
      blueprint: blueprintName,
      accountName,
      overrides,
    });

    return res.json({
      url: result.consentUrl,
      connectionId: result.connectionId,
      connection: result.connection,
      app: result.appName,
      modules: result.moduleNames,
      scopes: result.scopes,
      updatedBlueprint: result.updatedBlueprintPath,
      updatedModules: result.updatedModules,
    });
  } catch (error) {
    if (error instanceof BlueprintError) {
      logger.error(error.message);
      return res.status(400).json({ message: error.message });
    }
    if (error.message && error.message.includes('Required field "property"')) {
      return res.status(400).json({ message: error.message });
    }
    logger.error(error.message);
    return res.status(500).json({ message: 'Server error', details: error.message });
  }
}

async function testConnectionHandler(req, res) {
  try {
    config.ensureRequiredConfig();
    const { connection } = req.body || {};
    if (!connection) {
      return res.status(400).json({ message: 'Connection id is required.' });
    }
    const result = await testConnection(connection);
    return res.json({ result });
  } catch (error) {
    logger.error(error.message);
    return res.status(500).json({ message: 'Server error', details: error.message });
  }
}

async function startConnectionFlowHandler(req, res) {
  try {
    const { blueprint, accountName } = req.body || {};
    const result = await runConnectionWorkflow({
      blueprint,
      accountName,
    });
    logger.success(`Redirecting to consent URL for connection ${result.connectionId}`);
    if (result.updatedBlueprintPath) {
      logger.success(`Updated blueprint saved to ${result.updatedBlueprintPath}`);
    }
    return res.redirect(result.consentUrl);
  } catch (error) {
    if (error instanceof BlueprintError) {
      logger.error(error.message);
      return res.status(400).send(error.message);
    }
    if (error.message && error.message.includes('Required field "property"')) {
      logger.error(error.message);
      return res.status(400).send(error.message);
    }
    logger.error(error.message);
    return res.status(500).send('Server error');
  }
}

module.exports = {
  createConnectionHandler,
  testConnectionHandler,
  startConnectionFlowHandler,
};
