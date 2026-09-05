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
require('./PushSubscription');
require('./ItemFollow');
require('./Automation');
require('./Tracker');
require('./TrackerEntry');
require('./Goal');
require('./GoalReminder');
// Ads budgets on a tracker board. Platform and campaign rows share this one
// collection, told apart by `parent`; see the model's header for why totals
// must only ever sum the platform level.
require('./AdsBudget');
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
// The DataForSEO task ledger. One row per posted job, and the partial unique
// index on it is the ONLY real concurrency control in that provider's design —
// see the model header for why a read-then-write cannot be one here.
require('./DfsTask');
// The SERP bodies, one document per (project, kind, variant, period, keyword).
// They are a separate collection because 200 keywords at depth 100 is 20-40 MB —
// over Mongo's 16 MB ceiling by 2x — and the write would fail AFTER the money was
// spent and AFTER `task_get` consumed the result. See the model header.
require('./DfsSerpResult');
// Phase 11's measurement: how many keywords another tenant had already bought
// that day, per kind, per UTC day. Durable because the decision it gates is made
// six months from now and a `console.log` is not evidence. See the model header.
require('./DfsCacheProbe');
// The SHARED SERP corpus — the only cross-tenant data path in this provider, and
// the only collection here with no `organisation` field. It is refcounted through
// `orgs[]` instead, which is what `services/orgCascade.js` pulls from. INERT
// unless `DATAFORSEO_SERP_CACHE_ORGS` names somebody; empty means nobody.
require('./DfsSerpCache');
// The spend ceiling, per scope per month. Its `reservedUsd` is a RECOMPUTABLE
// CACHE of the open tasks, and the reserve is a two-step split — an existence
// upsert with no cap logic, then a guarded update with NO upsert — because the
// obvious one-liner fails open. See the model header.
require('./ConnectorBudget');
// Which provider value fills which goal cell. Per BOARD and keyed by
// `goalColumns[]._id`, never by the column's slug — see the model header for the
// live board that already proves why.
require('./ConnectorFieldMapping');
// Which tracked keyword a goal is about, and who last wrote each of its cells.
// Provenance lives here rather than wrapping the values themselves — see the
// model header for the eight readers that shape change would have rippled into.
require('./GoalConnectorLink');
// Chat — conversation SURFACES sectioned by board, messages shaped like
// Updates, and read markers. Membership is derived from board access on every
// read, never stored; see Channel.js.
//
// Two read models on purpose: chat reads a CHANNEL, mail reads a THREAD. They
// are different units, and MailThreadRead.js explains why the tidier-looking
// single collection is the one to avoid.
require('./Channel');
require('./Message');
require('./ChannelRead');
require('./MailThreadRead');
require('./ChannelContactRead');

// The Client Portal roster. It was missing from this barrel, which meant
// `mongoose.model('ClientContact')` only resolved once some controller had
// happened to require the file by path — so a script or test that loaded the
// models on their own hit MissingSchemaError, and `Message.portalAuthor`
// populate depended on load order rather than on registration.
require('./ClientContact');

// The organisation's service catalog — the vocabulary a client board's groups
// are named from. Registered here for the same reason ClientContact is: a
// migration or a test that loads the models on its own must not depend on some
// controller having happened to require the file by path first.
require('./ServiceCatalogEntry');

// The daily client-portal digest's claim row. Registered for the same reason as
// the two above: a runner or a script that loads the models on its own must not
// depend on some controller having required the file by path first.
require('./PortalDigest');
