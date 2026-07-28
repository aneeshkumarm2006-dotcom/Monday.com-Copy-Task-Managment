require('dotenv').config();
require('./src/models'); // register all Mongoose models
const app = require('./src/app');
const connectDB = require('./src/config/db');
const { startAutomationRunner } = require('./src/services/automationRunner');
const eventBus = require('./src/services/eventBus');
const {
  mountAutomationEventDispatcher,
} = require('./src/services/automationEventDispatcher');
const { mountMirrorRefresh } = require('./src/services/mirrorRefresh');
const notificationStream = require('./src/services/notificationStream');
const { startInboundMailPoller } = require('./src/services/inboundMailPoller');

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();
  eventBus.mount();
  mountAutomationEventDispatcher();
  mountMirrorRefresh();
  notificationStream.mount();
  startAutomationRunner();
  // Non-critical: never let the optional email poller block the server booting.
  try {
    startInboundMailPoller();
  } catch (err) {
    console.error('startInboundMailPoller failed (continuing without it):', err);
  }
  app.listen(PORT, () => {
    console.log(`Macan API listening on port ${PORT}`);
  });
};

start();
