// sendReminders.js
const admin = require('firebase-admin');
const fs = require('fs');

const SA_PATH = process.env.SA_PATH || './serviceAccountKey.json';
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
const sa = require(SA_PATH);

admin.initializeApp({
  credential: admin.credential.cert(sa),
  databaseURL: process.env.DATABASE_URL || sa.databaseURL
});
const db = admin.database();

function getDateInTZAddDays(tz = 'Asia/Kolkata', addDays = 1) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  now.setDate(now.getDate() + addDays);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isWeekendISO(isoDate, tz='Asia/Kolkata') {
  const d = new Date(new Date(isoDate + 'T00:00:00').toLocaleString('en-US', { timeZone: tz }));
  const day = d.getDay(); // 0 Sun, 6 Sat
  return day === 0 || day === 6;
}

function adjustForWeekend(reminderISO, tz) {
  const d = new Date(new Date(reminderISO + 'T09:00:00').toLocaleString('en-US', { timeZone: tz }));
  const day = d.getDay();
  if (day === 6) d.setDate(d.getDate() - 1); // Sat -> Fri
  else if (day === 0) d.setDate(d.getDate() - 2); // Sun -> Fri
  const yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

(async function main() {
  try {
    const defaultTZ = 'Asia/Kolkata';
    const targetDueDate = getDateInTZAddDays(defaultTZ, 1); // due date we are interested in
    console.log('Target due date (due tomorrow):', targetDueDate);

    const parentsSnap = await db.ref('Parents').once('value');
    if (!parentsSnap.exists()) {
      console.log('No parents found');
      return;
    }

    const tasks = [];

    parentsSnap.forEach(parentSnap => {
      const parentId = parentSnap.key;
      const parent = parentSnap.val() || {};
      if (parent.muteReminders) return;

      const tz = parent.timezone || defaultTZ;
      const tokensObj = parent.fcmTokens || {};
      const tokens = Object.keys(tokensObj || {});
      if (tokens.length === 0) return;

      const children = parent.children || {};
      const dueChildren = [];
      Object.entries(children).forEach(([childId, child]) => {
        if (!child || !child.nextDueDate) return;
        if (child.nextDueDate === targetDueDate) {
          if (child.lastNotifiedDate && child.lastNotifiedDate === targetDueDate) return;
          dueChildren.push({ childId, child });
        }
      });

      if (dueChildren.length === 0) return;

      const parts = dueChildren.map(dc => {
        const childName = (dc.child && dc.child.name) ? dc.child.name : 'your child';
        const vac = (dc.child && dc.child.nextDueVaccine) ? dc.child.nextDueVaccine : 'vaccine';
        return `${vac} (${childName})`;
      });
      const body = `Reminder: ${parts.join(', ')} are due tomorrow. Please enquire or book an appointment.`;

      // compute reminder date (due - 1) in parent's timezone and adjust weekends
      const due = dueChildren[0].child.nextDueDate;
      const dueDateObj = new Date(new Date(due + 'T09:00:00').toLocaleString('en-US', { timeZone: tz }));
      dueDateObj.setDate(dueDateObj.getDate() - 1);
      const yyyy = dueDateObj.getFullYear(), mm = String(dueDateObj.getMonth()+1).padStart(2,'0'), dd = String(dueDateObj.getDate()).padStart(2,'0');
      let finalSendDate = `${yyyy}-${mm}-${dd}`;
      if (isWeekendISO(finalSendDate, tz)) finalSendDate = adjustForWeekend(finalSendDate, tz);

      // is today in parent's timezone?
      const today = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const todayISO = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

      if (finalSendDate !== todayISO) return;

      const message = {
        notification: {
          title: 'Vaccine reminder',
          body
        },
        tokens: tokens,
        data: {
          type: 'vaccine_reminder',
          date: targetDueDate
        }
      };

      const p = admin.messaging().sendMulticast(message)
        .then(async (resp) => {
          console.log(`Sent to parent ${parentId} => success=${resp.successCount} failures=${resp.failureCount}`);
          const updates = {};
          const auditPromises = [];
          dueChildren.forEach(dc => {
            updates[`Parents/${parentId}/children/${dc.childId}/lastNotifiedDate`] = targetDueDate;
            const auditRef = db.ref(`notifications/${parentId}/${dc.childId}/${targetDueDate}`);
            auditPromises.push(auditRef.set({
              sentAt: admin.database.ServerValue.TIMESTAMP,
              body,
              result: { successCount: resp.successCount, failureCount: resp.failureCount }
            }));
          });
          await db.ref().update(updates);
          await Promise.all(auditPromises);
        })
        .catch(err => {
          console.error('FCM send error for parent', parentId, err);
          dueChildren.forEach(dc => {
            const failRef = db.ref(`notifications_failures/${parentId}/${dc.childId}/${targetDueDate}`);
            failRef.set({
              error: String(err),
              ts: Date.now()
            });
          });
        });

      tasks.push(p);
    });

    await Promise.all(tasks);
    console.log('All reminders processed.');
    process.exit(0);
  } catch (err) {
    console.error('Fatal error', err);
    process.exit(1);
  }
})();
