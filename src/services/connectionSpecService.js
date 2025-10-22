const config = require('../config');
const logger = require('../utils/logger');

function collectFormFields(node, collected = []) {
  if (!node) {
    return collected;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => collectFormFields(item, collected));
    return collected;
  }

  if (typeof node === 'object') {
    const {
      key,
      name,
      defaultValue,
      default: defaultLiteral,
      type,
      components,
      data,
      templateOptions,
      validate,
      required,
    } = node;

    const identifier = typeof key === 'string' && key.length
      ? key
      : typeof name === 'string' && name.length
        ? name
        : null;

    const resolvedType = type || (templateOptions && templateOptions.type);

    if (identifier && !['button', 'content', 'htmlelement'].includes(String(resolvedType || '').toLowerCase())) {
      const isRequired = Boolean(
        (validate && validate.required) ||
        required ||
        (templateOptions && templateOptions.required)
      );
      const resolvedDefault = defaultValue !== undefined
        ? defaultValue
        : templateOptions && templateOptions.defaultValue !== undefined
          ? templateOptions.defaultValue
          : templateOptions && templateOptions.default !== undefined
            ? templateOptions.default
            : defaultLiteral !== undefined
              ? defaultLiteral
              : undefined;
      collected.push({
        key: identifier,
        defaultValue: resolvedDefault,
        data,
        type: resolvedType,
        templateOptions,
        required: isRequired,
      });
    }

    Object.entries(node).forEach(([propKey, value]) => {
      if (value === components) {
        return;
      }

      if (propKey === 'options' && value && typeof value === 'object') {
        const store = Array.isArray(value.store) ? value.store : [];
        if (store.length) {
          const selected = store.find((option) => option && (option.default === true || option.selected === true)) || store[0];
          if (selected) {
            collectFormFields(selected, collected);
          }
        }
        return;
      }

      if (propKey === 'nested' && Array.isArray(value)) {
        value.forEach((entry) => collectFormFields(entry, collected));
        return;
      }

      collectFormFields(value, collected);
    });
  }

  return collected;
}

function buildSpec(formSchema, appName, scopes, overrides = {}) {
  const fields = collectFormFields(formSchema);
  const payload = {};

  fields.forEach((field) => {
    const { key, defaultValue } = field;
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      payload[key] = overrides[key];
    } else if (key === 'accountType') {
      payload[key] = overrides[key] || appName;
    } else if (defaultValue !== undefined) {
      payload[key] = defaultValue;
    } else {
      payload[key] = getFallbackValue(field);
    }
  });

  if (typeof payload.accountName === 'string' && /{{.*}}/.test(payload.accountName)) {
    payload.accountName = '';
  }

  if (overrides.accountName) {
    payload.accountName = overrides.accountName;
  } else if (!payload.accountName) {
    const prettified = appName.replace(/[-_]/g, ' ');
    payload.accountName = `${prettified.charAt(0).toUpperCase()}${prettified.slice(1)} connection`;
  }

  payload.accountType = overrides.accountType || payload.accountType || appName;

  if (config.property && payload.property === '') {
    payload.property = config.property;
  }

  payload.customScopes = Array.isArray(scopes) ? scopes : [];
  if (payload.customScopes.length) {
    logger.success(`Including ${payload.customScopes.length} custom scopes in payload: ${payload.customScopes.join(', ')}`);
  }
  if (payload.customScopes.length === 0) {
    logger.warn('customScopes array is empty; connection may fail if scopes are required.');
  }

  ['accountName', 'accountType'].forEach((key) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, key);
    if (!hasOverride && config[key] && !payload[key]) {
      payload[key] = config[key];
    }
  });

  if (Array.isArray(overrides.customScopes)) {
    payload.customScopes = overrides.customScopes;
  }

  const missingRequired = fields
    .filter((field) => field.required)
    .filter((field) => {
      const value = payload[field.key];
      if (typeof value === 'boolean' || typeof value === 'number') {
        return false;
      }
      return value === '' || value === undefined || value === null;
    })
    .map((field) => field.key);

  if (missingRequired.length) {
    logger.warn(`Missing required fields in spec: ${missingRequired.join(', ')}.`);
    if (missingRequired.includes('property')) {
      throw new Error('Required field "property" is missing. Set PROPERTY in the environment or provide an override.');
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'property') && !payload.property) {
    const message = 'Field "property" is empty. Provide PROPERTY in the environment or pass an override.';
    logger.error(message);
    throw new Error(message);
  }

  logger.info(`Prepared connection spec with ${Object.keys(payload).length} fields.`);
  return payload;
}

function getFallbackValue(field) {
  const { type, data, templateOptions } = field;
  const sources = [data, templateOptions];

  if (!type) {
    const value = pickOptionFallback(sources);
    return value !== undefined ? value : '';
  }

  const normalised = String(type).toLowerCase();
  const templateType = templateOptions && templateOptions.type ? String(templateOptions.type).toLowerCase() : null;
  if (normalised === 'boolean' || templateType === 'boolean') {
    return false;
  }

  if (['select', 'radio', 'radios', 'dropdown'].includes(normalised)) {
    const optionValue = pickOptionFallback(sources);
    if (optionValue !== undefined) {
      return optionValue;
    }
  }

  const optionValue = pickOptionFallback(sources);
  if (optionValue !== undefined) {
    return optionValue;
  }

  return '';
}

function pickOptionFallback(sources) {
  const listOfSources = Array.isArray(sources) ? sources : [sources];
  const objects = listOfSources.filter((source) => source && typeof source === 'object');
  if (!objects.length) {
    return undefined;
  }

  for (const source of objects) {
    if (Object.prototype.hasOwnProperty.call(source, 'defaultValue')) {
      return source.defaultValue;
    }
  }

  const candidateLists = [];
  for (const source of objects) {
    const potential = extractOptionLists(source);
    if (potential.length) {
      candidateLists.push(...potential);
    }
  }
  if (!candidateLists.length) {
    return undefined;
  }

  const flattened = candidateLists.flat();
  const preferred = flattened.find((option) => option && typeof option === 'object' && option.default === true)
    || flattened.find((option) => option && typeof option === 'object' && option.selected === true);

  const chosen = preferred || flattened.find((option) => {
    if (option === null || option === undefined) {
      return false;
    }
    if (typeof option === 'object') {
      return option.value !== undefined || option.id !== undefined || option.code !== undefined;
    }
    return true;
  });

  if (!chosen) {
    return undefined;
  }

  if (typeof chosen === 'object') {
    return chosen.value ?? chosen.id ?? chosen.code ?? '';
  }
  return chosen;
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

module.exports = {
  buildSpec,
};
