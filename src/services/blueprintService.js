const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

class BlueprintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlueprintError';
  }
}

async function loadBlueprint(blueprintName) {
  if (!blueprintName) {
    throw new BlueprintError('Blueprint name not provided. Include it in the request body or set BLUEPRINT_FILE in the environment.');
  }

  const sanitized = path.basename(blueprintName);
  const blueprintPath = path.join(config.blueprintDir, sanitized);

  try {
    const raw = await fs.readFile(blueprintPath, 'utf-8');
    logger.success(`Loaded blueprint file ${sanitized}`);
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new BlueprintError(`Blueprint ${sanitized} not found in ${config.blueprintDir}`);
    }
    if (err instanceof SyntaxError) {
      throw new BlueprintError(`Blueprint ${sanitized} contains invalid JSON: ${err.message}`);
    }
    throw err;
  }
}

function collectModules(node, collected = []) {
  if (!node) return collected;

  if (Array.isArray(node)) {
    node.forEach((item) => collectModules(item, collected));
    return collected;
  }

  if (typeof node === 'object') {
    if (typeof node.module === 'string') {
      const [appName, ...rest] = node.module.split(':');
      const moduleName = rest.join(':');
      if (appName && moduleName) {
        collected.push({ appName, moduleName, raw: node.module });
      }
    }

    Object.entries(node).forEach(([key, value]) => {
      if (['metadata', 'parameters', 'mapper', 'config', 'output'].includes(key)) {
        return;
      }
      collectModules(value, collected);
    });
  }

  return collected;
}

function selectPrimaryApp(modules) {
  const appMap = modules.reduce((map, entry) => {
    if (!map.has(entry.appName)) {
      map.set(entry.appName, new Set());
    }
    map.get(entry.appName).add(entry.moduleName);
    return map;
  }, new Map());

  if (appMap.size === 0) {
    throw new BlueprintError('No modules found in blueprint.');
  }

  const excludedApp = 'facebook-conversion-leads';
  const [primaryApp, moduleSet] =
    [...appMap.entries()].find(([app]) => app !== excludedApp) ||
    [...appMap.entries()][0];

  return {
    appName: primaryApp,
    moduleNames: [...moduleSet],
    totalModules: modules.length,
    apps: [...appMap.keys()],
  };
}

async function analyseBlueprint(blueprintName) {
  const blueprint = await loadBlueprint(blueprintName);
  const modules = collectModules(Array.isArray(blueprint.flow) ? blueprint.flow : blueprint.flow ? [blueprint.flow] : []);

  if (modules.length) {
    const byApp = modules.reduce((acc, entry) => {
      if (!acc[entry.appName]) {
        acc[entry.appName] = new Set();
      }
      acc[entry.appName].add(entry.moduleName);
      return acc;
    }, {});
    Object.entries(byApp).forEach(([app, moduleSet]) => {
      logger.info(`Blueprint modules for app "${app}": ${[...moduleSet].join(', ')}`);
    });
  } else {
    logger.warn('No modules discovered while parsing blueprint flow collections.');
  }

  const summary = selectPrimaryApp(modules);
  logger.step(`Blueprint analysis complete. Found ${modules.length} modules across ${summary.apps.length} apps.`);
  logger.info(`Selected app "${summary.appName}" with modules: ${summary.moduleNames.join(', ')}`);

  return {
    blueprint,
    modules,
    summary,
  };
}

function updateConnectionIds(node, connectionId, stats) {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => updateConnectionIds(child, connectionId, stats));
    return;
  }

  if (typeof node.module === 'string') {
    const [appName] = node.module.split(':');
    if (appName && appName !== 'facebook-conversion-leads') {
      const parameters = node.parameters;
      if (parameters && Object.prototype.hasOwnProperty.call(parameters, '__IMTCONN__')) {
        parameters.__IMTCONN__ = connectionId;
        stats.updated += 1;
      }
    }
  }

  Object.keys(node).forEach((key) => {
    if (key === 'parameters') {
      return;
    }
    updateConnectionIds(node[key], connectionId, stats);
  });
}

async function saveUpdatedBlueprint(originalName, blueprint, connectionId, outputDir) {
  const clone = JSON.parse(JSON.stringify(blueprint));
  const stats = { updated: 0 };
  updateConnectionIds(clone, connectionId, stats);

  const baseName = originalName.replace(/\.json$/i, '');
  const targetDir = outputDir;
  const targetPath = path.join(targetDir, `${baseName}-updated.json`);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(clone, null, 4)}\n`, 'utf8');

  logger.success(`Saved updated blueprint to ${targetPath} (updated ${stats.updated} modules).`);

  return { targetPath, updatedCount: stats.updated };
}

module.exports = {
  analyseBlueprint,
  BlueprintError,
  loadBlueprint,
  saveUpdatedBlueprint,
};
