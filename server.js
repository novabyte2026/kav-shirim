// קו שירים - מתקשרים, אומרים שם של שיר, והוא נמשך מיוטיוב.
//
// הזרימה בשיחה (שלוחת API בימות, ברירת מחדל 7):
//   1. המתקשר אומר את שם השיר ומקיש סולמית (הקלטה).
//   2. ג'מיני מתמלל (כמה מודלים במקביל, כדי שעומס על אחד לא יפיל שיחה).
//      אם ג'מיני לא זמין - זיהוי הדיבור המובנה של ימות כגיבוי.
//   3. חיפוש ביוטיוב (InnerTube, בלי מפתח) ותפריט:
//        1 = להשמיע עכשיו (ממתינים להורדה ושומעים)
//        2 = רק לשמור בספרייה (יורד ברקע, אפשר להמשיך או לנתק)
//        3 = התוצאה הבאה   4 = חיפוש אחר
//   4. ההורדה: yt-dlp -> ffmpeg (8kHz מונו) -> קובץ אחד בשלוחת הספרייה.
//
// הספרייה (ברירת מחדל שלוחה 6) היא שלוחת השמעת קבצים רגילה של ימות. הקבצים
// ממוספרים 000, 001, ... כמו שימות מצפה, ולכן נכנסים לשלוחה ושומעים את כל
// המאגר עם מקשי הדפדוף הרגילים. האינדקס (איזה סרטון הוא איזה מספר) נשמר
// כקובץ טקסט בשלוחת העבודה, כך ששיר שכבר ירד מתנגן מיד בפעם הבאה.
//
// הכול רץ על Render חינמי (0.1 מעבד, 512MB): הורדה אחת בכל פעם, בלי הזרמה.

'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ======================================================================
// הגדרות
// ======================================================================
const env = process.env;
const int = (v, d, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));
const clean = v => String(v || '').replace(/^\/+|\/+$/g, '');
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

const TOKEN = String(env.YEMOT_TOKEN || '').trim();
const YM = env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const WORK = clean(env.EXT_PATH || '8');          // הקלטות, קובץ שקט, אינדקס
const LIB = clean(env.LIB_PATH || '6');           // ספריית השירים
const INDEX_FILE = 'kavlib.txt';

const KEYS = list(env.GEMINI_API_KEYS);
const GBASE = (env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/').replace(/\/*$/, '/');
// סדר עדיפות למודלים. lite קודם: פחות עומס, מהיר יותר, ומתמלל עברית היטב.
// בעלייה השרת שואל את גוגל אילו מודלים קיימים ומשלים את הרשימה לבד.
const STT_PREF = list(env.STT_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash');
const STT_MS = int(env.STT_MS, 28000, 8000, 90000);       // תקציב כולל לתמלול
const STT_REQ_MS = int(env.STT_REQ_MS, 15000, 4000, 60000); // בקשה בודדת
const STT_HEDGE_MS = int(env.STT_HEDGE_MS, 4000, 1000, 20000); // אחרי כמה זמן לשלוח במקביל למודל נוסף
// גיבוי: זיהוי הדיבור של ימות (צורך יחידות במערכת). 0 = כבוי.
const YEMOT_STT = env.YEMOT_STT !== '0';

const YTDLP = env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = env.FFMPEG_PATH || 'ffmpeg';
const POT = env.POT_BASE_URL === undefined ? 'http://127.0.0.1:4416' : String(env.POT_BASE_URL).trim();
const YT_CLIENTS = env.YT_CLIENTS || 'tv,web_safari,mweb';
const YT_FORMAT = env.YT_FORMAT || 'bestaudio[abr<=100]/bestaudio/18/best';
const AUDIO_FILTER = String(env.AUDIO_FILTER || '').trim();

const REC_MAX = int(env.REC_MAX, 10, 3, 30);
const MAX_SEC = int(env.SONG_MAX_MIN, 12, 1, 30) * 60;
const DL_MS = int(env.DL_MS, 300000, 60000, 900000);     // תקרה להורדה+המרה+העלאה
const WAIT_MS = int(env.WAIT_MS, 420000, 60000, 900000); // כמה זמן מתקשר ממתין לשיר
const PORT = env.PORT || 3000;

// ======================================================================
// עוזרים
// ======================================================================
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// טקסט להקראה: ימות לא מקריאה סימנים, ופסיק/שווה/נקודה שוברים את התחביר.
// משאירים אותיות (עברית ולועזית), ספרות ורווחים.
const say = s => String(s || '')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 160);

async function http(url, opt, ms) {
  return fetch(url, { ...(opt || {}), signal: AbortSignal.timeout(ms || 15000) });
}

// ======================================================================
// ימות: API
// ======================================================================
const ivr = p => 'ivr2:/' + clean(p);

async function ymGet(method, params, ms) {
  const qs = Object.entries({ token: TOKEN, ...params }).map(([k, v]) => k + '=' + enc(v)).join('&');
  const r = await http(YM + method + '?' + qs, {}, ms || 15000);
  const j = await r.json().catch(() => ({}));
  if (j.responseStatus !== 'OK') {
    const e = new Error(method + ': ' + short(j.message || JSON.stringify(j), 160));
    e.yemot = j;
    throw e;
  }
  return j;
}

async function ymPostForm(method, fields, ms) {
  const f = new FormData();
  f.append('token', TOKEN);
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  const r = await http(YM + method, { method: 'POST', body: f }, ms || 20000);
  const j = await r.json().catch(() => ({}));
  if (j.responseStatus !== 'OK') throw new Error(method + ': ' + short(j.message || JSON.stringify(j), 160));
  return j;
}

const listDir = p => ymGet('GetIVR2Dir', { path: ivr(p) }, 12000);

async function uploadAudio(p, buf, ms) {
  // הצורה הראשונה היא זו שעבדה בייצור; האחרות גיבוי לשינויים בצד של ימות
  const tries = [{ q: true, field: 'file' }, { q: true, field: 'upload' }, { q: false, field: 'file' }];
  let last = '';
  for (const a of tries) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) url += '?token=' + enc(TOKEN) + '&path=' + enc(ivr(p)) + '&convertAudio=1';
      else { f.append('token', TOKEN); f.append('path', ivr(p)); f.append('convertAudio', '1'); }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), path.basename(p));
      const r = await http(url, { method: 'POST', body: f }, ms || 30000);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = short(j.message || JSON.stringify(j), 160);
    } catch (e) { last = e.message; }
  }
  throw new Error('העלאה לימות נכשלה: ' + last);
}

async function downloadAudio(p) {
  let last = '';
  for (let i = 0; i < 5; i++) {
    try {
      const r = await http(YM + 'DownloadFile?token=' + enc(TOKEN) + '&path=' + enc(ivr(p)), {}, 12000);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + short(b.subarray(0, 100).toString('utf8'), 100);
    } catch (e) { last = e.message; }
    await sleep(400 + i * 300);
  }
  throw new Error('הורדת ההקלטה מימות נכשלה: ' + last);
}

// מחיקה היא "כמה שיוצא": לעולם לא מעכבת שיחה. מוחקים רק קבצים שהשרת יצר.
function del(p) {
  http(YM + 'FileAction?token=' + enc(TOKEN) + '&action=delete&what=' + enc(ivr(p)), {}, 8000).catch(() => {});
}

// קובץ טקסט: מחזיר null אם הקובץ לא קיים
async function readText(p) {
  try {
    const j = await ymGet('GetTextFile', { what: ivr(p) }, 12000);
    return typeof j.contents === 'string' ? j.contents : '';
  } catch (e) {
    // אולי הקובץ פשוט לא קיים: בודקים ברשימת התיקייה, ורק אז מחזירים null
    const dir = path.posix.dirname('/' + clean(p));
    const name = path.posix.basename(p);
    const d = await listDir(dir); // אם גם זה נכשל - זורק, וזה נכון
    // ימות מחזירה כמה רשימות (קבצי שמע, ini, טקסט...). בודקים בכולן.
    const all = Object.values(d).filter(Array.isArray).flat();
    if (!all.some(f => f && (f.name === name || f.fileName === name || f === name))) return null;
    throw e;
  }
}
const writeText = (p, contents) => ymPostForm('UploadTextFile', { what: ivr(p), contents }, 20000);

// ======================================================================
// קובץ שקט (שנייה), להמתנות. נוצר ומועלה פעם אחת.
// ======================================================================
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const SIL = 'kavsil';
let silP = null;
function ensureSilence() {
  if (!TOKEN) return Promise.resolve(false);
  if (!silP) {
    silP = uploadAudio(WORK + '/' + SIL + '.wav', wav(Buffer.alloc(8000 * 2), 8000), 15000)
      .then(() => true)
      .catch(e => { log('קובץ שקט: נכשל -', e.message); silP = null; return false; });
  }
  return silP;
}

// ======================================================================
// הספרייה: קבצים ממוספרים בשלוחת הספרייה + אינדקס בשלוחת העבודה
// ======================================================================
const lib = {
  loaded: false,
  items: {},           // videoId -> { n: '007', t: 'שם', d: 1700000000 }
  files: new Set(),    // שמות הקבצים בשלוחה (בלי סיומת), מתוך ימות
  filesAt: 0,
  reserved: new Set(), // מספרים שהוקצו להורדות שעוד רצות
  saving: Promise.resolve()
};
const num3 = n => String(n).padStart(3, '0');

async function libFiles(force) {
  if (!force && lib.filesAt && Date.now() - lib.filesAt < 60000) return lib.files;
  const j = await listDir(LIB);
  const s = new Set();
  for (const f of (j.files || [])) if (f && f.name) s.add(String(f.name).replace(/\.[^.]+$/, ''));
  lib.files = s;
  lib.filesAt = Date.now();
  return s;
}

async function libLoad() {
  if (lib.loaded) return;
  const txt = await readText(WORK + '/' + INDEX_FILE);
  let items = {};
  if (txt) {
    try { items = JSON.parse(txt).items || {}; }
    catch (e) { throw new Error('האינדקס פגום, לא דורסים אותו: ' + e.message); }
  }
  lib.items = items;
  lib.loaded = true;
  log('ספרייה: האינדקס נטען,', Object.keys(items).length, 'שירים');
}

// שיר שקיים גם באינדקס וגם כקובץ בשלוחה. אם מישהו מחק את הקובץ - לא בספרייה.
async function libHas(vid) {
  await libLoad();
  const it = lib.items[vid];
  if (!it) return null;
  const files = await libFiles(false);
  if (files.has(it.n)) return it;
  // אולי הרשימה במטמון ישנה (השיר רק עכשיו עלה) - בודקים שוב
  if ((await libFiles(true)).has(it.n)) return it;
  return null;
}

async function libReserve() {
  await libLoad();
  const files = await libFiles(true);
  let max = -1;
  const bump = n => { if (/^\d+$/.test(n)) max = Math.max(max, parseInt(n, 10)); };
  files.forEach(bump);
  Object.values(lib.items).forEach(it => bump(it.n));
  lib.reserved.forEach(bump);
  const n = num3(max + 1);
  lib.reserved.add(n);
  return n;
}

// שמירות האינדקס רצות בתור, אחת אחרי השנייה
function libAdd(vid, n, title) {
  lib.items[vid] = { n, t: short(title, 120), d: Math.floor(Date.now() / 1000) };
  lib.files.add(n);
  lib.reserved.delete(n);
  lib.saving = lib.saving.then(async () => {
    const body = JSON.stringify({ v: 1, items: lib.items });
    for (let i = 0; i < 3; i++) {
      try { await writeText(WORK + '/' + INDEX_FILE, body); return; }
      catch (e) { log('אינדקס: שמירה נכשלה (' + (i + 1) + ')', e.message); await sleep(2000 * (i + 1)); }
    }
  });
  return lib.saving;
}

// הגדרת שלוחת הספרייה כ"השמעת קבצים". נוגעים רק אם אין לה סוג אחר.
async function libSetupExt() {
  if (env.LIB_AUTOSETUP === '0') return 'כבוי (LIB_AUTOSETUP=0)';
  const p = LIB + '/ext.ini';
  const cur = await readText(p);
  const type = ((cur || '').match(/^\s*type\s*=\s*(\S+)/m) || [])[1];
  if (type === 'playfile') return 'כבר מוגדרת כהשמעת קבצים';
  if (type) return 'אזהרה: השלוחה מוגדרת כ-' + type + ' ולכן לא נגעתי בה. לשנות ידנית ל-type=playfile';
  await writeText(p, (cur ? cur.replace(/\s+$/, '') + '\n' : '') + 'type=playfile\n');
  return 'הוגדרה עכשיו כהשמעת קבצים (type=playfile)';
}

// ======================================================================
// עוגיות יוטיוב (COOKIES_B64): חובה מכתובת ענן, אחרת יוטיוב חוסמת כבוט
// ======================================================================
let COOKIE_FILE = '';
let cookieInfo = 'לא הוגדרו';
function setupCookies() {
  const raw = String(env.COOKIES_B64 || '').trim();
  if (!raw) { cookieInfo = 'לא הוגדרו (COOKIES_B64 ריק)'; return; }
  try {
    let text;
    if (raw.includes('\t') || /^#\s*(Netscape\s+)?HTTP Cookie File/i.test(raw)) text = raw;
    else {
      const buf = Buffer.from(raw.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, ''), 'base64');
      const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 1 && buf[1] === 0);
      text = buf.toString(utf16 ? 'utf16le' : 'utf8');
    }
    const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
    const header = /^#\s*(Netscape\s+)?HTTP Cookie File/i.test(body) ? '' : '# Netscape HTTP Cookie File\n';
    COOKIE_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(COOKIE_FILE, header + body + '\n');
    const lines = body.split('\n').filter(l => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')));
    const login = /__Secure-3PSID|__Secure-1PSID|\tSID\t/.test(body);
    cookieInfo = lines.length + ' עוגיות' + (login ? ', כולל התחברות' : ', בלי עוגיית התחברות!');
  } catch (e) {
    COOKIE_FILE = '';
    cookieInfo = 'פענוח נכשל: ' + e.message;
  }
}

// ======================================================================
// ג'מיני: תמלול שם השיר
// ======================================================================
const STT_PROMPT = 'זו הקלטה טלפונית של אדם שמבקש שיר. כתוב רק את שם השיר ואת שם הזמר אם נאמר, ' +
  'בדיוק כפי שנאמרו, בלי מילים כמו "תשמיע לי" או "אני רוצה", בלי הסבר ובלי מרכאות. ' +
  'אם לא נשמע דיבור ברור, כתוב רק: ריק';

const verOf = n => { const m = String(n).match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
let modelsP = null;
const deadModels = new Set();   // 404 - לא קיים
const noThink = new Set();      // דוחה הגדרת thinking
function sttModels() {
  if (modelsP) return modelsP;
  modelsP = (async () => {
    const out = [...STT_PREF];
    try {
      const r = await http(GBASE.replace(/\/$/, '') + '?pageSize=300', { headers: { 'x-goog-api-key': KEYS[0] } }, 12000);
      if (r.ok) {
        const j = await r.json();
        const have = new Set();
        const found = (j.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => String(m.name || '').replace(/^models\//, ''))
          .filter(n => { have.add(n); return /flash/i.test(n) && !/(tts|image|live|embed|native|thinking|robotics|computer)/i.test(n); })
          .sort((a, b) => (/lite/.test(b) - /lite/.test(a)) || (verOf(b) - verOf(a)) || (a.length - b.length));
        // מודל מועדף שלא קיים אצל גוגל - מסירים מראש
        for (let i = out.length - 1; i >= 0; i--) if (!have.has(out[i])) out.splice(i, 1);
        for (const n of found) if (!out.includes(n)) out.push(n);
      } else {
        log('רשימת מודלים: ' + r.status + ' ' + short(await r.text(), 120));
      }
    } catch (e) { log('רשימת מודלים נכשלה:', e.message); }
    if (!out.length) out.push(...STT_PREF);
    const top = out.slice(0, 5);
    log('מודלים לתמלול:', top.join(' > '));
    return top;
  })();
  return modelsP;
}

let keyRot = 0;
async function geminiOnce(model, key, audioB64) {
  const gen = { temperature: 0, maxOutputTokens: 80 };
  if (!noThink.has(model)) gen.thinkingConfig = { thinkingBudget: 0 };
  const r = await http(GBASE + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: STT_PROMPT }, { inlineData: { mimeType: 'audio/wav', data: audioB64 } }] }],
      generationConfig: gen
    })
  }, STT_REQ_MS);
  if (!r.ok) {
    const body = short(await r.text(), 300);
    if (r.status === 400 && /thinking/i.test(body) && !noThink.has(model)) {
      noThink.add(model);
      return geminiOnce(model, key, audioB64);
    }
    const e = new Error(model + ' ' + r.status + ' ' + body.slice(0, 120));
    e.status = r.status;
    throw e;
  }
  const j = await r.json();
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

// תמלול "מגודר": שולחים למודל הראשון, ואם הוא לא ענה תוך כמה שניות - שולחים
// במקביל גם לבא אחריו. הראשון שעונה מנצח. כך מודל עמוס לא מעכב את השיחה.
async function transcribe(buf) {
  if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק');
  const models = (await sttModels()).filter(m => !deadModels.has(m));
  const b64 = buf.toString('base64');
  const plan = [];
  for (let round = 0; round < 2; round++) for (const m of models) plan.push(m);

  return new Promise((resolve, reject) => {
    let idx = 0, pending = 0, done = false, lastErr = new Error('אין מודל זמין');
    const t0 = Date.now();
    const finish = (fn, v) => { if (!done) { done = true; clearInterval(hedge); clearTimeout(cap); fn(v); } };
    const launch = () => {
      if (done) return;
      while (idx < plan.length && deadModels.has(plan[idx])) idx++;
      if (idx >= plan.length) { if (!pending) finish(reject, lastErr); return; }
      const model = plan[idx++];
      const key = KEYS[keyRot++ % KEYS.length];
      pending++;
      geminiOnce(model, key, b64)
        .then(text => {
          log('תמלול:', model, (Date.now() - t0) + 'ms');
          finish(resolve, text);
        })
        .catch(e => {
          lastErr = e;
          if (e.status === 404) deadModels.add(model);
          log('תמלול נכשל:', e.name === 'TimeoutError' ? model + ' timeout' : e.message);
        })
        .finally(() => { pending--; if (!done) setTimeout(launch, 300); });
    };
    const hedge = setInterval(() => { if (pending < 3) launch(); }, STT_HEDGE_MS);
    const cap = setTimeout(() => finish(reject, new Error('תמלול: אזל הזמן. אחרון: ' + lastErr.message)), STT_MS);
    launch();
  });
}

function cleanSaid(t) {
  const s = String(t || '').replace(/["'`״׳«»]/g, '').replace(/\s+/g, ' ').trim();
  if (!s || /^ריק\.?$/.test(s) || s.length < 2) return '';
  return s.slice(0, 100);
}

// ======================================================================
// חיפוש ביוטיוב (InnerTube - בלי מפתח ובלי מכסה)
// ======================================================================
const YT_BASE = env.YT_BASE || 'https://www.youtube.com';
const INNERTUBE_KEY = env.INNERTUBE_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const runs = n => !n ? '' : n.simpleText ? n.simpleText : Array.isArray(n.runs) ? n.runs.map(r => r.text).join('') : '';
const secsOf = s => String(s || '').split(':').reduce((a, x) => a * 60 + (parseInt(x, 10) || 0), 0);
function collectVideos(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectVideos(x, out, seen); return; }
  const v = node.videoRenderer;
  if (v && v.videoId && !seen.has(v.videoId)) {
    seen.add(v.videoId);
    out.push({ id: v.videoId, title: runs(v.title), channel: runs(v.ownerText) || runs(v.longBylineText), secs: secsOf(v.lengthText && v.lengthText.simpleText) });
  }
  for (const k in node) collectVideos(node[k], out, seen);
}
async function ytSearch(q) {
  const r = await http(YT_BASE + '/youtubei/v1/search?key=' + INNERTUBE_KEY + '&prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'he', gl: 'IL' } }, query: q })
  }, 15000);
  if (r.status === 418 || (r.headers.get('content-type') || '').includes('text/html')) throw new Error('יוטיוב חסום מהשרת (' + r.status + ')');
  if (!r.ok) throw new Error('חיפוש יוטיוב ' + r.status);
  const items = [];
  collectVideos(await r.json(), items, new Set());
  // בלי שידורים חיים (אין אורך), בלי קטעים קצרצרים ובלי סרטונים ארוכים מדי
  return items.filter(x => x.secs >= 20 && x.secs <= MAX_SEC).slice(0, 6);
}

// ======================================================================
// הורדה: yt-dlp -> ffmpeg -> ימות
// ======================================================================
function ytdlpArgs(url, withCookies, outTpl) {
  return [
    '--no-playlist', '--newline', '--no-colors', '--no-mtime',
    ...(POT ? ['--extractor-args', 'youtubepot-bgutilhttp:base_url=' + POT] : []),
    ...(withCookies ? ['--extractor-args', 'youtube:player_client=' + YT_CLIENTS, '--cookies', COOKIE_FILE] : []),
    ...(env.YT_JS_RUNTIMES ? ['--js-runtimes', env.YT_JS_RUNTIMES] : []),
    '--remote-components', env.YT_EJS || 'ejs:github',
    '--extractor-retries', '2', '--retries', '3', '--fragment-retries', '3',
    '--socket-timeout', '20', '--max-filesize', '80M',
    '-f', YT_FORMAT,
    '-o', outTpl, url
  ];
}

// סיווג שגיאה של yt-dlp להודעה שהמתקשר מבין, ולהחלטה אם לנסות דרך אחרת
function classify(err) {
  if (/not a bot|Sign in to confirm|cookies are no longer valid|LOGIN_REQUIRED/i.test(err)) return 'bot';
  if (/Video unavailable|Private video|removed|copyright|not available in your country|members-only/i.test(err)) return 'unavailable';
  if (/age|inappropriate/i.test(err)) return 'age';
  return 'other';
}

function run(cmd, args, ms, onLine) {
  return new Promise(resolve => {
    let out = '', err = '', killed = false;
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out, err: e.message }); }
    const timer = setTimeout(() => { killed = true; try { p.kill('SIGKILL'); } catch (e) {} }, ms);
    const feed = (d, isErr) => {
      const s = d.toString();
      if (isErr) err = (err + s).slice(-6000); else out = (out + s).slice(-6000);
      if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l);
    };
    p.stdout.on('data', d => feed(d, false));
    p.stderr.on('data', d => feed(d, true));
    p.on('error', e => { err += ' ' + e.message; });
    p.on('close', code => { clearTimeout(timer); resolve({ code: killed ? -9 : code, out, err }); });
  });
}

// פונקציות שהבדיקות המקומיות מחליפות (אין יוטיוב/ffmpeg מאחורי נטפרי)
const media = {
  async download(vid, dir, onPct) {
    const url = 'https://www.youtube.com/watch?v=' + vid;
    const ways = COOKIE_FILE ? [true, false] : [false];
    let last = '';
    for (const withCookies of ways) {
      const t0 = Date.now();
      const r = await run(YTDLP, ytdlpArgs(url, withCookies, path.join(dir, 'src.%(ext)s')), DL_MS, line => {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) onPct(Math.min(99, Math.round(parseFloat(m[1]))));
      });
      const file = fs.readdirSync(dir).find(f => f.startsWith('src.') && !f.endsWith('.part'));
      if (r.code === 0 && file) {
        log('yt-dlp:', vid, withCookies ? 'עם עוגיות' : 'בלי עוגיות', (Date.now() - t0) + 'ms');
        return path.join(dir, file);
      }
      last = short((r.err || r.out).split('\n').filter(l => /ERROR|WARNING: \[youtube\].*(PO Token|cookies)/.test(l)).join(' | ') || r.err || r.out, 500);
      log('yt-dlp נכשל (' + (withCookies ? 'עם עוגיות' : 'בלי עוגיות') + ', קוד ' + r.code + '):', last);
      if (classify(last) === 'unavailable') break;
    }
    const e = new Error(last || 'yt-dlp נכשל');
    e.kind = classify(last);
    throw e;
  },
  async convert(src, out) {
    const r = await run(FFMPEG, ['-y', '-v', 'error', '-i', src, '-vn', '-t', String(MAX_SEC),
      ...(AUDIO_FILTER ? ['-af', AUDIO_FILTER] : []),
      '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', out], DL_MS);
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (r.code !== 0 || size < 16000) throw new Error('המרה נכשלה (קוד ' + r.code + ') ' + short(r.err, 300));
    return size;
  }
};

// ======================================================================
// תור הורדות: אחת בכל פעם (המעבד של Render חלש), בלי כפילויות
// ======================================================================
const jobs = new Map();   // videoId -> job
const queue = [];
let busy = false;
let lastBot = 0;          // מתי יוטיוב חסם אותנו לאחרונה

function getJob(track) {
  let j = jobs.get(track.id);
  if (j && j.state !== 'fail') return j;
  j = { vid: track.id, title: track.title, state: 'queued', pct: 0, err: '', kind: '', n: '', t0: Date.now() };
  j.promise = new Promise(res => { j.resolve = res; });
  jobs.set(track.id, j);
  queue.push(j);
  pump();
  return j;
}

async function pump() {
  if (busy) return;
  const j = queue.shift();
  if (!j) return;
  busy = true;
  try { await doJob(j); }
  catch (e) {
    j.state = 'fail';
    j.err = e.message;
    j.kind = e.kind || 'other';
    if (j.kind === 'bot') lastBot = Date.now();
    log('הורדה נכשלה:', j.vid, j.err.slice(0, 300));
  } finally {
    j.resolve(j);
    busy = false;
    // מנקים עבודות ישנות מהזיכרון
    for (const [k, v] of jobs) if (v.state !== 'queued' && v.state !== 'run' && Date.now() - v.t0 > 3600000) jobs.delete(k);
    setImmediate(pump);
  }
}

async function doJob(j) {
  const have = await libHas(j.vid);
  if (have) { j.state = 'done'; j.n = have.n; return; }
  j.state = 'run';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kav-'));
  const t0 = Date.now();
  let n = '';
  try {
    const src = await media.download(j.vid, dir, p => { j.pct = p; });
    j.pct = 100;
    j.state = 'convert';
    const out = path.join(dir, 'song.wav');
    const size = await media.convert(src, out);
    try { fs.unlinkSync(src); } catch (e) {}
    j.state = 'upload';
    n = await libReserve();
    await uploadAudio(LIB + '/' + n + '.wav', fs.readFileSync(out), 240000);
    await libAdd(j.vid, n, j.title);
    j.n = n;
    j.state = 'done';
    log('נשמר בספרייה:', n, '|', j.title, '|', Math.round(size / 1024) + 'KB', (Date.now() - t0) + 'ms');
  } finally {
    if (n && j.state !== 'done') lib.reserved.delete(n);
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

// ======================================================================
// השיחה
// ======================================================================
const calls = {};
const idOf = q => String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3 * 3600000) { cleanupCall(calls[id]); delete calls[id]; }
}, 600000).unref();

function cleanupCall(s) { if (s && s.rec) { del(WORK + '/' + s.rec + '.wav'); s.rec = null; } }

// כל סבב מקבל שם פרמטר חדש - ימות צוברת פרמטרים לאורך השיחה
const nextP = (s, pre) => { s.n++; s.p = pre + s.e + s.n; return s.p; };
// כל משפט הופך להודעת הקראה נפרדת, כך שיש הפסקה טבעית בין המשפטים
const T = s => String(s || '').split(/\.\s*/).map(say).filter(Boolean).map(x => 't-' + x).join('.') || 't-' + say(s);
const SILF = () => 'f-/' + WORK + '/' + SIL;

const M = {
  greet: env.GREETING || 'ברוכים הבאים לקו השירים. אמרו את שם השיר ושם הזמר, ובסיום הקישו סולמית',
  ask: 'אמרו את שם השיר ובסיום הקישו סולמית',
  again: 'לא שמעתי. אמרו שוב את שם השיר ובסיום הקישו סולמית',
  search: 'מחפש',
  notFound: 'לא מצאתי שיר מתאים. אמרו שם אחר ובסיום הקישו סולמית',
  err: 'הייתה תקלה. אמרו שוב את שם השיר ובסיום הקישו סולמית',
  voice: 'אמרו שוב את שם השיר',
  menu: 'להשמעה עכשיו הקישו 1. לשמירה בספרייה הקישו 2. לתוצאה הבאה הקישו 3. לחיפוש אחר הקישו 4',
  dl: 'מוריד את השיר. זה לוקח בערך דקה. כדי לא לחכות הקישו 9, והשיר יישמר בספרייה',
  after: 'לשמיעה חוזרת הקישו 1. לשיר אחר הקישו 2. לספריית השירים הקישו 6'
};

function askRec(s, msg) {
  s.stage = 'rec';
  nextP(s, 'R');
  s.rec = 'r' + s.e + s.n;
  return 'read=' + T(msg) + '=' + s.p + ',no,record,/' + WORK + ',' + s.rec + ',no,,,1,' + REC_MAX;
}
// הקשה של ספרה אחת. Ok,None = מותר גם בלי הקשה, וימות חוזרת אלינו בכל מקרה
function askKey(s, stage, msgs, wait) {
  s.stage = stage;
  nextP(s, 'K');
  return 'read=' + msgs.join('.') + '=' + s.p + ',no,1,1,' + (wait || 7) + ',No,no,no,,,,Ok,None';
}
// סבב המתנה: הודעה (אם יש) ושנייה של שקט, ואז חוזרים לשרת
async function hold(s, stage, msg) {
  const parts = [];
  if (msg) parts.push(T(msg));
  parts.push((await ensureSilence()) ? SILF() : T('רגע'));
  return askKey(s, stage, parts, 1);
}
function askVoice(s) {
  s.stage = 'voice';
  nextP(s, 'V');
  return 'read=' + T(M.voice) + '=' + s.p + ',no,voice,he-IL';
}
const keyOf = v => { const x = String(v == null ? '' : v).trim(); return x === 'None' ? '' : x; };

// תמלול (אם צריך) + חיפוש, ברקע
async function findSong(s, text) {
  let said = text;
  if (!said) {
    const buf = await downloadAudio(WORK + '/' + s.rec + '.wav');
    del(WORK + '/' + s.rec + '.wav');
    s.rec = null;
    try { said = cleanSaid(await transcribe(buf)); }
    catch (e) { log('תמלול נכשל סופית:', e.message); return { sttFail: true }; }
  }
  said = cleanSaid(said);
  if (!said) return { empty: true };
  log('בקשה:', said);
  const items = await ytSearch(said);
  if (!items.length) return { none: true, said };
  return { items, said };
}

async function menuFor(s) {
  const t = s.items[s.i];
  let inLib = null;
  try { inLib = await libHas(t.id); } catch (e) { log('בדיקת ספרייה:', e.message); }
  s.miss = s.miss || 0;
  const intro = (s.i === 0 ? 'מצאתי ' : 'תוצאה ' + (s.i + 1) + ' ') + t.title + (inLib ? '. השיר כבר בספרייה' : '');
  return askKey(s, 'menu', [T(intro), T(M.menu)], 7);
}

function playNow(s, j) {
  s.playing = j;
  return askKey(s, 'play', [T('מנגן ' + j.title), 'f-/' + LIB + '/' + j.n], 1);
}

function failMsg(j) {
  if (j.kind === 'bot') return 'יוטיוב חסם את ההורדה. צריך לחדש את החיבור ליוטיוב בשרת';
  if (j.kind === 'unavailable') return 'הסרטון הזה לא זמין להורדה';
  if (j.kind === 'age') return 'הסרטון מוגבל לגיל ולא ניתן להוריד אותו';
  return 'ההורדה נכשלה';
}

async function step(s, q) {
  const raw = q[s.p];
  const key = keyOf(raw);

  switch (s.stage) {
    case 'rec': {
      if (raw === undefined) return askRec(s, M.again);
      s.job = findSong(s, '').catch(e => { log('חיפוש נכשל:', e.message); return { error: true }; });
      s.t0 = Date.now();
      return hold(s, 'find', M.search);
    }
    case 'voice': {
      const text = String(raw == null ? '' : raw).trim();
      if (!text || text === 'None') return askRec(s, M.again);
      s.voiced = true;
      s.job = findSong(s, text).catch(e => { log('חיפוש נכשל:', e.message); return { error: true }; });
      s.t0 = Date.now();
      return hold(s, 'find', M.search);
    }
    case 'find': {
      const r = await Promise.race([s.job, sleep(6000).then(() => null)]);
      if (!r) {
        if (Date.now() - s.t0 > 60000) { s.job = null; return askRec(s, M.err); }
        return hold(s, 'find');
      }
      s.job = null;
      if (r.sttFail) {
        if (YEMOT_STT && !s.voiced) return askVoice(s);
        return askRec(s, M.err);
      }
      s.voiced = false;
      if (r.error) return askRec(s, M.err);
      if (r.empty) return askRec(s, M.again);
      if (r.none) return askRec(s, 'לא מצאתי את ' + r.said + '. אמרו שם אחר ובסיום הקישו סולמית');
      s.items = r.items;
      s.i = 0;
      s.miss = 0;
      return menuFor(s);
    }
    case 'menu': {
      const t = s.items[s.i];
      if (!key) {
        s.miss++;
        if (s.miss < 2) return menuFor(s);
      }
      if (key === '3') { s.i = (s.i + 1) % s.items.length; s.miss = 0; return menuFor(s); }
      if (key === '4') return askRec(s, M.ask);
      if (key === '2') {
        const j = getJob(t);
        const msg = j.state === 'done' ? 'השיר כבר נמצא בספרייה' : 'השיר יורד ויישמר בספרייה בשלוחה ' + LIB + ' בעוד כדקה';
        return askRec(s, msg + '. לשיר נוסף אמרו את שמו ובסיום הקישו סולמית');
      }
      if (key === '1' || !key) {
        const j = getJob(t);
        if (j.state === 'done') return playNow(s, j);
        s.wait = j;
        s.t0 = Date.now();
        s.holds = 0;
        return hold(s, 'dl', queue.includes(j) && busy ? 'יש שיר אחר בהורדה. השיר שלך בתור' : M.dl);
      }
      return menuFor(s);
    }
    case 'dl': {
      const j = s.wait;
      if (key === '9') { s.wait = null; return askRec(s, 'השיר ימשיך לרדת ויישמר בספרייה. ' + M.ask); }
      const r = await Promise.race([j.promise, sleep(6000).then(() => null)]);
      if (!r) {
        if (Date.now() - s.t0 > WAIT_MS) {
          s.wait = null;
          return askRec(s, 'ההורדה לוקחת יותר מדי זמן. השיר יישמר בספרייה כשיסתיים. ' + M.ask);
        }
        s.holds++;
        // מדי פעם עדכון קצר, כדי שהמתקשר יידע שהקו חי
        if (s.holds % 4 === 0) {
          const msg = j.state === 'run' && j.pct > 0 ? 'הורדו ' + j.pct + ' אחוז'
            : j.state === 'convert' || j.state === 'upload' ? 'כמעט מוכן'
            : j.state === 'queued' ? 'ממתין בתור' : 'עוד רגע';
          return hold(s, 'dl', msg);
        }
        return hold(s, 'dl');
      }
      s.wait = null;
      if (r.state === 'done') return playNow(s, r);
      return askRec(s, failMsg(r) + '. אמרו שם של שיר אחר ובסיום הקישו סולמית');
    }
    case 'play':
      return askKey(s, 'after', [T(M.after)], 6);
    case 'after': {
      if (key === '1' && s.playing) return playNow(s, s.playing);
      if (key === '6') return 'go_to_folder=/' + LIB;
      return askRec(s, M.ask);
    }
    default:
      return askRec(s, M.greet);
  }
}

// ======================================================================
// כתובות
// ======================================================================
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get(['/', '/ping'], (q, r) => r.type('text/plain').send('ok'));

app.all('/yemot', async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = idOf(q);
  res.type('text/plain');
  const t0 = Date.now();
  let out = '';
  try {
    if (q.hangup === 'yes') {
      if (calls[id]) { cleanupCall(calls[id]); delete calls[id]; }
      out = 'noop=bye';
    } else {
      let s = calls[id];
      if (!s) {
        s = calls[id] = { e: crypto.randomBytes(3).toString('hex'), n: 0, t: Date.now(), stage: '' };
        ensureSilence();
        log('שיחה חדשה', id.slice(-8), q.ApiPhone ? 'מ-' + String(q.ApiPhone).slice(-4) : '');
        out = askRec(s, M.greet);
      } else {
        s.t = Date.now();
        out = await step(s, q);
      }
    }
  } catch (e) {
    log('שגיאה בשיחה', id.slice(-8), e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e);
    out = 'id_list_message=' + T('הייתה תקלה בקו. נסו שוב');
  }
  if (env.LOG_IVR === '1') log('ימות', id.slice(-6), (Date.now() - t0) + 'ms', short(out, 160));
  res.send(out);
});

// ----- בדיקות -----
const status = { at: null, checks: {} };
async function check(name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); status.checks[name] = { ok: true, ms: Date.now() - t0, info }; }
  catch (e) { status.checks[name] = { ok: false, ms: Date.now() - t0, error: short(e.message, 300) }; }
  const c = status.checks[name];
  log('[בדיקה] ' + name + ': ' + (c.ok ? 'תקין - ' + c.info : 'נכשל - ' + c.error));
}

// בדיקת יוטיוב אמיתית: מחלץ סרטון קצר וידוע בלי להוריד אותו
async function probeYoutube() {
  const vid = env.PROBE_VIDEO || 'jNQXAC9IVRw';
  const tries = COOKIE_FILE ? [true, false] : [false];
  const res = [];
  for (const wc of tries) {
    const t0 = Date.now();
    const r = await run(YTDLP, ['--simulate', '--print', 'format_id',
      ...ytdlpArgs('https://www.youtube.com/watch?v=' + vid, wc, path.join(os.tmpdir(), 'probe.%(ext)s'))], 150000);
    const ok = r.code === 0 && /\S/.test(r.out);
    const e = short((r.err.split('\n').find(l => /ERROR/.test(l)) || r.err), 200);
    res.push((wc ? 'עם עוגיות' : 'בלי עוגיות') + ': ' + (ok ? 'עובד (' + (Date.now() - t0) + 'ms)' : 'נכשל - ' + (classify(e) === 'bot' ? 'חסימת בוט' : e)));
    if (ok) return res.join(' | ');
  }
  throw new Error(res.join(' | '));
}

async function runChecks(full) {
  status.at = new Date().toISOString();
  await check('ימות', async () => {
    if (!TOKEN) throw new Error('YEMOT_TOKEN ריק');
    await listDir(WORK);
    return 'מחובר, שלוחת עבודה /' + WORK;
  });
  await check('ספרייה', async () => {
    if (!TOKEN) throw new Error('YEMOT_TOKEN ריק');
    if (LIB === WORK) throw new Error('LIB_PATH חייבת להיות שונה מ-EXT_PATH');
    const setup = await libSetupExt();
    await libLoad();
    const files = await libFiles(true);
    return 'שלוחה /' + LIB + ', ' + files.size + ' קבצים, ' + Object.keys(lib.items).length + ' באינדקס. ' + setup;
  });
  await check('ג׳מיני', async () => {
    if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק');
    const m = await sttModels();
    return KEYS.length + ' מפתחות. מודלים: ' + m.join(', ');
  });
  await check('חיפוש יוטיוב', async () => {
    const r = await ytSearch('אדון עולם');
    if (!r.length) throw new Error('אין תוצאות');
    return r.length + ' תוצאות, הראשונה: ' + r[0].title;
  });
  await check('עוגיות', async () => {
    if (!COOKIE_FILE) throw new Error(cookieInfo);
    return cookieInfo;
  });
  await check('PO Token', async () => {
    if (!POT) return 'כבוי';
    const r = await http(POT + '/ping', {}, 8000).catch(() => null);
    if (!r) throw new Error('לא מאזין ב-' + POT);
    return 'מאזין';
  });
  if (full) await check('הורדה מיוטיוב', probeYoutube);
  const mb = n => Math.round(n / 1048576);
  status.checks['משאבים'] = { ok: true, info: 'תהליך ' + mb(process.memoryUsage().rss) + 'MB, פנוי ' + mb(os.freemem()) + '/' + mb(os.totalmem()) + 'MB' };
  log('[בדיקה] משאבים:', status.checks['משאבים'].info);
  status.ok = Object.values(status.checks).every(c => c.ok);
  log('[בדיקה] סיכום:', status.ok ? 'הכול תקין' : 'יש תקלות');
}

app.get(['/status', '/selftest'], async (req, res) => {
  if (req.query.run === '1' || !status.at) await runChecks(req.query.full === '1');
  res.json({
    ...status,
    jobs: [...jobs.values()].map(j => ({ vid: j.vid, title: j.title, state: j.state, pct: j.pct, n: j.n, err: j.err ? j.err.slice(0, 200) : undefined })),
    queue: queue.length,
    calls: Object.keys(calls).length,
    lastBot: lastBot ? new Date(lastBot).toISOString() : null
  });
});

// הורדת שיר לספרייה בלי שיחה: /add?q=שם השיר
app.get('/add', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'חסר ?q=' });
  try {
    const items = await ytSearch(q);
    if (!items.length) return res.json({ found: 0 });
    const j = getJob(items[0]);
    if (req.query.wait === '1') await j.promise;
    res.json({ title: items[0].title, vid: j.vid, state: j.state, n: j.n, err: j.err || undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// שירים שמורדים לספרייה בעלייה אם הם עוד לא שם (SEED_SONGS, מופרדים בפסיק).
// משמש גם כבדיקה אמיתית של כל המסלול - הורדה, המרה והעלאה - בלי שיחה.
async function seed() {
  for (const q of list(env.SEED_SONGS)) {
    try {
      const items = await ytSearch(q);
      if (!items.length) { log('[זריעה]', q, '- לא נמצא'); continue; }
      const j = getJob(items[0]);
      await j.promise;
      log('[זריעה]', q, '->', j.state === 'done' ? 'בספרייה כ-' + j.n : 'נכשל: ' + j.err.slice(0, 200));
    } catch (e) { log('[זריעה]', q, 'נכשל:', e.message); }
  }
}

// ======================================================================
// הפעלה
// ======================================================================
function start() {
  setupCookies();
  app.listen(PORT, () => {
    log('קו שירים מאזין על פורט ' + PORT + ' | עבודה /' + WORK + ' | ספרייה /' + LIB);
    log('עוגיות:', cookieInfo, '| PO Token:', POT || 'כבוי');
    ensureSilence();
    // בדיקה מלאה בעלייה (מופיעה בלוג של Render), ובדיקת יוטיוב כל 6 שעות
    setTimeout(() => runChecks(true).then(seed).catch(e => log('בדיקות:', e.message)), 15000);
    setInterval(() => runChecks(true).catch(() => {}), 6 * 3600000).unref();
    // שמירה על השירות ער: Render מרדים אחרי 15 דקות בלי בקשות מבחוץ.
    // פנייה לכתובת הציבורית של עצמנו עוברת דרך Render ונחשבת תנועה נכנסת.
    const self = env.RENDER_EXTERNAL_URL || env.SELF_URL;
    if (self && env.KEEPALIVE !== '0') {
      setInterval(() => { http(self.replace(/\/$/, '') + '/ping', {}, 20000).catch(() => {}); }, 9 * 60000).unref();
      log('שמירה על ערוּת: כל 9 דקות אל', self);
    }
  });
}

if (require.main === module) start();
module.exports = { app, media, lib, jobs, setupCookies, runChecks, start };
