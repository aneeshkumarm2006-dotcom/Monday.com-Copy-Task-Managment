// Register all Mongoose models at startup so refs/populate() work everywhere.
require('./User');
require('./Organisation');
require('./Board');
require('./BoardConnection');
require('./TaskGroup');
require('./Task');
require('./Update');
require('./Note');
require('./Notification');
require('./NotificationPreference');
require('./ItemFollow');
require('./Automation');
require('./Tracker');
require('./TrackerEntry');
require('./Goal');
require('./GoalReminder');
require('./Vault');
require('./VaultItem');
require('./VaultAudit');
require('./VaultEscrow');
// Connectors. Note ConnectorAccount holds OAuth tokens sealed by
// utils/connectorCrypto.js — server-readable by design, NOT the zero-knowledge
// Vault above. See that file's header for why the two must stay distinct.
require('./ConnectorAccount');
require('./ConnectorAuthAttempt');
require('./BoardConnector');
