const scheduleStore = require('./scheduleStore');
const releaseCache = require('./releaseCache');

// Checked twice a minute (not once) so a slow event-loop tick can't push a
// check past the target minute and skip it entirely.
const CHECK_INTERVAL_MS = 30 * 1000;

// Guards against firing more than once for the same minute - ticks land at
// :00/:30 past the minute, both of which can match the same target time.
let lastFiredKey = null;

function minuteKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

// Server's own local clock/timezone (whatever the container's TZ resolves
// to, UTC by default) - the GUI surfaces this alongside the time picker so
// it's not left ambiguous which clock "03:00" is measured against.
function matchesNow(schedule, now) {
  if (!schedule.enabled) return false;
  const [h, m] = (schedule.time || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return false;
  if (now.getHours() !== h || now.getMinutes() !== m) return false;
  if (schedule.mode === 'weekly') {
    return Array.isArray(schedule.days) && schedule.days.includes(now.getDay());
  }
  return true;
}

function tick() {
  const now = new Date();
  const key = minuteKey(now);
  if (key === lastFiredKey) return;

  const schedule = scheduleStore.getSchedule();
  if (!matchesNow(schedule, now)) return;

  lastFiredKey = key;
  scheduleStore.recordRun();
  releaseCache.getReleases({ forceRefresh: true }).catch(() => {
    // best-effort - a failed scheduled scan just leaves the existing cache
    // in place, same as any other failed refresh
  });
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref(); // never keeps the process alive on its own
}

module.exports = { start };
