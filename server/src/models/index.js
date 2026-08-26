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
require('./ConnectorProject');
// The durable record. Per-keyword rank history does not exist in the Ubersuggest
// API — these rows are the only copy that will ever exist. See the model header.
require('./ConnectorSnapshot');
// Which provider value fills which goal cell. Per BOARD and keyed by
// `goalColumns[]._id`, never by the column's slug — see the model header for the
// live board that already proves why.
require('./ConnectorFieldMapping');
// Which tracked keyword a goal is about, and who last wrote each of its cells.
// Provenance lives here rather than wrapping the values themselves — see the
// model header for the eight readers that shape change would have rippled into.
require('./GoalConnectorLink');
