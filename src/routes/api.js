const { Router } = require('express');
const {
  createConnectionHandler,
  testConnectionHandler,
  startConnectionFlowHandler,
} = require('../controllers/connectionController');

const router = Router();

router.post('/connection', createConnectionHandler);
router.post('/connection/start', startConnectionFlowHandler);
router.post('/test', testConnectionHandler);

module.exports = router;
