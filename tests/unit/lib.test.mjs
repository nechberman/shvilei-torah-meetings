import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIsraeliId, isValidIsraeliId, maskId, isValidCode } from '../../web/js/lib/israeli-id.js';
import {
  zonedToUtc, localDateKey, timeLabel, fullDayLabel, hebrewLabel, weekdayName, gregorianLabel, daysBetween,
  groupByLocalDay,
} from '../../web/js/lib/dates.js';
import { computeSlots, hasOverlap, overlaps } from '../../web/js/lib/slots.js';
import { parseCsv, toCsv } from '../../web/js/lib/csv.js';
import { errorMessage } from '../../web/js/lib/errors.js';

test('israeli id: valid ids incl. leading zeros', () => {
  assert.equal(normalizeIsraeliId('123456782'), '123456782');
  assert.equal(normalizeIsraeliId('000000018'), '000000018');
  assert.equal(normalizeIsraeliId('18'), null, 'too short');
  assert.equal(normalizeIsraeliId('00018'), '000000018');
  assert.equal(normalizeIsraeliId(' 12345678-2 '), '123456782');
  assert.equal(normalizeIsraeliId('39337423'), '039337423');
});

test('israeli id: invalid ids', () => {
  assert.equal(normalizeIsraeliId('123456789'), null);
  assert.equal(normalizeIsraeliId('000000000'), null);
  assert.equal(normalizeIsraeliId('12345678a'), null);
  assert.equal(normalizeIsraeliId('1234567890'), null);
  assert.equal(normalizeIsraeliId(''), null);
  assert.equal(normalizeIsraeliId(null), null);
  assert.equal(isValidIsraeliId('123456782'), true);
});

test('mask id and code validation', () => {
  assert.equal(maskId('123456782'), '*******82');
  assert.equal(isValidCode('0000'), true);
  assert.equal(isValidCode('0042'), true);
  assert.equal(isValidCode('123'), false);
  assert.equal(isValidCode('12345'), false);
  assert.equal(isValidCode(1234), false);
});

test('timezone: Jerusalem summer (UTC+3) and winter (UTC+2)', () => {
  assert.equal(zonedToUtc('2026-10-15', '17:00').toISOString(), '2026-10-15T14:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', '17:00').toISOString(), '2026-12-01T15:00:00.000Z');
  assert.equal(timeLabel('2026-12-01T15:00:00Z'), '17:00');
  assert.equal(localDateKey('2026-10-15T22:30:00Z'), '2026-10-16', 'after local midnight');
});

test('timezone: DST transition day (Israel ends DST last Sunday of Oct 2026 = Oct 25)', () => {
  assert.equal(zonedToUtc('2026-10-24', '12:00').toISOString(), '2026-10-24T09:00:00.000Z');
  assert.equal(zonedToUtc('2026-10-26', '12:00').toISOString(), '2026-10-26T10:00:00.000Z');
});

test('hebrew + gregorian labels', () => {
  assert.equal(fullDayLabel('2026-10-15'), 'יום חמישי, ד׳ בחשוון תשפ״ז (15.10.2026)');
  assert.equal(weekdayName('2026-10-17'), 'שבת');
  assert.equal(gregorianLabel('2026-01-05'), '05.01.2026');
});

test('hebrew labels: month and year transitions', () => {
  // ראש השנה תשפ״ז: 12.09.2026 = א׳ בתשרי תשפ״ז; יום קודם כ״ט באלול תשפ״ו
  assert.equal(hebrewLabel('2026-09-12'), 'א׳ בתשרי תשפ״ז');
  assert.equal(hebrewLabel('2026-09-11'), 'כ״ט באלול תשפ״ו');
  // ראש חודש חשוון תשפ״ז: ל׳ בתשרי ואז א׳ בחשוון
  assert.equal(hebrewLabel('2026-10-11'), 'ל׳ בתשרי תשפ״ז');
  assert.equal(hebrewLabel('2026-10-12'), 'א׳ בחשוון תשפ״ז');
  // שנה מעוברת תשפ״ד: אדר א׳ / אדר ב׳
  assert.equal(hebrewLabel('2024-02-10'), 'א׳ באדר א׳ תשפ״ד');
  assert.equal(hebrewLabel('2024-03-11'), 'א׳ באדר ב׳ תשפ״ד');
  // שנה פשוטה תשפ״ה: אדר
  assert.equal(hebrewLabel('2025-03-01'), 'א׳ באדר תשפ״ה');
  assert.equal(hebrewLabel('2025-08-10'), 'ט״ז באב תשפ״ה');
});

test('days between and grouping by local day', () => {
  assert.deepEqual(daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  const g = groupByLocalDay(
    [{ t: '2026-10-16T05:00:00Z' }, { t: '2026-10-15T14:00:00Z' }, { t: '2026-10-15T21:30:00Z' }],
    (x) => x.t,
  );
  assert.deepEqual([...g.keys()], ['2026-10-15', '2026-10-16']);
  assert.equal(g.get('2026-10-16')?.length, 2);
});

test('slots: split window by duration, drop remainder', () => {
  const s = Date.UTC(2026, 9, 20, 14, 0);
  const slots = computeSlots([{ start: s, end: s + 35 * 60000 }], 10);
  assert.equal(slots.length, 3);
  assert.equal(slots[2].end, s + 30 * 60000);
  assert.ok(slots.every((x) => x.status === 'available'));
});

test('slots: blocked windows mark slots blocked', () => {
  const s = Date.UTC(2026, 9, 20, 14, 0);
  const slots = computeSlots([{ start: s, end: s + 60 * 60000 }], 15, [{ start: s + 20 * 60000, end: s + 25 * 60000 }]);
  assert.deepEqual(slots.map((x) => x.status), ['available', 'blocked', 'available', 'available']);
});

test('slots: existing bookings are preserved when duration changes', () => {
  const s = Date.UTC(2026, 9, 20, 14, 0);
  const booked = [{ start: s + 10 * 60000, end: s + 20 * 60000 }];
  const slots = computeSlots([{ start: s, end: s + 60 * 60000 }], 15, [], booked);
  // אין חפיפה עם התור הקיים
  for (const sl of slots) assert.equal(overlaps(sl, booked[0]), false);
  assert.equal(slots[0].start, s + 20 * 60000);
});

test('slots: invalid duration throws', () => {
  assert.throws(() => computeSlots([], 3), /invalid_duration/);
});

test('overlap detection', () => {
  assert.equal(hasOverlap({ start: 0, end: 10 }, [{ start: 10, end: 20 }]), false, 'touching is not overlap');
  assert.equal(hasOverlap({ start: 0, end: 11 }, [{ start: 10, end: 20 }]), true);
});

test('csv: quotes, hebrew, BOM, semicolon', () => {
  const rows = parseCsv('\uFEFFת"ז,שם\r\n"012345674","כהן, משה"\r\n\r\n');
  assert.deepEqual(rows, [['ת"ז', 'שם'], ['012345674', 'כהן, משה']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.ok(toCsv([['א', 'ב,ג']]).startsWith('\uFEFFא,"ב,ג"'));
});

test('error messages do not reveal existence', () => {
  assert.match(errorMessage('not_found'), /לא נמצאו/);
  assert.equal(errorMessage({ error: 'slot_taken' }), 'השעה נתפסה, בחרו שעה אחרת.');
  assert.equal(errorMessage({ message: 'ERROR: slot_not_found' }), 'השעה אינה זמינה, בחרו שעה אחרת.');
  assert.equal(errorMessage('weird'), 'אירעה שגיאה. נסו שוב.');
});
