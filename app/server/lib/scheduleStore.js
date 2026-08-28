const fs = require('fs');
const { SCHEDULE_FILE } = require('./config');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_SCHEDULE = { enabled: false, mode: 'daily', time: '03:00', days: [], lastRunAt: null };

function load() {
  try {
    return { ...DEFAULT_SCHEDULE, ...JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) };
  } catch (err) {
    return { ...DEFAULT_SCHEDULE };
  }
}

let schedule = load();

function persist() {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  } catch (err) {
    // best-effort - schedule persistence shouldn't take anything else down with it
  }
}

function getSchedule() {
  return schedule;
}

// mode/time/days are user input straight from the request body - validate
// before ever handing them to refreshScheduler.js, which trusts this shape.
function setSchedule({ enabled, mode, time, days }) {
  if (mode !== 'daily' && mode !== 'weekly') {
    throw new Error('Frequency must be "daily" or "weekly"');
  }
  if (!TIME_RE.test(time || '')) {
    throw new Error('Time must be in 24-hour HH:MM format');
  }
  const cleanDays = Array.isArray(days) ? [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
  if (enabled && mode === 'weekly' && cleanDays.length === 0) {
    throw new Error('Pick at least one day for a weekly schedule');
  }

  schedule = { ...schedule, enabled: !!enabled, mode, time, days: cleanDays };
  persist();
  return schedule;
}

function recordRun() {
  schedule = { ...schedule, lastRunAt: Date.now() };
  persist();
}

module.exports = { getSchedule, setSchedule, recordRun };
