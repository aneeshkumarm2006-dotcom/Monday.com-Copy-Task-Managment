require('dotenv').config();

// Last-resort safety net: a stray async error (e.g. a socket 'error' event from
// a background poller) must NEVER take the whole service down again. Log and
// keep serving requests.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (kept process alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (kept process alive):', reason);
});

require('./src/models'); // register all Mongoose models
const app = require('./src/app');
const connectDB = require('./src/config/db');
const { startAutomationRunner } = require('./src/services/automationRunner');
const { startGoalReminderRunner } = require('./src/services/goalReminderRunner');
const { startDueDigestRunner } = require('./src/services/dueDigestRunner');
const { startPortalDigestRunner } = require('./src/services/portalDigestRunner');
const eventBus = require('./src/services/eventBus');
const {
  mountAutomationEventDispatcher,
} = require('./src/services/automationEventDispatcher');
const { mountMirrorRefresh } = require('./src/services/mirrorRefresh');
const notificationStream = require('./src/services/notificationStream');
const { startInboundMailPoller } = require('./src/services/inboundMailPoller');
const {
  startConnectorSyncRunner,
} = require('./src/services/connectorSyncRunner');
const {
  startConnectorCollectRunner,
} = require('./src/services/connectorCollectRunner');
const { startSeoAlertRunner } = require('./src/services/seoAlertRunner');
const connectorCrypto = require('./src/utils/connectorCrypto');
const { checkRegistry } = require('./src/services/connectors');

const PORT = process.env.PORT || 5000;

/**
 * Connector readiness, checked once at boot.
 *
 * Both of these would otherwise surface at the worst possible moment: a missing
 * master key fails the first time an admin clicks Connect, and a mis-registered
 * provider fails during an unattended weekly sync with nobody watching. Neither
 * is fatal — every other feature works fine without connectors — so this warns
 * rather than exits.
 */
const reportConnectorReadiness = () => {
  const registry = checkRegistry();
  if (!registry.ok) {
    registry.errors.forEach((e) => console.error(`CONNECTOR REGISTRY: ${e}`));
  }

  const crypto = connectorCrypto.checkConfigured();
  if (!crypto.ok) {
    console.warn(
      'CONNECTORS DISABLED: ' +
        crypto.error +
        '\n  Connectors will refuse to link an account until this is set. ' +
        'Everything else runs normally.'
    );
  }
};

const start = async () => {
  await connectDB();
  eventBus.mount();
  mountAutomationEventDispatcher();
  mountMirrorRefresh();
  notificationStream.mount();
  startAutomationRunner();
  startGoalReminderRunner();
  startDueDigestRunner();
  startPortalDigestRunner();
  reportConnectorReadiness();
  // Hourly tick, weekly WORK — the freshness decision is per (project, kind) and
  // lives in the snapshot service, so a missed window is caught within the hour
  // instead of within the week. See the runner's header.
  startConnectorSyncRunner();
  // The other half, every ten minutes: collect results already paid for and
  // nothing else. It runs behind a client whose transport refuses every endpoint
  // that is not free, which is what lets it be six times as frequent as the pass
  // that can buy. See connectorCollectRunner's header.
  startConnectorCollectRunner();
  // The third connector clock, and the only one that cannot spend anything at
  // all: it reads snapshots the other two bought and turns the ones worth
  // interrupting somebody about into notifications. Thirteen minutes after the
  // buying pass, so an alert lands within an hour of the reading that caused it.
  startSeoAlertRunner();
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
