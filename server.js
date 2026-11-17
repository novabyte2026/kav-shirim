// קו שירים AI - מתקשרים, אומרים שם של שיר, והוא מתנגן מיוטיוב.
//
// איך זה עובד, בקצרה:
//   1. המתקשר מקליט את שם השיר.
//   2. ג'מיני מתמלל את ההקלטה.
//   3. חיפוש ביוטיוב דרך InnerTube (ה-API הפנימי, בלי מפתח ובלי מכסה).
//   4. yt-dlp מזרים את האודיו ל-stdout, ו-ffmpeg חותך אותו לקטעים של
//      SEG_SEC שניות בפורמט טלפון (8kHz מונו).
//   5. כל קטע שמוכן נעלה לשלוחה של ימות, והקטע הראשון מתחיל להתנגן
//      תוך שניות - בזמן שהשאר עוד זורמים. השיר כולו לא יורד אף פעם.
//
// למה קטעים ולא קובץ אחד: ימות לא יודעת לעצור קובץ באמצע השמעה ולא
// יודעת להשמיע כתובת אינטרנט. קטעים קצרים נותנים גם התחלה מיידית וגם
// אפשרות לעצור בהקשה.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.urlencoded({ extended: true }));

// ---------- הגדרות ----------
const TOKEN = process.env.YEMOT_TOKEN || '';
const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';

const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const STT_MODEL = String(process.env.STT_MODEL || 'gemini-3.5-flash').trim();

// הנתיבים של הכלים. ב-Docker הם מוגדרים מפורשות כדי שלא נהיה תלויים ב-PATH.
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// ספק ה-PO Token (bgutil). בלעדיו יוטיוב מחזיר "Sign in to confirm you're not a bot"
// לכל בקשה משרת בענן. ראו Dockerfile.
const POT_BASE_URL = process.env.POT_BASE_URL || 'http://127.0.0.1:4416';

// עוגיות יוטיוב: מכתובת דאטה-סנטר (ענן) ה-PO Token לבדו לא תמיד עובר את
// בדיקת הבוט, וצריך עוגיות של חשבון מחובר. מחלצים אותן עם tools/firefox_cookies.py
// ומדביקים כ-COOKIES_B64. הפענוח כאן סלחני לכל צורות ההדבקה (base64, UTF-16,
// BEGIN/END, או טקסט Netscape גולמי) - תואם ל-cookies.js של הפרויקט הקודם.
const COOKIES_B64 = process.env.COOKIES_B64 || '';
let COOKIE_FILE = '';
function setupCookies() {
  const raw = COOKIES_B64.trim();
  if (!raw) { console.log('עוגיות: לא הוגדרו (COOKIES_B64 ריק)'); return; }
  try {
    let text;
    if (raw.includes('\t') || /^#\s*(Netscape\s+)?HTTP Cookie File/i.test(raw)) {
      text = raw; // כבר טקסט Netscape
    } else {
      const b64 = raw.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
      const buf = Buffer.from(b64, 'base64');
      const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 1 && buf[1] === 0);
      text = buf.toString(utf16 ? 'utf16le' : 'utf8');
    }
    const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
    // yt-dlp דוחה קובץ בלי שורת הכותרת הזאת
    const header = /^#\s*(Netscape\s+)?HTTP Cookie File/i.test(body) ? '' : '# Netscape HTTP Cookie File\n';
    COOKIE_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(COOKIE_FILE, header + body + '\n');
    const lines = body.split('\n').filter(l => l && !l.startsWith('#'));
    const hasLogin = /__Secure-3PSID|__Secure-1PSID|\bSID\b/.test(body);
    console.log('עוגיות: נטענו ' + lines.length + ' שורות' + (hasLogin ? ' (כולל עוגיית התחברות)' : ' (ללא עוגיית התחברות - אולי לא מחובר)'));
  } catch (e) {
    console.error('עוגיות: פענוח נכשל -', e.message);
    COOKIE_FILE = '';
  }
}

// שלוחת הקבצים בימות: שם נשמרות ההקלטות והקטעים. תיקייה רגילה, לא API.
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '');
const EXTP = '/' + EXT;

const REC_MAX = String(Math.min(30, Math.max(3, parseInt(process.env.REC_MAX, 10) || 10)));
const SEG_SEC = Math.min(30, Math.max(4, parseInt(process.env.SEG_SEC, 10) || 15));
// כמה קטעים נותנים לימות בכל סבב.
// בין קבוצת קטעים לבאה ימות חוזרת לשרת, וזה יוצר רווח של כמה מאות
// מילישניות. SEG_SEC * CHAIN = כמה שניות מוזיקה בין רווח לרווח, ולכן
// ככל שהמכפלה גדולה יותר כך יש פחות רווחים. הקשה עוצרת מיד בכל מקרה
// (ימות קוטעת את ההשמעה), ולכן שרשרת ארוכה לא פוגעת בתגובה להקשה.
// ברירת המחדל: 15 * 4 = דקה של מוזיקה רצופה בין רווח לרווח.
const CHAIN = Math.min(8, Math.max(1, parseInt(process.env.CHAIN, 10) || 4));
const MAX_SEC = Math.min(1800, Math.max(60, (parseInt(process.env.SONG_MAX_MIN, 10) || 10) * 60));
// עד כמה קטעים מעלים מראש לפני מקום ההשמעה. מונע העלאת שיר שלם שידלגו עליו.
const LOOKAHEAD = Math.min(40, Math.max(2, parseInt(process.env.LOOKAHEAD, 10) || 8));
const PREP_MS = Math.min(180000, Math.max(10000, parseInt(process.env.PREP_MS, 10) || 75000));

// שיפור השמע לטלפון. קו טלפון הוא 8kHz, ומוזיקה נשמעת בו חלשה ועמומה
// כי יש לה טווח דינמי רחב. dynaudnorm מיישר את עוצמת הקול כך שגם
// הקטעים השקטים נשמעים, ו-highpass מוריד רעש נמוך שמבזבז עוצמה.
// ניתן לכבות או לשנות במשתנה AUDIO_FILTER (ערך ריק = בלי עיבוד).
const AUDIO_FILTER = process.env.AUDIO_FILTER === undefined
  ? 'highpass=f=100,dynaudnorm=f=150:g=15'
  : String(process.env.AUDIO_FILTER).trim();

const PORT = process.env.PORT || 3000;

// ---------- עוזרים ----------
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ימות לא מקריאה את התווים האלה, ופסיק ושווה שוברים את התחביר של read=
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();
const yp = name => 'ivr2:' + EXTP + '/' + name + (/\.[a-z0-9]+$/i.test(name) ? '' : '.wav');
const pad = n => String(n).padStart(5, '0');

async function http(url, opt, ms) {
  return fetch(url, { ...opt, signal: AbortSignal.timeout(ms || 15000) });
}

// ---------- ג'מיני: תמלול ההקלטה ----------
let keyRot = 0;
async function transcribe(buf) {
  if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק');
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: 'המשתמש הקליט בקשה לשיר. החזר אך ורק את שם השיר או את מה שנאמר, כטקסט נקי, בלי הסבר, בלי מרכאות ובלי שום תוספת. אם לא נשמע כלום החזר מילה אחת: ריק' },
        { inlineData: { mimeType: 'audio/wav', data: buf.toString('base64') } }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 120 }
  };
  let err = 'תמלול נכשל';
  for (let i = 0; i < KEYS.length + 1; i++) {
    const key = KEYS[keyRot++ % KEYS.length];
    try {
      const r = await http(GBASE + STT_MODEL + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, 25000);
      if (r.ok) {
        const j = await r.json();
        const t = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        const text = t.map(p => p.text || '').join('').trim();
        if (text && text !== 'ריק') return text;
        return '';
      }
      err = 'ג׳מיני ' + r.status + ' ' + (await r.text()).slice(0, 160);
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) {
      err = 'ג׳מיני ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    await sleep(400 * (i + 1));
  }
  throw new Error(err);
}

// ---------- חיפוש יוטיוב דרך InnerTube ----------
// ה-API הפנימי של יוטיוב. בלי מפתח, בלי מכסה יומית, ועובד בעברית.
// המפתח הציבורי הזה מוטמע בדף הבית של יוטיוב עצמו.
const INNERTUBE_KEY = process.env.INNERTUBE_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

function runs(node) {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text).join('');
  return '';
}
// הליכה רקורסיבית: אוספת כל videoRenderer בכל עומק, כך שאין תלות במבנה
// התשובה (שמשתנה בין שפות, שורטס ומדפים).
function collectVideos(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectVideos(x, out, seen); return; }
  const v = node.videoRenderer;
  if (v && v.videoId && !seen.has(v.videoId)) {
    seen.add(v.videoId);
    const len = (v.lengthText && v.lengthText.simpleText) || '';
    out.push({ id: v.videoId, title: runs(v.title), channel: runs(v.ownerText) || runs(v.longBylineText), len });
  }
  for (const k in node) collectVideos(node[k], out, seen);
}

async function ytSearch(q) {
  const r = await http('https://www.youtube.com/youtubei/v1/search?key=' + INNERTUBE_KEY + '&prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'he', gl: 'IL' } },
      query: q
    })
  }, 15000);
  // זיהוי מסנן תוכן בדרך: נטפרי וכדומה מחזירים דף HTML במקום JSON.
  // זה קורה כשהשרת רץ מאחורי חיבור מסונן, ולא בענן.
  const ct = r.headers.get('content-type') || '';
  if (r.status === 418 || ct.includes('text/html')) {
    throw new Error('יוטיוב חסום מהשרת הזה (' + r.status + '). השרת חייב לרוץ על חיבור לא מסונן');
  }
  if (!r.ok) throw new Error('חיפוש יוטיוב ' + r.status);
  const items = [];
  collectVideos(await r.json(), items, new Set());
  // מסננים שידורים חיים (אין להם אורך) - yt-dlp לא מזרים אותם טוב
  return items.filter(x => x.len).slice(0, 10);
}

// ---------- ימות: העלאה, הורדה, מחיקה ----------
async function upload(name, buf, ms) {
  const attempts = [
    { q: true, field: 'file' }, { q: true, field: 'upload' },
    { q: false, field: 'upload' }, { q: false, field: 'file' }
  ];
  let last = '';
  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) url += '?token=' + enc(TOKEN) + '&path=' + enc(yp(name)) + '&convertAudio=1';
      else { f.append('token', TOKEN); f.append('path', yp(name)); f.append('convertAudio', '1'); }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', body: f }, ms || 20000);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 160);
    } catch (e) { last = e.message; }
  }
  throw new Error('העלאה נכשלה ' + last);
}

async function download(name) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await http(YM + 'DownloadFile?token=' + enc(TOKEN) + '&path=' + enc(yp(name)), {}, 10000);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) { last = e.message; }
    await sleep(500);
  }
  throw new Error('הורדת ההקלטה נכשלה ' + last);
}

// מחיקה היא "כמה שיוצא" ואף פעם לא מעכבת או מפילה שיחה
function del(name) {
  fetch(YM + 'FileAction?token=' + enc(TOKEN) + '&action=delete&what=' + enc(yp(name)), {
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});
}

// ---------- קובץ שקט לרגעי המתנה ----------
// ימות חייבת להשמיע משהו בכל סבב. במקום לחזור על "רגע" שוב ושוב,
// משמיעים שנייה של שקט. הקובץ נוצר ומועלה פעם אחת.
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const SIL = 'kavsil';
let silP = null;
function ensureSilence() {
  if (!TOKEN) return Promise.resolve(false);
  if (!silP) {
    silP = upload(SIL, wav(Buffer.alloc(8000 * 2), 8000), 15000)
      .then(() => true)
      .catch(e => { console.error('העלאת קובץ השקט נכשלה:', e.message); silP = null; return false; });
  }
  return silP;
}

// ---------- הזרמה: yt-dlp -> ffmpeg -> קטעים -> ימות ----------
// הנוסחה המדויקת שעובדת מול יוטיוב משרת בענן: ספק PO Token + לקוח mweb.
function ytdlpArgs(url) {
  return [
    // בלי --no-warnings, כדי שאזהרות על PO Token ועל פורמטים שדולגו יופיעו בלוג
    '--no-playlist', '--no-progress',
    '--extractor-args', 'youtubepot-bgutilhttp:base_url=' + POT_BASE_URL,
    // tv ו-web_safari הם הלקוחות היציבים ביותר לחילוץ אודיו ב-2026 (mweb הפך
    // ל-SABR בחלק מהסשנים). mweb נשאר כגיבוי. כולם עוברים דרך ספק ה-PO Token.
    // ניתן לעקוף במשתנה YT_CLIENTS בלי לשנות קוד.
    '--extractor-args', 'youtube:player_client=' + (process.env.YT_CLIENTS || 'tv,web_safari,mweb'),
    ...(COOKIE_FILE ? ['--cookies', COOKIE_FILE] : []),
    // מנוע JavaScript לפתרון אתגרי החתימה של יוטיוב: Deno מותקן בתמונה
    // והוא ברירת המחדל של yt-dlp, ולכן אין צורך בדגל. (ערך עם פסיק כמו
    // "deno,node" נדחה כשם מנוע אחד שלא קיים, ולכן הוסר.)
    ...(process.env.YT_JS_RUNTIMES ? ['--js-runtimes', process.env.YT_JS_RUNTIMES] : []),
    // סקריפטי הפענוח (yt-dlp-ejs) לא מגיעים עם הבינארי הזה, ולכן
    // נמשכים מגיטהאב בפעם הראשונה ונשמרים במטמון.
    '--remote-components', process.env.YT_EJS || 'ejs:github',
    '--extractor-retries', '3',
    '--socket-timeout', '20',
    // bestaudio, ואם אין - פורמט 18 (אודיו+וידאו משולב, תמיד זמין ולא SABR);
    // ffmpeg מוציא ממנו רק את האודיו. ניתן לעקוף במשתנה YT_FORMAT.
    '-f', process.env.YT_FORMAT || 'bestaudio/18/best',
    '-o', '-', url
  ];
}

// מפעיל את הצינור ומחזיר מיד. s.segs מתמלא ברקע.
function startStream(s, videoId) {
  s.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kav-'));
  s.base = 'k' + s.e + 'x';
  s.segs = [];
  s.idx = 0;
  s.ffDone = false;
  s.pumpDone = false;
  s.stopped = false;
  // שיר חדש באותה שיחה: מאפסים את דגל הניקוי, אחרת הקטעים של השיר הזה
  // לא יימחקו מימות בסוף השיחה (cleanup רץ פעם אחת בלבד).
  s.cleaned = false;
  s.played = null;

  const url = 'https://www.youtube.com/watch?v=' + videoId;
  const dl = spawn(YTDLP, ytdlpArgs(url), { stdio: ['ignore', 'pipe', 'pipe'] });
  const ff = spawn(FFMPEG, [
    '-y', '-v', 'error',
    '-i', 'pipe:0',
    '-vn', '-t', String(MAX_SEC),
    ...(AUDIO_FILTER ? ['-af', AUDIO_FILTER] : []),
    '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
    '-f', 'segment', '-segment_time', String(SEG_SEC), '-reset_timestamps', '1',
    path.join(s.dir, 'p%05d.wav')
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  s.procs = [dl, ff];
  let dlErr = '', ffErr = '';
  dl.stderr.on('data', d => { dlErr += d.toString(); });
  ff.stderr.on('data', d => { ffErr += d.toString(); });
  dl.stdout.pipe(ff.stdin);
  // המתקשר עצר באמצע: ffmpeg נסגר, ו-yt-dlp ממשיך לכתוב לצינור שבור
  dl.stdout.on('error', () => {});
  ff.stdin.on('error', () => {});
  dl.on('error', e => { dlErr += ' ' + e.message; });
  ff.on('error', e => { ffErr += ' ' + e.message; });

  ff.on('close', () => {
    s.ffDone = true;
    // השגיאה האמיתית של yt-dlp יושבת בסוף הפלט, לכן לוקחים את הזנב ולא את הראש
    if (dlErr.trim()) console.error('yt-dlp:', dlErr.trim().slice(-1500));
    if (ffErr.trim()) console.error('ffmpeg:', ffErr.trim().slice(-400));
  });

  s.pump = pump(s).catch(e => { console.error('העלאת קטעים נכשלה:', e.message); s.pumpDone = true; });
  return s;
}

// קטע שלם רק כשהבא אחריו נפתח (או כש-ffmpeg סיים). מעלים בסדר.
async function pump(s) {
  let k = 0;
  for (;;) {
    if (s.stopped) break;
    const cur = path.join(s.dir, 'p' + pad(k) + '.wav');
    const next = path.join(s.dir, 'p' + pad(k + 1) + '.wav');
    const haveCur = fs.existsSync(cur);
    if (haveCur && (fs.existsSync(next) || s.ffDone)) {
      // לא רצים רחוק מדי לפני ההשמעה
      while (!s.stopped && s.segs.length - s.idx > LOOKAHEAD) await sleep(400);
      if (s.stopped) break;
      const name = s.base + pad(k);
      const buf = fs.readFileSync(cur);
      fs.rm(cur, { force: true }, () => {});
      // קטע זעיר בסוף (שבריר שנייה) רק יישמע כנקישה
      if (buf.length > 4000) {
        await upload(name, buf, 25000);
        s.segs.push(name);
      }
      k++;
      continue;
    }
    if (s.ffDone && !haveCur) break;
    await sleep(250);
  }
  s.pumpDone = true;
}

// ניקוי: הורג תהליכים, מוחק קטעים מימות ומוחק את התיקייה הזמנית
function cleanup(s) {
  if (!s || s.cleaned) return;
  s.cleaned = true;
  s.stopped = true;
  for (const p of s.procs || []) { try { p.kill('SIGKILL'); } catch (e) {} }
  for (const n of s.segs || []) del(n);
  if (s.rec) del(s.rec);
  if (s.dir) fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

// ---------- מצב השיחות ----------
const calls = {};
const idOf = q => String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';

// שיחות שלא שלחו hangup נזרקות אחרי שעה
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) {
    if (now - calls[id].t > 3600000) { cleanup(calls[id]); delete calls[id]; }
  }
}, 600000).unref();

// ---------- תחביר התשובות לימות ----------
// כל סבב חייב שם פרמטר חדש: ימות מצטברת פרמטרים לאורך השיחה, ופרמטר
// שחוזר כבר "מלא" ולכן השאלה לא תישאל שוב.
const param = (s, pre) => { s.n++; return pre + s.e + s.n; };

// מבקש הקלטה של שם השיר
function askSong(s, msg) {
  s.stage = 'ask';
  s.p = param(s, 'Q');
  s.rec = 'r' + s.e + s.n;
  return 'read=' + msg + '=' + s.p + ',no,record,' + EXTP + ',' + s.rec + ',no,,,1,' + REC_MAX;
}
// משמיע הודעות וממתין שנייה להקשה. Ok,None = מותר גם בלי הקשה,
// וכך ימות חוזרת לשרת בין אם הוקש משהו ובין אם לא.
function chain(s, msgs, pre) {
  s.p = param(s, pre || 'P');
  return 'read=' + msgs.join('.') + '=' + s.p + ',no,1,1,1,No,no,no,,,,Ok,None';
}
const digitsOf = v => { const x = String(v == null ? '' : v).trim(); return x === 'None' ? '' : x; };

const GREET = sp(process.env.GREETING || 'שלום. אמור את שם השיר שתרצה לשמוע ובסיום הקש סולמית');
const AGAIN = sp('לא שמעתי. אמור את שם השיר ובסיום הקש סולמית');
const NOTFOUND = sp('לא מצאתי שיר כזה. אמור שם אחר ובסיום הקש סולמית');
const ERR = sp('הייתה תקלה. אמור את שם השיר שוב ובסיום הקש סולמית');
const DONE = sp('השיר נגמר. לשיר נוסף אמור את שמו ובסיום הקש סולמית');
const STOPPED = sp('עצרתי. לשיר נוסף אמור את שמו ובסיום הקש סולמית');

// ---------- הכנת שיר: תמלול, חיפוש, התחלת הזרמה ----------
async function prepare(s) {
  const buf = await download(s.rec);
  del(s.rec);
  s.rec = null;

  const said = await transcribe(buf);
  if (!said) return { ask: AGAIN };
  console.log('בקשה:', said);

  const items = await ytSearch(said);
  if (!items.length) return { ask: NOTFOUND };

  s.results = items;
  s.pick = 0;
  startStream(s, items[0].id);
  return { track: items[0] };
}

// ---------- הזרימה של הסבבים ----------
async function step(s, q) {
  const key = digitsOf(q[s.p]);

  // מחכים שההכנה תסתיים
  if (s.stage === 'wait') {
    const r = await Promise.race([s.job, sleep(7000).then(() => null)]);
    if (r === null) {
      if (Date.now() - s.t0 > PREP_MS) { s.job = null; return askSong(s, 't-' + ERR); }
      // שנייה של שקט ואז נבדוק שוב
      return chain(s, [(await ensureSilence()) ? 'f-' + EXTP + '/' + SIL : 't- '], 'W');
    }
    s.job = null;
    if (r.ask) return askSong(s, 't-' + r.ask);
    s.stage = 'play';
    // מכריזים את מה שנמצא, ומיד אחר כך מתחיל השיר
    return chain(s, ['t-' + sp('מנגן ' + r.track.title)], 'A');
  }

  // השמעה
  if (s.stage === 'play') {
    if (key) { cleanup(s); s.segs = []; s.idx = 0; return askSong(s, 't-' + STOPPED); }

    const ready = s.segs.length - s.idx;
    if (ready <= 0) {
      if (s.pumpDone) { cleanup(s); s.segs = []; s.idx = 0; return askSong(s, 't-' + DONE); }
      return chain(s, [(await ensureSilence()) ? 'f-' + EXTP + '/' + SIL : 't- '], 'S');
    }
    const msgs = [];
    for (let k = 0; k < CHAIN && s.idx < s.segs.length; k++) {
      const name = s.segs[s.idx++];
      msgs.push('f-' + EXTP + '/' + name);
      // קטע שהושמע כבר לא נחוץ. מוחקים אותו אחרי שהושמע, בפיגור של סבב.
      if (s.played) del(s.played);
      s.played = name;
    }
    return chain(s, msgs, 'P');
  }

  // קיבלנו את ההקלטה: מתחילים להכין ברקע ומודיעים למתקשר
  if (s.stage === 'ask') {
    if (q[s.p] === undefined) return askSong(s, 't-' + AGAIN);
    s.stage = 'wait';
    s.t0 = Date.now();
    s.job = prepare(s).catch(e => {
      console.error('הכנה נכשלה:', e && e.message);
      return { ask: ERR };
    });
    return chain(s, ['t-' + sp('רגע מחפש')], 'W');
  }

  return askSong(s, 't-' + GREET);
}

// ---------- הכתובות ----------
app.get('/', (q, r) => { r.set('Access-Control-Allow-Origin', '*'); r.send('ok'); });

app.all('/yemot', async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = idOf(q);
  res.type('text/plain');
  try {
    if (q.hangup === 'yes') {
      if (calls[id]) { cleanup(calls[id]); delete calls[id]; }
      return res.send('noop=bye');
    }
    let s = calls[id];
    if (!s) {
      s = calls[id] = { e: crypto.randomBytes(3).toString('hex'), n: 0, t: Date.now(), stage: '', segs: [], idx: 0 };
      ensureSilence();
      return res.send(askSong(s, 't-' + GREET));
    }
    s.t = Date.now();
    res.send(await step(s, q));
  } catch (e) {
    console.error(id, 'fatal', e && e.message);
    // תמיד עונים לימות בטקסט, אף פעם לא בשגיאה או בריק
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// בדיקה שכל החיבורים עובדים, בלי להרים שיחה
app.get('/selftest', async (req, res) => {
  const out = {};
  const t = async (name, fn) => {
    const t0 = Date.now();
    try { out[name] = { ok: true, ms: Date.now() - t0, info: await fn() }; }
    catch (e) { out[name] = { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 200) }; }
  };

  await t('yemot_token', async () => {
    if (!TOKEN) throw new Error('YEMOT_TOKEN ריק');
    const r = await http(YM + 'GetIVR2Dir?token=' + enc(TOKEN) + '&path=' + enc('ivr2:' + EXTP), {}, 12000);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 160));
    return 'שלוחה ' + EXTP + ' נגישה';
  });
  // בטיחות: מראה מה כבר יושב בשלוחת הקבצים, כדי שלא נשתמש בשלוחה
  // שמשרתת משהו אחר. השרת לעולם לא מוחק קובץ שהוא לא יצר (כל השמות
  // שלו מתחילים ב-k או ב-r ואחריהם מזהה השיחה), אבל עדיף שלוחה ריקה.
  await t('ext_contents', async () => {
    if (!TOKEN) throw new Error('YEMOT_TOKEN ריק');
    const r = await http(YM + 'GetIVR2Dir?token=' + enc(TOKEN) + '&path=' + enc('ivr2:' + EXTP), {}, 12000);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 160));
    // רק j.files הם הקבצים שבשלוחה עצמה. אסור לסרוק את התשובה כטקסט:
    // השדה messages הוא קטלוג הודעות המערכת של ימות (365 קבצי M####.wav)
    // והוא גורם לאזהרת שווא.
    const names = (j.files || []).map(f => f.name).filter(Boolean);
    const mine = names.filter(n => /^(k[0-9a-f]{6}x|r[0-9a-f]{6}|kavsil)/.test(n));
    const other = names.filter(n => !mine.includes(n));
    if (other.length) {
      return 'אזהרה: בשלוחה ' + EXTP + ' יש ' + other.length +
        ' קבצים שאינם של הקו (' + other.slice(0, 5).join(', ') +
        '). הם לא יימחקו, אבל מומלץ שלוחה ריקה: שנה EXT_PATH';
    }
    return 'שלוחה ' + EXTP + ' ריקה ופנויה' + (mine.length ? ' (' + mine.length + ' קבצים שלנו)' : '');
  });
  await t('gemini', async () => {
    if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק');
    return KEYS.length + ' מפתחות, מודל ' + STT_MODEL;
  });
  await t('youtube_search', async () => {
    const r = await ytSearch('שיר');
    if (!r.length) throw new Error('החיפוש לא החזיר תוצאות');
    return r.length + ' תוצאות, הראשונה: ' + r[0].title;
  });
  await t('pot_provider', async () => {
    const r = await http(POT_BASE_URL + '/ping', {}, 8000).catch(() => null);
    if (!r) throw new Error('לא מאזין ב-' + POT_BASE_URL + ' (יוטיוב ייחסם)');
    return 'מאזין';
  });
  await t('cookies', async () => {
    if (!COOKIE_FILE) throw new Error('COOKIES_B64 ריק - מכתובת ענן יוטיוב עלול לחסום בלי עוגיות');
    const body = fs.readFileSync(COOKIE_FILE, 'utf8');
    if (!/__Secure-3PSID|__Secure-1PSID|\bSID\b/.test(body)) throw new Error('אין עוגיית התחברות - ייתכן שלא היית מחובר ליוטיוב');
    return 'נטענו (כולל עוגיית התחברות)';
  });
  await t('ytdlp', () => new Promise((ok, bad) => {
    const p = spawn(YTDLP, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('error', e => bad(new Error(YTDLP + ': ' + e.message)));
    p.on('close', c => (c === 0 ? ok(o.trim()) : bad(new Error('יצא עם קוד ' + c))));
  }));
  await t('deno', () => new Promise((ok, bad) => {
    const p = spawn('deno', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('error', () => bad(new Error('deno לא מותקן - yt-dlp לא יוכל לפתור חתימות יוטיוב')));
    p.on('close', c => (c === 0 ? ok(o.split('\n')[0]) : bad(new Error('יצא עם קוד ' + c))));
  }));
  await t('ffmpeg', () => new Promise((ok, bad) => {
    const p = spawn(FFMPEG, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('error', e => bad(new Error(FFMPEG + ': ' + e.message)));
    p.on('close', c => (c === 0 ? ok(o.split('\n')[0]) : bad(new Error('יצא עם קוד ' + c))));
  }));

  // משאבים: קריטי בתוכניות חינמיות קטנות (למשל 512MB ב-Render),
  // שם ספק ה-PO Token עלול להיהרג בזיכרון.
  const mb = n => Math.round(n / 1048576);
  const mem = process.memoryUsage();
  out.resources = {
    ok: true,
    info: 'זיכרון בתהליך: ' + mb(mem.rss) + 'MB | פנוי במכונה: ' + mb(os.freemem()) +
      'MB מתוך ' + mb(os.totalmem()) + 'MB | ליבות: ' + os.cpus().length
  };

  const allOk = Object.values(out).every(x => x.ok);
  res.status(allOk ? 200 : 500).json({ ok: allOk, checks: out });
});

// בדיקת חילוץ אמיתית: מחזירה את הזרם הראשון שיוטיוב נותן, בלי ימות
app.get('/trystream', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'חסר ?q=' });
  try {
    const items = await ytSearch(q);
    if (!items.length) return res.json({ found: 0 });
    const s = { e: 'test' + crypto.randomBytes(2).toString('hex'), segs: [], idx: 0 };
    s.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kavtest-'));
    const dl = spawn(YTDLP, ytdlpArgs('https://www.youtube.com/watch?v=' + items[0].id), { stdio: ['ignore', 'pipe', 'pipe'] });
    const ff = spawn(FFMPEG, ['-y', '-v', 'error', '-i', 'pipe:0', '-vn', '-t', '12',
      ...(AUDIO_FILTER ? ['-af', AUDIO_FILTER] : []),
      '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(s.dir, 'out.wav')], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    dl.stderr.on('data', d => { err += d.toString(); });
    ff.stderr.on('data', d => { err += d.toString(); });
    dl.stdout.pipe(ff.stdin);
    dl.stdout.on('error', () => {});
    ff.stdin.on('error', () => {});
    const t0 = Date.now();
    const code = await new Promise(r => { ff.on('close', r); setTimeout(() => { try { dl.kill(); ff.kill(); } catch (e) {} r(-1); }, 90000); });
    const f = path.join(s.dir, 'out.wav');
    const bytes = fs.existsSync(f) ? fs.statSync(f).size : 0;
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
    try { dl.kill(); } catch (e) {}
    res.json({
      title: items[0].title, videoId: items[0].id,
      ms: Date.now() - t0, ffmpegExit: code, wavBytes: bytes,
      ok: bytes > 10000,
      stderr: err.trim().slice(-1200) || undefined
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message).slice(0, 300) });
  }
});

setupCookies();
app.listen(PORT, () => {
  console.log('קו שירים AI מאזין על פורט ' + PORT);
  console.log('  שלוחת קבצים: ' + EXTP + ' | קטע: ' + SEG_SEC + 'ש | שרשרת: ' + CHAIN);
  console.log('  yt-dlp: ' + YTDLP + ' | ffmpeg: ' + FFMPEG + ' | POT: ' + POT_BASE_URL);
  if (!TOKEN) console.log('  אזהרה: YEMOT_TOKEN לא הוגדר');
  if (!KEYS.length) console.log('  אזהרה: GEMINI_API_KEYS לא הוגדר');
});
