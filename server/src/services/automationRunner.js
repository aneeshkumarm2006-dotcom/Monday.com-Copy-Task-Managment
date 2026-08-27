const cron = require('node-cron');
const Automation = require('../models/Automation');
const {
  runAutomationOnce,
  holidayKeysForAutomation,
} = require('../controllers/automationController');
const { computeNextRunAt } = require('./automationSchedule');

let started = false;

const tick = async () => {
  const now = new Date();
  let due;
  try {
    due = await Automation.find({
      enabled: true,
      triggerType: 'SCHEDULE',
      nextRunAt: { $lte: now },
    });
  } catch (err) {
    console.error('[automation] failed to query due automations:', err);
    return;
  }

  for (const automation of due) {
    try {
      await runAutomationOnce(automation);
      automation.lastRunAt = now;
      automation.nextRunAt = computeNextRunAt(
        automation.schedule,
        now,
        await holidayKeysForAutomation(automation)
      );
      await automation.save();
    } catch (err) {
      console.error('[automation] run failed for', automation?._id?.toString(), err);
    }
  }
};

const startAutomationRunner = () => {
  if (started) return;
  started = true;
  cron.schedule('* * * * *', () => {
    tick().catch((err) => console.error('[automation] tick error:', err));
  });
  console.log('automation runner started');
};

module.exports = { startAutomationRunner };
