// Register all Mongoose models at startup so refs/populate() work everywhere.
require('./User');
require('./Organisation');
require('./Board');
require('./BoardConnection');
require('./TaskGroup');
require('./Task');
require('./Update');
require('./Notification');
require('./NotificationPreference');
require('./ItemFollow');
require('./Automation');
