const COLORS = {
  reset: '\x1b[0m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
  step: '\x1b[35m',
  debug: '\x1b[90m',
  timestamp: '\x1b[90m',
};

const LABELS = {
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
  success: '[OK]',
  step: '[STEP]',
  debug: '[DEBUG]',
};

const isDebugEnabled = () => process.env.DEBUG === 'true' || process.env.DEBUG === '1';

function formatMessage(level, message) {
  const ts = `${COLORS.timestamp}${new Date().toISOString()}${COLORS.reset}`;
  const labelColor = COLORS[level] || COLORS.info;
  const label = `${labelColor}${LABELS[level] || LABELS.info}${COLORS.reset}`;
  return `${ts} ${label} ${message}`;
}

function log(level, message) {
  const formatted = formatMessage(level, message);
  // eslint-disable-next-line no-console
  console.log(formatted);
}

module.exports = {
  info: (msg) => log('info', msg),
  warn: (msg) => log('warn', msg),
  error: (msg) => log('error', msg),
  success: (msg) => log('success', msg),
  step: (msg) => log('step', msg),
  debug: (msg) => {
    if (isDebugEnabled()) {
      log('debug', msg);
    }
  },
};
