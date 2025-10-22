require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const apiRoutes = require('./routes/api');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  try {
    const templatePath = path.join(config.rootDir, 'index.html');
    let html = fs.readFileSync(templatePath, 'utf8');
    html = html.replace(/{{HOST}}/g, config.host).replace(/{{PORT}}/g, config.port);
    res.send(html);
  } catch (error) {
    logger.error(`Failed to serve index.html: ${error.message}`);
    res.status(500).send('Unable to load application');
  }
});

app.get('/api/blueprints', (req, res) => {
  try {
    const entries = fs.readdirSync(config.blueprintDir, { withFileTypes: true });
    const blueprints = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    res.json({ blueprints });
  } catch (error) {
    logger.error(`Failed to list blueprints: ${error.message}`);
    res.status(500).json({ message: 'Unable to list blueprints' });
  }
});

app.use(apiRoutes);

function startServer() {
  try {
    config.ensureRequiredConfig();
  } catch (error) {
    logger.error(error.message);
    process.exit(1);
  }

  const port = config.port;
  app.listen(port, () => {
    logger.success(`Server listening on port ${port}`);
  });
}

module.exports = {
  app,
  startServer,
};
