// הודעות שגיאה קצרות וברורות בעברית. לא חושפות אם מספר זהות קיים.
const MESSAGES = {
  invalid_id: 'מספר הזהות אינו תקין. בדקו את הספרות ונסו שוב.',
  not_found: 'לא נמצאו אסיפות זמינות עבור הפרטים שהוזנו. אם לדעתכם זו טעות, פנו למזכירות הישיבה.',
  code_required: 'יש להזין קוד אישי בן 4 ספרות.',
  rate_limited: 'בוצעו ניסיונות רבים מדי. נסו שוב בעוד כמה דקות.',
  session_expired: 'פג תוקף הכניסה. הזינו שוב את מספר הזהות.',
  slot_taken: 'השעה נתפסה, בחרו שעה אחרת.',
  slot_unavailable: 'השעה אינה זמינה, בחרו שעה אחרת.',
  slot_not_found: 'השעה אינה זמינה, בחרו שעה אחרת.',
  slot_in_past: 'לא ניתן לקבוע תור לשעה שעברה.',
  already_booked: 'כבר נקבע תור לאסיפה זו.',
  conference_not_open: 'האסיפה אינה פתוחה להרשמה כעת.',
  wrong_teacher: 'השעה שנבחרה אינה של הרב המשויך.',
  student_not_found: 'התלמיד אינו פעיל במערכת.',
  invalid_credentials: 'מספר הזהות או הסיסמה שגויים.',
  not_authorized: 'אין הרשאה לפעולה זו.',
  availability_overlap: 'החלון חופף לחלון זמינות קיים.',
  window_must_be_single_day: 'חלון זמינות חייב להיות באותו יום.',
  window_outside_conference_dates: 'התאריך מחוץ לטווח התאריכים של האסיפה.',
  window_has_appointments: 'יש תורים בחלון זה. יש לבטל או להעביר אותם קודם.',
  block_overlaps_appointments: 'יש תורים בזמן זה. יש לבטל או להעביר אותם לפני החסימה.',
  slot_has_appointment: 'יש תור בסלוט זה.',
  teacher_not_in_conference: 'הרב אינו משויך לאסיפה זו.',
  conference_archived: 'האסיפה בארכיון ולא ניתן לשנות אותה.',
  invalid_duration: 'משך פגישה חייב להיות בין 5 ל-120 דקות.',
  invalid_range: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה.',
  student_has_active_appointments: 'לתלמיד יש תור פעיל. יש לבטל או להעביר את התור לפני שינוי הרב.',
  national_id_exists: 'מספר זהות זה כבר קיים במערכת.',
  invalid_national_id: 'מספר זהות לא תקין.',
  class_name_exists: 'כיתה בשם זה כבר קיימת.',
  teacher_inactive: 'הרב שנבחר אינו פעיל.',
  teacher_has_students: 'לא ניתן להשבית רב שיש לו תלמידים פעילים. העבירו את התלמידים קודם.',
  teacher_has_appointments: 'לרב יש תורים באסיפה זו.',
  cannot_demote_self: 'לא ניתן להסיר הרשאת מנהל מעצמך.',
  invalid_status_transition: 'מעבר סטטוס לא חוקי.',
  windows_outside_range: 'יש חלונות זמינות מחוץ לטווח התאריכים החדש.',
  invalid_settings: 'ערך לא תקין בהגדרות (בדקו את קישור ה-Waze והלוגו).',
  invalid_code: 'קוד אישי חייב להיות בן 4 ספרות.',
  code_required_mode_on: 'דרישת קוד אישי פעילה – לא ניתן למחוק קוד לתלמיד פעיל.',
  students_missing_code: 'לא ניתן להפעיל: יש תלמידים פעילים ללא קוד אישי.',
  weak_password: 'הסיסמה חלשה: לפחות 10 תווים, כולל אותיות וספרות.',
  staff_exists: 'איש צוות עם מספר זהות זה כבר קיים.',
  bootstrap_disabled: 'כבר קיים מנהל במערכת. ההקמה הראשונית נסגרה.',
  bootstrap_not_configured: 'קוד ההקמה עדיין לא נשמר ב-Supabase (BOOTSTRAP_TOKEN, לפחות 20 תווים).',
  bootstrap_token_invalid: 'קוד ההקמה שגוי.',
  class_not_allowed: 'אפשר לשייך תלמיד רק לכיתה שמשויכת אליך. מנהל יכול לשייך כיתות בלשונית "כיתות ורבנים".',
  confirm_title_mismatch: 'השם שהוקלד אינו תואם לשם האסיפה. המחיקה לא בוצעה.',
  note_too_long: 'ההערה ארוכה מדי.',
  network: 'בעיית תקשורת. בדקו את החיבור לאינטרנט ונסו שוב.',
  not_configured: 'המערכת עדיין לא הוגדרה (חסרה כתובת Supabase בקובץ config.js).',
};

/** @param {unknown} err */
export function errorMessage(err) {
  /** @type {string} */
  let code = '';
  if (typeof err === 'string') code = err;
  else if (err && typeof err === 'object') {
    const e = /** @type {{message?: string, error?: string, code?: string}} */ (err);
    code = e.error || e.message || '';
  }
  if (code in MESSAGES) return MESSAGES[/** @type {keyof typeof MESSAGES} */ (code)];
  // הודעות מ-Postgres מגיעות לעיתים עם טקסט נוסף – מחפשים את הקוד הארוך ביותר שמופיע
  const keys = Object.keys(MESSAGES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (code.includes(key)) return MESSAGES[/** @type {keyof typeof MESSAGES} */ (key)];
  }
  return 'אירעה שגיאה. נסו שוב.';
}
