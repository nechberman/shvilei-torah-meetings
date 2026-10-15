// סביבת עבודה לאסיפה+רב: משך פגישה, חלונות זמינות והפסקות, לוח תורים, תלמידים, הערות.
// משמש גם את הרב (לעצמו) וגם את המנהל (לכל רב). כל פעולה נבדקת בשרת.
import { rpc, select } from './api.js';
import {
  daysBetween, fullDayLabel, fullDayLabelFromTs, groupByLocalDay, localDateKey, timeLabel, timeRangeLabel, zonedToUtc,
} from './dates.js';
import { errorMessage } from './errors.js';
import { exportXlsx } from './excel.js';
import { alertBox, confirmDialog, empty, field, formDialog, h, loading, mount, toast, val } from './ui.js';

/**
 * @param {HTMLElement} host
 * @param {{conference: any, teacherId: string, teacherName: string, me: {id: string, role: string}}} ctx
 */
export async function renderWorkspace(host, ctx) {
  mount(host, loading());
  const { conference: conf, teacherId } = ctx;
  const isOwn = ctx.me.id === teacherId;
  const editable = conf.status !== 'archived';
  let data;
  try {
    const [ct, windows, blocks, board, students] = await Promise.all([
      select('conference_teachers', 'slot_duration_minutes', (q) => q.eq('conference_id', conf.id).eq('teacher_id', teacherId)),
      select('availability_windows', 'id, start_at, end_at', (q) => q.eq('conference_id', conf.id).eq('teacher_id', teacherId).order('start_at')),
      select('blocked_windows', 'id, start_at, end_at, reason', (q) => q.eq('conference_id', conf.id).eq('teacher_id', teacherId).order('start_at')),
      rpc('staff_conference_board', { p_conference_id: conf.id, p_teacher_id: teacherId }),
      rpc('staff_students_status', { p_conference_id: conf.id, p_teacher_id: teacherId }),
    ]);
    /** @type {Map<string, string>} */
    let notes = new Map();
    if (isOwn) {
      const apptIds = board.filter((/** @type {any} */ b) => b.appointment_id).map((/** @type {any} */ b) => b.appointment_id);
      if (apptIds.length) {
        const rows = await select('teacher_notes', 'appointment_id, note_text', (q) => q.in('appointment_id', apptIds).eq('teacher_id', teacherId));
        notes = new Map(rows.map((/** @type {any} */ r) => [r.appointment_id, r.note_text]));
      }
    }
    data = { duration: ct[0]?.slot_duration_minutes, windows, blocks, board, students, notes };
  } catch (err) {
    mount(host, alertBox('err', errorMessage(err)));
    return;
  }
  if (!data.duration) {
    mount(host, alertBox('warn', 'הרב אינו משויך לאסיפה זו. מנהל יכול לשייך אותו בלשונית "אסיפות".'));
    return;
  }
  const reload = () => renderWorkspace(host, ctx);
  /** @param {() => Promise<any>} fn @param {string} okMsg */
  const act = async (fn, okMsg) => {
    try {
      await fn();
      toast(okMsg);
      reload();
    } catch (err) {
      toast(errorMessage(err), 'err');
    }
  };

  const confDays = daysBetween(conf.starts_on, conf.ends_on);
  const booked = data.board.filter((/** @type {any} */ b) => b.appointment_id).length;
  const free = data.board.filter((/** @type {any} */ b) => !b.appointment_id && b.slot_status === 'available' && new Date(b.starts_at) > new Date()).length;
  const unbooked = data.students.filter((/** @type {any} */ s) => !s.appointment_id);

  // ---------- סיכום ----------
  const summary = h('div', { class: 'stats' },
    h('div', null, h('div', { class: 'v' }, String(data.students.length)), h('div', { class: 'k' }, 'תלמידים')),
    h('div', null, h('div', { class: 'v' }, String(booked)), h('div', { class: 'k' }, 'נרשמו')),
    h('div', null, h('div', { class: 'v' }, String(unbooked.length)), h('div', { class: 'k' }, 'טרם נרשמו')),
    h('div', null, h('div', { class: 'v' }, String(free)), h('div', { class: 'k' }, 'שעות פנויות')));

  // ---------- זמינות ----------
  const availPanel = h('section', { class: 'panel' },
    h('div', { class: 'section-title' }, h('h2', null, 'ימים ושעות קבלה'),
      editable ? h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => addWindowDialog(false) }, 'הוספת חלון זמינות'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => addWindowDialog(true) }, 'הוספת הפסקה'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: durationDialog }, `משך פגישה: ${data.duration} דק׳`)) : null),
    data.windows.length === 0
      ? empty('עדיין לא נפתחו שעות', 'הוסיפו חלון זמינות – המערכת תחלק אותו לתורים לפי משך הפגישה.')
      : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'יום'), h('th', null, 'שעות'), h('th', null, 'סוג'), h('th', null, ''))),
        h('tbody', null,
          ...data.windows.map((/** @type {any} */ w) => h('tr', null,
            h('td', null, fullDayLabelFromTs(w.start_at)), h('td', null, timeRangeLabel(w.start_at, w.end_at)),
            h('td', null, 'זמינות'),
            h('td', null, editable ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
              if (await confirmDialog('מחיקת חלון זמינות', 'התורים הפנויים בחלון יוסרו. חלון עם תורים קבועים לא יימחק.', { danger: true, okText: 'מחיקה' })) {
                act(() => rpc('staff_delete_availability', { p_id: w.id }), 'החלון נמחק');
              }
            } }, 'מחיקה') : ''))),
          ...data.blocks.map((/** @type {any} */ b) => h('tr', null,
            h('td', null, fullDayLabelFromTs(b.start_at)), h('td', null, timeRangeLabel(b.start_at, b.end_at)),
            h('td', null, h('span', { class: 'tag blocked' }, 'הפסקה'), b.reason ? ` ${b.reason}` : ''),
            h('td', null, editable ? h('button', { class: 'btn small danger', type: 'button', onclick: () =>
              act(() => rpc('staff_delete_block', { p_id: b.id }), 'ההפסקה הוסרה') }, 'הסרה') : '')))))));

  // ---------- לוח תורים ----------
  const byDay = groupByLocalDay(data.board, (/** @type {any} */ b) => b.starts_at);
  const boardBody = h('tbody');
  for (const [day, rows] of byDay) {
    boardBody.append(h('tr', { class: 'day-row' }, h('td', { colspan: '5' }, fullDayLabel(day))));
    for (const b of rows) {
      const past = new Date(b.starts_at) <= new Date();
      const status = b.appointment_id
        ? h('span', { class: 'tag booked' }, 'תפוס')
        : b.slot_status === 'blocked' ? h('span', { class: 'tag blocked' }, 'חסום') : h('span', { class: 'tag draft' }, 'פנוי');
      const actions = h('div', { class: 'row', style: 'gap:6px' });
      if (editable && b.appointment_id && !past) {
        actions.append(
          h('button', { class: 'btn small secondary', type: 'button', onclick: () => moveDialog(b) }, 'העברה'),
          h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
            if (await confirmDialog('ביטול תור', `לבטל את התור של ${b.student_name} בשעה ${timeLabel(b.starts_at)}?`, { danger: true, okText: 'ביטול התור' })) {
              act(() => rpc('staff_cancel_appointment', { p_appointment_id: b.appointment_id }), 'התור בוטל');
            }
          } }, 'ביטול'));
      }
      if (editable && !b.appointment_id && !past) {
        actions.append(
          b.slot_status === 'available'
            ? h('button', { class: 'btn small secondary', type: 'button', onclick: () => bookDialog(b) }, 'קביעת תור') : null,
          h('button', { class: 'btn small secondary', type: 'button', onclick: () =>
            act(() => rpc('staff_set_slot_blocked', { p_slot_id: b.slot_id, p_blocked: b.slot_status !== 'blocked' }),
              b.slot_status === 'blocked' ? 'השעה נפתחה' : 'השעה נחסמה') },
          b.slot_status === 'blocked' ? 'פתיחה' : 'חסימה'));
      }
      if (isOwn && b.appointment_id) {
        actions.append(h('button', { class: 'btn small secondary', type: 'button', onclick: () => noteDialog(b) },
          data.notes.has(b.appointment_id) ? 'עריכת הערה' : 'הערה'));
      }
      boardBody.append(h('tr', null,
        h('td', { class: 'num' }, timeRangeLabel(b.starts_at, b.ends_at)),
        h('td', null, status),
        h('td', null, b.student_name || ''),
        h('td', null, b.class_name || ''),
        h('td', null, actions)));
    }
  }
  const boardPanel = h('section', { class: 'panel' },
    h('div', { class: 'section-title' }, h('h2', null, 'לוח תורים'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn small secondary', href: `./print.html?c=${encodeURIComponent(conf.id)}&t=${encodeURIComponent(teacherId)}`, target: '_blank', rel: 'noopener' }, 'דוח להדפסה'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: exportBoard }, 'יצוא ל-Excel'))),
    data.board.length === 0 ? empty('אין עדיין תורים', 'אחרי הוספת חלון זמינות יופיעו כאן השעות.')
      : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', { class: 'num' }, 'שעה'), h('th', null, 'מצב'), h('th', null, 'תלמיד'), h('th', null, 'כיתה'), h('th', null, 'פעולות'))),
        boardBody)));

  // ---------- תלמידים ----------
  const studentsPanel = h('section', { class: 'panel' },
    h('div', { class: 'section-title' }, h('h2', null, 'תלמידים'),
      h('div', { class: 'actions' }, h('span', { class: 'muted' }, `נרשמו ${booked}, טרם נרשמו ${unbooked.length}`))),
    data.students.length === 0 ? empty('אין תלמידים משויכים') :
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'תלמיד'), h('th', null, 'כיתה'), h('th', null, 'מצב'), h('th', null, 'מועד'))),
        h('tbody', null, ...data.students.map((/** @type {any} */ s) => h('tr', null,
          h('td', null, s.full_name), h('td', null, s.class_name),
          h('td', null, s.appointment_id ? h('span', { class: 'tag booked' }, 'נרשם') : h('span', { class: 'tag pending' }, 'טרם נרשם')),
          h('td', null, s.appointment_id ? `${fullDayLabelFromTs(s.starts_at)}, ${timeLabel(s.starts_at)}` : '')))))));

  mount(host, summary,
    !editable ? alertBox('info', 'האסיפה בארכיון – צפייה בלבד.') : null,
    conf.status === 'draft' ? alertBox('info', 'האסיפה בטיוטה: ההורים עדיין לא רואים אותה. אפשר להכין את השעות מראש.') : null,
    availPanel, boardPanel, studentsPanel);

  // ---------- דיאלוגים ----------
  /** @param {boolean} isBlock */
  function addWindowDialog(isBlock) {
    const daySel = h('select', { name: 'day', required: true },
      ...confDays.map((d) => h('option', { value: d }, fullDayLabel(d))));
    const content = h('div', null,
      field('יום', daySel),
      h('div', { class: 'row' },
        field('משעה', h('input', { name: 'from', type: 'time', required: true, value: isBlock ? '18:00' : '17:00', step: '300' })),
        field('עד שעה', h('input', { name: 'to', type: 'time', required: true, value: isBlock ? '18:15' : '20:00', step: '300' }))),
      isBlock ? field('סיבה (פנימי, לא מוצג להורים)', h('input', { name: 'reason', type: 'text', maxlength: '200' })) : null,
      !isBlock ? h('p', { class: 'muted small' }, `החלון יחולק לתורים של ${data.duration} דקות.`) : null);
    formDialog(isBlock ? 'הוספת הפסקה' : 'הוספת חלון זמינות', content, async (form) => {
      const day = val(form, 'day');
      const start = zonedToUtc(day, val(form, 'from')).toISOString();
      const end = zonedToUtc(day, val(form, 'to')).toISOString();
      if (isBlock) {
        await rpc('staff_add_block', { p_conference_id: conf.id, p_teacher_id: teacherId, p_start: start, p_end: end, p_reason: val(form, 'reason') });
        toast('ההפסקה נוספה');
      } else {
        await rpc('staff_add_availability', { p_conference_id: conf.id, p_teacher_id: teacherId, p_start: start, p_end: end });
        toast('חלון הזמינות נוסף');
      }
      reload();
    }, 'הוספה');
  }

  function durationDialog() {
    formDialog('משך פגישה בדקות', h('div', null,
      field('דקות לכל תור', h('input', { name: 'min', type: 'number', min: '5', max: '120', step: '1', value: String(data.duration), required: true }),
        'תורים שכבר נקבעו לא ישתנו. השעות הפנויות יחושבו מחדש.')), async (form) => {
      await rpc('staff_set_duration', { p_conference_id: conf.id, p_teacher_id: teacherId, p_minutes: Number(val(form, 'min')) });
      toast('משך הפגישה עודכן');
      reload();
    });
  }

  /** @param {(s: any) => boolean} [filter] */
  function freeSlotOptions(filter = () => true) {
    const now = new Date();
    return data.board
      .filter((/** @type {any} */ s) => !s.appointment_id && s.slot_status === 'available' && new Date(s.starts_at) > now && filter(s))
      .map((/** @type {any} */ s) => h('option', { value: s.slot_id }, `${fullDayLabelFromTs(s.starts_at)} – ${timeLabel(s.starts_at)}`));
  }

  /** @param {any} b */
  function moveDialog(b) {
    const opts = freeSlotOptions();
    if (!opts.length) { toast('אין שעה פנויה להעברה', 'err'); return; }
    formDialog(`העברת התור של ${b.student_name}`, h('div', null,
      h('p', null, `מועד נוכחי: ${fullDayLabelFromTs(b.starts_at)}, ${timeLabel(b.starts_at)}`),
      field('מועד חדש', h('select', { name: 'slot', required: true }, ...opts))), async (form) => {
      await rpc('staff_move_appointment', { p_appointment_id: b.appointment_id, p_new_slot_id: val(form, 'slot') });
      toast('התור הועבר');
      reload();
    }, 'העברה');
  }

  /** @param {any} b */
  function bookDialog(b) {
    if (!unbooked.length) { toast('כל התלמידים כבר נרשמו', 'err'); return; }
    formDialog(`קביעת תור ל-${fullDayLabelFromTs(b.starts_at)}, ${timeLabel(b.starts_at)}`, h('div', null,
      field('תלמיד', h('select', { name: 'student', required: true },
        ...unbooked.map((/** @type {any} */ s) => h('option', { value: s.student_id }, `${s.full_name} (${s.class_name})`))))), async (form) => {
      await rpc('staff_book', { p_student_id: val(form, 'student'), p_slot_id: b.slot_id });
      toast('התור נקבע');
      reload();
    }, 'קביעה');
  }

  /** @param {any} b */
  function noteDialog(b) {
    formDialog(`הערה פנימית – ${b.student_name}`, h('div', null,
      h('p', { class: 'muted small' }, 'ההערה גלויה רק לך (ולהנהלה). היא לעולם לא מוצגת להורים או לרבנים אחרים.'),
      field('הערה', h('textarea', { name: 'note', maxlength: '2000' }, data.notes.get(b.appointment_id) || ''))), async (form) => {
      const el = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('note'));
      await rpc('staff_save_note', { p_appointment_id: b.appointment_id, p_text: el.value });
      toast('ההערה נשמרה');
      reload();
    });
  }

  async function exportBoard() {
    const rows = data.board.map((/** @type {any} */ b) => [
      fullDayLabelFromTs(b.starts_at), localDateKey(b.starts_at).split('-').reverse().join('.'), timeRangeLabel(b.starts_at, b.ends_at),
      b.appointment_id ? 'תפוס' : b.slot_status === 'blocked' ? 'חסום' : 'פנוי', b.student_name || '', b.class_name || '',
    ]);
    await exportXlsx(`תורים-${ctx.teacherName}-${conf.title}.xlsx`, 'תורים',
      ['יום ותאריך', 'תאריך לועזי', 'שעה', 'מצב', 'תלמיד', 'כיתה'], rows, `${conf.title} – ${ctx.teacherName}`);
  }
}
