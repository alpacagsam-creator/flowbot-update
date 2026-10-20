// FlowBot 2.0 — เซิร์ฟเวอร์ควบคุมในเครื่อง (127.0.0.1) ไม่ต่อออกเน็ต ไม่ใช้ API
// หน้าที่: จัดลำดับขั้นตอน (ถาม AI → ตรวจ prompt → วาดรูป → ตรวจรูป → วิดีโอ → ซ่อมเมื่อ Flow ปฏิเสธ) แล้วสั่ง run.js ทำงานกับ Chrome
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, exec } = require('child_process');
const lib = require('./lib');

const APP = __dirname;
const DATA = process.env.FLOWBOT_DATA || path.join(APP, '..', 'data');
const IMG = path.join(DATA, 'images');
fs.mkdirSync(IMG, { recursive: true });
const PORT = Number(process.env.FLOWBOT_PORT || 3737);
const WORKER = process.env.FLOWBOT_WORKER || path.join(APP, 'run.js');
const F = n => path.join(DATA, n);
const upd = require('./updater').init({ appDir: APP, dataDir: DATA });
const VERSION = '4.1';

// ---------- ตรวจระบบตอนเปิด (แสดงเป็นภาษาไทยบนหน้าแรกถ้ามีอะไรขาด) ----------
function findChrome() {
  const e = process.env;
  return [e['ProgramFiles'] && path.join(e['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    e['ProgramFiles(x86)'] && path.join(e['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    e['LOCALAPPDATA'] && path.join(e['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe')].filter(Boolean).find(p => fs.existsSync(p)) || null;
}
function sysCheck() {
  const issues = [];
  const chrome = process.platform === 'win32' ? findChrome() : 'n/a';
  if (!chrome) issues.push({ id: 'chrome', text: 'ไม่พบ Google Chrome ในเครื่อง ต้องติดตั้ง Chrome ก่อน (บอทควบคุม Chrome เท่านั้น)', url: 'https://www.google.com/chrome/' });
  let writable = true; try { const t = path.join(DATA, '.w'); fs.writeFileSync(t, '1'); fs.unlinkSync(t); } catch { writable = false; }
  if (!writable) issues.push({ id: 'data', text: 'เขียนไฟล์ลงโฟลเดอร์ข้อมูลของบอทไม่ได้: ' + DATA + ' (ลองติดตั้งใหม่ หรือย้ายไปไว้ในโฟลเดอร์ที่คุณมีสิทธิ์)' });
  if (/[\\/](Program Files|OneDrive)[\\/]/i.test(DATA)) issues.push({ id: 'path', text: 'โฟลเดอร์ข้อมูลอยู่ใน Program Files หรือ OneDrive อาจเขียนไม่ได้หรือถูกซิงค์จนช้า' });
  return { chrome, issues, node: process.version, data: DATA, platform: process.platform };
}
const SYS = sysCheck();


// ---------- รายงานปัญหา ----------
function makeReport(note) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const root = path.join(DATA, 'reports'); fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, 'report-' + stamp); fs.mkdirSync(dir, { recursive: true });
  const os = require('os');
  const st = { ...settings }; delete st.updateUrl;
  const plan = job.plan || {};
  const L = [];
  L.push('FlowBot รายงานปัญหา', '====================');
  L.push('เวลา: ' + new Date().toString());
  L.push('เวอร์ชัน FlowBot: ' + VERSION);
  L.push('ระบบ: ' + os.type() + ' ' + os.release() + ' ' + os.arch() + ' | RAM ว่าง ' + Math.round(os.freemem() / 1048576) + ' MB / ' + Math.round(os.totalmem() / 1048576) + ' MB');
  L.push('Node: ' + process.version + ' | Chrome: ' + (SYS.chrome || 'ไม่พบ'));
  L.push('ปัญหาที่ระบบเช็กเจอ: ' + (SYS.issues.length ? SYS.issues.map(i => i.id).join(', ') : 'ไม่มี'));
  L.push('', '--- ข้อความจากผู้ใช้ ---', note || '(ไม่ได้พิมพ์)');
  L.push('', '--- สถานะงาน ---');
  L.push('ขั้นตอน: ' + job.phase + ' | ข้อความ: ' + (job.msg || '-') + ' | ผิดพลาด: ' + (job.error || '-'));
  L.push('ท่อนที่ ' + partNo + ' | โหมดวิดีโอ: ' + (plan.videoMode || settings.videoMode));
  if (job.stop) L.push('หยุดเพราะ: ' + JSON.stringify(job.stop).slice(0, 600));
  if (plan.videos) plan.videos.forEach((v, i) => L.push(`คลิป ${i + 1}: สถานะ=${v.status || '-'} qc=${v.qc ? JSON.stringify(v.qc).slice(0, 300) : '-'}`));
  if (plan.images) plan.images.forEach((x, i) => L.push(`รูป ${i + 1}: สถานะ=${x.status || '-'} flag=${!!x.flag}`));
  L.push('', '--- ตั้งค่า ---', JSON.stringify(st, null, 1));
  L.push('', '--- บันทึกการทำงานล่าสุด ---', ...logLines.slice(-300));
  fs.writeFileSync(path.join(dir, 'report.txt'), '﻿' + L.join('\r\n'));
  try { fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ ...job, instruction: undefined }, null, 1)); } catch { /* ข้าม */ }
  for (const f of ['credits-debug.json', 'qc-test.json', 'import-debug.json', 'import.txt']) { try { fs.copyFileSync(F(f), path.join(dir, f)); } catch { /* ไม่มี */ } }
  let n = 0;
  try { for (const f of fs.readdirSync(DATA).filter(x => /^fail-.*\.png$/.test(x)).slice(-6)) { fs.copyFileSync(F(f), path.join(dir, f)); n++; } } catch { /* ข้าม */ }
  try { const qd = F('qc'); for (const f of fs.readdirSync(qd).filter(x => /\.png$/.test(x)).slice(-6)) { fs.copyFileSync(path.join(qd, f), path.join(dir, 'qc-' + f)); n++; } } catch { /* ข้าม */ }
  const zip = dir + '.zip';
  const out = { ok: true, folder: dir, zip: null, shots: n };
  if (process.platform === 'win32') {
    try { require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zip}' -Force`], { timeout: 30000 }); out.zip = zip; } catch { /* ใช้โฟลเดอร์แทน */ }
    exec(`explorer /select,"${out.zip || path.join(dir, 'report.txt')}"`);
  }
  return out;
}

// ---------- ตั้งค่า ----------
const DEFAULTS = { ratio: '9:16', videoSeconds: 10, ai: 'claude', review: true, precheck: true, riskAuto: 'ai', onReject: 'ai', auto: false, parts: 4, videoMode: 'auto', qc: 'basic', qcRedo: false, dedupe: false, ackRisk: false, autoUpdate: true, login: {} };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(F('settings.json'), 'utf8')) }; } catch { /* ใช้ค่าเริ่มต้น */ }
const saveSettings = () => fs.writeFileSync(F('settings.json'), JSON.stringify(settings, null, 2));
const AI_NAME = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', other: 'AI อื่น' };
const AI_URL = { claude: 'https://claude.ai/', chatgpt: 'https://chatgpt.com/', gemini: 'https://gemini.google.com/app' };

// ---------- งานปัจจุบัน ----------
let job = freshJob();
function freshJob() { return { phase: 'home', msg: '', topic: '', plan: null, risks: [], stop: null, approved: false, instruction: '', edit: '', error: '', lightened: false, credits: 0, notice: '' }; }
let partNo = 1, child = null, childKind = '', logLines = [], seq = 0, clipLast = null, aborted = false, pendingStop = null;
const addLog = l => { logLines.push(l); if (logLines.length > 400) logLines.shift(); };
const saveJob = () => { try { fs.writeFileSync(F('job.json'), JSON.stringify(job)); } catch { /* ไม่เป็นไร */ } };
const setPhase = (p, extra) => { job.phase = p; if (extra) Object.assign(job, extra); saveJob(); };
try { // เปิดโปรแกรมใหม่ขณะมีงานค้าง → ให้กดทำต่อได้
  const j = JSON.parse(fs.readFileSync(F('job.json'), 'utf8'));
  if (j && ['work', 'review', 'videos', 'fix', 'stopped'].includes(j.phase)) { job = { ...freshJob(), ...j, phase: 'stopped', msg: 'งานเดิมค้างอยู่ กดทำต่อได้เลย' }; }
} catch { /* ไม่มีงานค้าง */ }

const readPrompts = () => { try { return fs.readFileSync(F('prompts.txt'), 'utf8'); } catch { return ''; } };
function writeControl(extra) {
  let c = {}; try { c = JSON.parse(fs.readFileSync(F('control.json'), 'utf8')); } catch { /* ใหม่ */ }
  c = { flagTimes: {}, cmd: { seq }, ...c, ...(extra || {}) };
  fs.writeFileSync(F('control.json'), JSON.stringify(c));
}

// ---------- รัน worker (run.js) ----------
function runWorker(kind, args, env, handlers = {}) {
  if (child) return false;
  childKind = kind; aborted = false;
  child = spawn(process.execPath, [WORKER, ...args], { cwd: APP, env: { ...process.env, FLOWBOT_DATA: DATA, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', sawStop = false;
  const onData = chunk => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    lines.filter(Boolean).forEach(line => {
      const m = line.match(/^@@(\w+) ?(.*)$/);
      if (m) { if (m[1] === 'STOP') sawStop = true; try { handlers.event && handlers.event(m[1], m[2]); } catch (e) { addLog('event error: ' + e.message); } }
      else addLog(line);
    });
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('exit', code => {
    if (buf.trim()) addLog(buf.trim());
    child = null; childKind = '';
    if (handlers.exit) handlers.exit(code, sawStop);
  });
  return true;
}
function killWorker() {
  aborted = true; pendingStop = null;
  if (!child) return;
  const pid = child.pid;
  if (process.platform === 'win32') exec(`taskkill /pid ${pid} /T /F`); else child.kill('SIGKILL');
  addLog('หยุดบอทแล้ว (Chrome ยังเปิดอยู่)');
}
const lastErr = () => { const l = [...logLines].reverse().find(x => /ผิดพลาด|ยังไม่ได้ล็อกอิน|ไม่พบ|ไม่ตอบ|อ่านคำตอบ/.test(x)); return l ? l.replace(/^\S+\s+/, '') : 'ไม่ทราบสาเหตุ ดูรายละเอียดด้านล่าง'; };

// ---------- ขอข้อความจาก AI (เปิดแชตใหม่ ส่ง รอ อ่านคำตอบ) ----------
function askAI(message, expect, done, here) {
  fs.writeFileSync(F('ask.txt'), message, 'utf8');
  try { fs.unlinkSync(F('import.txt')); } catch { /* ไม่มี */ }
  const ok = runWorker('ask', ['ask', settings.ai], { FLOWBOT_EXPECT: String(expect || 0), FLOWBOT_HERE: here ? '1' : '0' }, {
    exit: code => {
      if (aborted) return;
      let text = ''; try { text = fs.readFileSync(F('import.txt'), 'utf8'); } catch { /* ไม่มี */ }
      if (code === 0 && text.trim()) { settings.login[settings.ai] = true; saveSettings(); done(null, text); }
      else done(lastErr());
    },
  });
  if (!ok) done('มีงานอื่นกำลังทำอยู่');
}

// ---------- รูปอ้างอิงของผู้ใช้ (อัปโหลดเอง ใช้แนบในโหมดองค์ประกอบ) เก็บในโฟลเดอร์ images ----------
const REFS = F('refs.json');
const readRefs = () => { try { const r = JSON.parse(fs.readFileSync(REFS, 'utf8')); return Array.isArray(r) ? r.filter(x => fs.existsSync(path.join(IMG, x.file))) : []; } catch { return []; } };
const writeRefs = r => fs.writeFileSync(REFS, JSON.stringify(r));
const refName = n => String(n || '').replace(/\.[^.]*$/, '').replace(/[^\w\-ก-๙ ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
// รูปที่ "ใช้ในเรื่องนี้" (ปิดได้ทีละรูป) — ส่งเฉพาะรูปพวกนี้ให้ AI
const activeRefs = () => readRefs().filter(r => r.on !== false).map(r => ({ name: r.name, kind: r.kind || 'other', note: r.note || '' }));
// ชื่อไฟล์จากมือถือ/กล้อง (IMG_1234, DSC0001, 2026-10-20 …) ไม่มีความหมายให้ AI → ตั้งชื่อตามประเภทแทน
const junkName = n => !n || /^(img|dsc|dscn|pxl|mvimg|photo|image|screenshot|screen ?shot|line_album|line_|capture|unnamed|download|รูป|ภาพ)[\s_\-]*[\d_\-() ]*$/i.test(n) || /^[\d_\-() ]+$/.test(n);
const KIND_WORD = { person: 'คน', product: 'สินค้า', place: 'ฉาก', outfit: 'ชุด', other: 'รูป' };
function uniqueRefName(want, refs, self) {
  let name = want, i = 2;
  while (refs.some(r => r !== self && r.name.toLowerCase() === name.toLowerCase())) name = `${want} ${i++}`;
  return name;
}

// ---------- ตรวจแผน ----------
function validate(plan, requirePipeline) {
  if (plan.error) return plan.error;
  if (!plan.segs.length) return 'ไม่พบ prompt';
  if (requirePipeline && !plan.pipeline) return 'AI ตอบไม่ตรงรูปแบบ (ไม่มีแท็ก [รูป …] / [วิดีโอ …])';
  if (plan.pipeline) {
    const names = new Set(plan.images.map(x => x.name.trim().toLowerCase()));
    if (!plan.images.length) {
      // โหมดองค์ประกอบล้วน: มีแต่ prompt วิดีโอ + [แนบ: ชื่อ] → ใช้ได้ถ้าทุกชื่อตรงกับรูปอ้างอิงที่อัปโหลดไว้
      const isFrames = plan.videos.some(v => v.start || v.end);
      if (!plan.videos.length || isFrames) return 'ไม่พบ prompt รูปคีย์เฟรม ([รูป K0] …)';
      const have = readRefs().map(r => r.name.toLowerCase());
      const match = n => { n = n.trim().toLowerCase(); return have.some(b => b === n || (b.length >= 3 && (n.startsWith(b) || b.startsWith(n)))); };
      const miss = [];
      plan.segs.forEach((s, i) => (s.images || []).forEach(n => { if (!match(n)) miss.push(`ท่อน ${i + 1}: "${n}"`); }));
      if (miss.length) return `โหมดองค์ประกอบ: AI อ้างรูปที่ยังไม่มีให้บอท (${[...new Set(miss)].slice(0, 3).join(', ')}) — กด "รูปอ้างอิงของคุณ" แล้วอัปโหลดรูปนั้นก่อน (ตั้งชื่อไฟล์ให้ตรงกับที่ AI เรียก)`;
    }
    for (const v of plan.videos) for (const k of [v.start, v.end]) if (k && !names.has(k.trim().toLowerCase())) return `วิดีโอท่อน ${v.seg} อ้างถึงรูป "${k}" ที่ไม่มีใน prompt`;
  }
  return null;
}

// ชื่อใน [แนบ: …] ที่บอทหาไม่เจอเลย (ไม่ใช่รูปในแผน ไม่ใช่รูปจริงของผู้ใช้ ไม่มีไฟล์ในเครื่อง) — จับก่อนเริ่ม จะได้ไม่ไปพังกลางทาง
function missingAttach(plan) {
  if (!plan || !plan.pipeline) return [];
  let files = []; try { files = fs.readdirSync(IMG).map(f => f.replace(/\.[^.]*$/, '').toLowerCase()); } catch { /* ไม่มีโฟลเดอร์ */ }
  const pool = [...plan.images.map(x => x.name.toLowerCase()), ...readRefs().map(r => r.name.toLowerCase()), ...files];
  const ok = n => { n = n.trim().toLowerCase(); return pool.some(b => b === n || (b.length >= 3 && n.length >= 2 && (n.startsWith(b) || b.startsWith(n)))); };
  const miss = [];
  plan.segs.forEach((sg, i) => (sg.images || []).forEach(n => { if (!ok(n)) miss.push(n); }));
  return [...new Set(miss)];
}

// ---------- ขั้นตอน ----------
// อ่านไม่ได้: ถ้าใช้ AI อัตโนมัติได้ ให้ AI จัดรูปแบบให้ก่อนหนึ่งรอบ (ไม่แก้เนื้อหา) แล้วค่อยแสดง error ถ้ายังไม่ได้
function failIngest(msg, text, from, quiet, converted) {
  if (quiet) return false;
  if (!converted && settings.ai !== 'other' && !child && String(text).trim().length > 200) {
    setPhase('asking', { msg: `อ่านรูปแบบไม่ออก ให้ ${AI_NAME[settings.ai]} จัดรูปแบบให้บอทอ่านได้…`, error: '' });
    addLog('อ่านไม่ได้ (' + msg + ') → ให้ AI จัดรูปแบบใหม่');
    askAI(lib.buildConvert(text, activeRefs()), 0, (err, out) => {
      if (err) return setPhase('error', { error: `${msg} (ให้ AI จัดรูปแบบให้ก็ไม่สำเร็จ: ${err})`, msg: '' });
      ingest(out, from + ' ที่ AI จัดรูปแบบให้', false, false, true);
    });
    return true;
  }
  setPhase('error', { error: msg, msg: '' });
  return false;
}
function ingest(text, from, requirePipeline, quiet, converted) {
  if (!/```/.test(String(text)) && !/^\s*\[\s*(รูป|วิดีโอ|ภาพ|image|video)/im.test(String(text))) return failIngest(`ไม่พบ prompt ในข้อความที่ได้จาก${from} (ต้องเป็นกล่องโค้ดหรือมีแท็ก [รูป …] / [วิดีโอ …]) ลองให้ AI ตอบอีกครั้ง แล้วกดอ่านใหม่`, text, from, quiet, converted);
  const t = lib.normalizePrompts(text);
  const plan = lib.planOf(t);
  const bad = validate(plan, requirePipeline);
  if (bad) return failIngest(`อ่าน prompt ที่ได้จาก${from}ไม่ได้: ${bad}`, text, from, quiet, converted || (/^โหมดองค์ประกอบ:/.test(bad) && !readRefs().length)); // ขาดรูปอ้างอิงและไม่มีรูปให้เลือกเลย = ให้ AI จัดรูปแบบก็ไม่ช่วย
  const miss = missingAttach(plan);
  if (miss.length) {
    const have = readRefs().map(r => r.name);
    return failIngest(`prompt สั่งแนบรูปที่บอทไม่มี: ${miss.slice(0, 4).map(n => '"' + n + '"').join(', ')}${miss.length > 4 ? ' …' : ''} — ${have.length ? 'รูปของคุณที่มีในบอท: ' + have.slice(0, 8).join(', ') + (have.length > 8 ? ' …' : '') + ' · ' : ''}อัปโหลดรูปที่ขาดในช่อง "รูปของคุณ" (ตั้งชื่อให้ตรง) หรือแก้ชื่อใน [แนบ: …] ให้ตรงกับรูปที่มี`, text, from, quiet, converted);
  }
  fs.writeFileSync(F('prompts.txt'), t, 'utf8');
  addLog(`รับ prompt จาก${from}: รูป ${plan.images.length} ใบ วิดีโอ ${plan.videos.length} คลิป`);
  job.lightened = false;
  afterIngest();
  return true;
}
function afterIngest() {
  const raw = readPrompts(), plan = lib.planOf(raw);
  job.plan = mkPlan(plan);
  job.credits = lib.estimateCredits(plan, settings.videoSeconds);
  job.risks = settings.precheck && !job.lightened ? decorate(lib.riskScan(raw), plan) : [];
  if (job.risks.length) {
    if (!settings.auto || settings.riskAuto === 'ask') return setPhase('pre');
    if (settings.riskAuto === 'ai' && settings.ai !== 'other') return lighten();
    // 'go' = ทำต่อโดยไม่แก้
  }
  startRun(false);
}
// ใส่ชื่อที่คนอ่านเข้าใจ: รูป K3 / ท่อนที่ 2 (แทนเลข segment รวม)
function decorate(risks, plan) {
  return risks.map(r => {
    const im = plan.images.find(x => x.seg === r.seg);
    const vi = plan.videos.findIndex(x => x.seg === r.seg);
    return { ...r, where: im ? 'รูป ' + (/character|sheet/i.test(im.name) ? 'ตัวละคร' : im.name) : vi >= 0 ? 'ท่อนที่ ' + (vi + 1) : 'ท่อนที่ ' + r.seg };
  });
}
function mkPlan(plan) {
  return {
    legacy: !plan.pipeline,
    images: plan.images.map(x => ({ seg: x.seg, name: x.name, status: 'wait', file: '', flag: false })),
    videos: plan.videos.map(x => ({ seg: x.seg, status: 'wait' })),
  };
}
function lighten() {
  const raw = readPrompts(), before = lib.planOf(raw);
  setPhase('asking', { msg: `${AI_NAME[settings.ai]} กำลังปรับ prompt ให้เบาลง…` });
  askAI(lib.buildLighten(raw), before.segs.length, (err, text) => {
    if (!err) {
      const t = lib.normalizePrompts(text), p = lib.planOf(t);
      if (!validate(p, true) && p.images.length === before.images.length && p.videos.length === before.videos.length) {
        fs.writeFileSync(F('prompts.txt'), t, 'utf8'); job.lightened = true; job.notice = '🛡 ตรวจ prompt แล้ว ให้ AI ปรับให้เบาลงเรียบร้อย';
        addLog('ปรับ prompt ให้เบาลงเรียบร้อย'); return afterIngest();
      }
      err = 'AI ตอบกลับมาไม่ครบหรือรูปแบบเปลี่ยน จึงใช้ prompt เดิม';
    }
    addLog('ปรับด้วย AI ไม่สำเร็จ: ' + err);
    job.lightened = true; job.risks = decorate(lib.riskScan(readPrompts()), lib.planOf(readPrompts()));
    setPhase('pre', { notice: 'ให้ AI ปรับไม่สำเร็จ (' + err + ') เลือกวิธีอื่นได้เลย' });
  });
}
function startRun(resume) {
  const review = settings.review && !settings.auto && !job.approved;
  seq += 1; fs.writeFileSync(F('control.json'), JSON.stringify({ flagTimes: {}, cmd: { seq } }));
  if (job.plan) job.plan.images.forEach(x => { x.flag = false; });
  if (!resume) { job.approved = false; job.plan = mkPlan(lib.planOf(readPrompts())); }
  job.stop = resume ? job.stop : null;
  logLines = resume ? logLines : [];
  const legacy = job.plan.legacy;
  if (!resume && conn.credits == null && conn.creditLow) job.notice = `⚠ Flow แจ้งว่าเครดิตเหลือน้อย แต่งานนี้ใช้ประมาณ ${job.credits} เครดิต — ถ้าไม่พอ บอทจะหยุดให้ เติมเครดิตแล้วกด "ทำต่อ" ได้`;
  if (!resume && conn.credits != null && job.credits > conn.credits) job.notice = `⚠ เครดิตใน Flow เหลือ ${conn.credits} แต่งานนี้ใช้ประมาณ ${job.credits} อาจไม่พอ (เติมเครดิตได้ระหว่างทาง หรือหยุดแล้วลดจำนวนท่อน)`;
  const ok = runWorker('run', [], { FLOWBOT_RESUME: resume ? '1' : '0', FLOWBOT_REVIEW: review ? '1' : '0', FLOWBOT_FROM: '1', FLOWBOT_KEEP: partNo > 1 ? '1' : '0' }, { event: onEvent, exit: (code, sawStop) => {
    if (aborted || job.phase === 'stopped') return;
    if (sawStop && pendingStop) { const st = pendingStop; pendingStop = null; return handleStop(st.seg, st.why); }
    if (code === 0 && (job.phase === 'done' || legacy)) {
      if (legacy) job.plan.videos.forEach(v => { if (v.status === 'gen') v.status = 'done'; });
      return setPhase('done');
    }
    setPhase('error', { error: lastErr() });
  } });
  if (!ok) return setPhase('error', { error: 'มีงานอื่นกำลังทำอยู่' });
  setPhase(legacy ? 'videos' : 'work', { msg: '' });
}
function onEvent(tag, rest) {
  const P = job.plan; if (!P) return;
  let o = null; try { o = JSON.parse(rest); } catch { /* ไม่ใช่ JSON */ }
  if (tag === 'PHASE') { if (rest === 'images') setPhase('work'); else if (rest === 'review') setPhase('review'); else if (rest === 'videos') setPhase('videos'); else if (rest === 'done') setPhase('done'); }
  else if (tag === 'IMG' && o) {
    const im = P.images.find(x => x.seg === o.seg); if (!im) return;
    im.status = o.status; if (o.file) im.file = o.file; if (o.status === 'gen' || o.status === 'pending') im.flag = false;
    saveJob();
  } else if (tag === 'VID' && o) { const v = P.videos.find(x => x.seg === o.seg); if (v) { v.status = o.status; saveJob(); } }
  else if (tag === 'RESULT') { const m = rest.match(/^(\d+) (\S+)/); if (m) { const v = P.videos.find(x => x.seg === Number(m[1])); if (v) v.status = m[2] === 'done' ? 'done' : 'bad'; saveJob(); } }
  else if (tag === 'QC' && o) { const v = P.videos.find(x => x.seg === o.seg); if (v) { v.qc = { ok: !!o.ok, flags: o.flags || [], ai: o.ai || null, note: o.note || '' }; saveJob(); } }
  else if (tag === 'STOP' && o) pendingStop = o;
}

// ---------- Flow ปฏิเสธ / ติดปัญหา ----------
function blockOf(seg) { return lib.splitBlocks(readPrompts())[seg - 1] || ''; }
function handleStop(seg, why) {
  addLog('ข้อความผิดพลาดจริง (Segment ' + seg + '): ' + String(why || '(ว่าง)').replace(/\s+/g, ' ').slice(0, 500)); // เก็บของจริงไว้ใน log เพราะข้อความที่โชว์ลูกค้าจะเป็นคำอธิบายสั้นๆ
  const prev = job.stop && job.stop.seg === seg ? job.stop.attempts : 0;
  job.stop = { seg, why: why || '', attempts: prev, text: blockOf(seg), aiTrying: false };
  const isImg = job.plan.images.some(x => x.seg === seg);
  job.stop.kind = isImg ? 'image' : 'video';
  job.stop.no = isImg ? 0 : job.plan.videos.findIndex(x => x.seg === seg) + 1;
  // Google ตรวจเจอกิจกรรมอัตโนมัติ (ไม่ใช่เรื่องเนื้อหา) → ห้ามให้ AI เขียน prompt ใหม่ ให้พัก แล้วค่อยทำต่อ
  if (/กิจกรรมที่ผิดปกติ|unusual activity|suspicious activity|ส่วนขยายของเบราว์เซอร์|browser extension/i.test(why || '')) {
    job.stop.technical = true; job.stop.antibot = true;
    job.stop.why = 'Google Flow แจ้งว่าพบ "กิจกรรมที่ผิดปกติ" (ระบบตรวจจับการควบคุมอัตโนมัติ) ไม่ใช่ prompt มีปัญหา ไม่เสียเครดิต — หยุดพักอย่างน้อย 30-60 นาที แล้วกด "ทำต่อ" · ลดจำนวนคลิปต่อรอบ · ปิดส่วนขยายอื่นใน Chrome ของบอท · อย่าคลิกในหน้าต่างนั้นระหว่างบอททำงาน';
    addLog('หยุด: Flow ตรวจพบกิจกรรมผิดปกติ — พักก่อน ไม่ส่งให้ AI แก้ prompt');
    return setPhase('fix');
  }
  // ปัญหาทางเทคนิค (ไม่ใช่ Flow ปฏิเสธเนื้อหา) → ไม่ส่งให้ AI เขียน prompt ใหม่ เพราะแก้ไม่ได้และเสียเวลา
  if (/ไม่พบรูปอ้างอิง|locator\.|Timeout \d+ms|waiting for locator|Target (page|closed)|net::|Execution context/i.test(why || '')) {
    job.stop.technical = true;
    if (/ไม่พบรูปอ้างอิง/.test(why)) job.stop.why = (why.match(/ไม่พบรูปอ้างอิง[^\n]*/) || [why])[0];
    else job.stop.why = 'หน้า Flow ไม่ตอบสนองตามที่บอทคาด (ไม่ใช่ prompt มีปัญหา) — ปิดหน้าต่างเมนูที่ค้างใน Chrome ของบอท แล้วกด "ทำต่อ" หรือกด "ส่งรายงานปัญหา" · รายละเอียด: ' + String(why || '').replace(/\s+/g, ' ').slice(0, 220);
    addLog('หยุด: ' + job.stop.why);
    return setPhase('fix');
  }
  if (settings.onReject === 'ai' && settings.ai !== 'other' && prev < 2) return aiFix();
  setPhase('fix');
}
function aiFix() {
  job.stop.aiTrying = true; job.stop.attempts += 1;
  setPhase('fix', { msg: '' });
  const seg = job.stop.seg, orig = blockOf(seg);
  askAI(lib.buildFixOne(orig, job.stop.why), 1, (err, text) => {
    if (!err) {
      const t = lib.normalizePrompts(text), nb = lib.splitBlocks(t)[0];
      const a = lib.parseBlock(orig), b = nb && lib.parseBlock(nb);
      if (b && b.kind === a.kind && b.text) {
        fs.writeFileSync(F('prompts.txt'), lib.replaceSegment(readPrompts(), seg, nb), 'utf8');
        addLog(`AI เขียนท่อน ${seg} ใหม่แล้ว (ครั้งที่ ${job.stop.attempts}) ทำต่อ…`);
        job.stop.aiTrying = false; return startRun(true);
      }
      err = 'AI ตอบกลับมาไม่ตรงรูปแบบ';
    }
    addLog('AI แก้ไม่สำเร็จ: ' + err);
    job.stop.aiTrying = false; job.stop.text = blockOf(seg); job.stop.aiFailed = err;
    setPhase('fix');
  });
}

// ---------- คลิปบอร์ด (AI อื่น) ----------
function readClipboard() {
  return new Promise(r => {
    if (process.platform !== 'win32') return r(null);
    exec('powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"', { encoding: 'utf8', timeout: 4000 }, (e, out) => r(e ? null : out));
  });
}
setInterval(async () => {
  if ((job.phase !== 'waitclip' && job.phase !== 'home') || child) return;
  const c = await readClipboard(); if (c == null) return;
  if (clipLast === null) { clipLast = c; return; }
  if (c === clipLast) return;
  clipLast = c;
  if (c.trim().length < 80 || c === job.instruction) return;
  ingest(c, 'คลิปบอร์ด', false, true);
}, 1500);

// ---------- สถานะการเชื่อมต่อ (Chrome / Flow / AI) ----------
let conn = { chrome: false, flow: false, ai: [], at: 0 }, connBusy = false;
function checkConn() {
  if (connBusy || child || process.env.FLOWBOT_SIM) return;
  connBusy = true;
  const c = spawn(process.execPath, [WORKER, 'status'], { cwd: APP, env: { ...process.env, FLOWBOT_DATA: DATA }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; const kill = setTimeout(() => c.kill('SIGKILL'), 15000);
  c.stdout.on('data', d => { out += d; });
  c.on('exit', () => { clearTimeout(kill); connBusy = false; const m = out.match(/@@STATUS (.*)/); if (m) { try { conn = { ...JSON.parse(m[1]), at: Date.now() }; } catch { /* ข้าม */ } } });
}
setInterval(checkConn, 8000); setTimeout(checkConn, 1500);

// ---------- อัปเดตอัตโนมัติ ----------
function doApply() {
  try {
    const r = upd.apply();
    addLog(`อัปเดตเป็นรุ่น ${r.rev} แล้ว${r.notes ? ' (' + r.notes + ')' : ''}${r.restart ? ' — กำลังเริ่มโปรแกรมใหม่' : ''}`);
    if (r.restart && process.env.FLOWBOT_BOOT) setTimeout(() => process.exit(75), 1200);
    return true;
  } catch (e) { upd.state.status = 'error'; upd.state.error = e.message; return false; }
}
function tryApply() { if (!upd.hasPending() || !settings.autoUpdate || child || !['home', 'done'].includes(job.phase)) return; doApply(); }
if (upd.state.enabled) {
  upd.markHealthy();
  const delay = Number(process.env.FLOWBOT_UPDATE_DELAY || 15000);
  setTimeout(async () => { await upd.check(); tryApply(); }, delay).unref();
  setInterval(async () => { await upd.check(); tryApply(); }, Number(process.env.FLOWBOT_UPDATE_EVERY || 3 * 3600 * 1000)).unref();
  setInterval(tryApply, 20000).unref();           // อัปเดตที่รออยู่ ใช้เมื่อบอทว่าง
}

// ---------- HTTP ----------
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const jsonBody = async req => { try { return JSON.parse((await readBody(req)).toString() || '{}'); } catch { return {}; } };
const safeName = n => path.basename(String(n || '')).replace(/[^\w.\-ก-๙ ()]/g, '_');
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function publicState() {
  const P = job.plan;
  const imgsDone = P ? P.images.filter(x => x.status === 'done').length : 0;
  const vidsDone = P ? P.videos.filter(x => x.status === 'done').length : 0;
  return {
    version: VERSION, phase: job.phase, msg: job.msg, error: job.error, notice: job.notice, topic: job.topic,
    plan: P, imgsDone, vidsDone, risks: job.risks, credits: job.credits, stop: job.stop, instruction: job.instruction,
    edit: job.edit, settings, ai: AI_NAME[settings.ai], busy: !!child, log: logLines.slice(-150),
    update: { ...upd.state, auto: settings.autoUpdate, boot: !!process.env.FLOWBOT_BOOT }, sys: SYS, conn, part: partNo, refs: readRefs().map(x => ({ name: x.name, file: x.file, kind: x.kind || 'other', note: x.note || '', on: x.on !== false })), approved: job.approved, flagged: P ? P.images.filter(x => x.flag).map(x => x.name) : [],
  };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    const origin = req.headers.origin; // กันเว็บอื่นแอบสั่งงานผ่าน localhost
    if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return send(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && p === '/') return send(res, 200, fs.readFileSync(path.join(APP, 'ui.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/api/instruction') return send(res, 200, { text: lib.buildInstruction({ topic: '(พิมพ์หัวข้อเรื่องตรงนี้)', parts: settings.parts, ratio: settings.ratio, seconds: settings.videoSeconds, videoMode: settings.videoMode, refs: activeRefs(), part: partNo }) });
    if (req.method === 'GET' && p === '/api/export-snippet') return send(res, 200, { text: lib.buildExportSnippet({ parts: settings.parts, ratio: settings.ratio, seconds: settings.videoSeconds, videoMode: settings.videoMode, refs: activeRefs() }) });
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, publicState());
    if (req.method === 'GET' && p.startsWith('/img/')) {
      const f = path.join(IMG, safeName(decodeURIComponent(p.slice(5))));
      if (!fs.existsSync(f)) return send(res, 404, 'no');
      return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream');
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const b = await jsonBody(req);

    if (p === '/api/settings') {
      for (const k of ['ratio', 'videoSeconds', 'ai', 'review', 'precheck', 'riskAuto', 'onReject', 'auto', 'parts', 'videoMode', 'qc', 'qcRedo', 'dedupe', 'ackRisk', 'autoUpdate']) if (b[k] !== undefined) settings[k] = b[k];
      if (b.login) settings.login = { ...settings.login, ...b.login };
      saveSettings(); return send(res, 200, { ok: true, settings });
    }
    if (p === '/api/go') { // หน้าแรก: พิมพ์หัวข้อ → ให้ AI เขียน prompt
      if (child) return send(res, 200, { ok: false, busy: true, error: 'บอทกำลังทำงานอย่างอื่นอยู่ (' + (childKind || 'งานเดิม') + ') — รอให้เสร็จ หรือกด "หยุด" ก่อน แล้วลองใหม่' });
      settings.ai = b.ai || settings.ai; settings.parts = Number(b.parts) || settings.parts; settings.auto = !!b.auto; saveSettings();
      job = freshJob(); job.topic = String(b.topic || '').slice(0, 500); logLines = [];
      const ins = lib.buildInstruction({ topic: job.topic, parts: settings.parts, ratio: settings.ratio, seconds: settings.videoSeconds, videoMode: settings.videoMode, refs: activeRefs(), part: partNo });
      if (settings.ai === 'other') { clipLast = null; setPhase('waitclip', { instruction: ins }); return send(res, 200, { ok: true }); }
      setPhase('asking', { msg: `${AI_NAME[settings.ai]} กำลังเขียน prompt ให้…` });
      askAI(ins, 2 * settings.parts + 2, (err, text) => { if (err) return setPhase('error', { error: err }); ingest(text, AI_NAME[settings.ai], true); });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/import') { // อ่านคำตอบล่าสุดจากแท็บ AI ที่เปิดอยู่ใน Chrome ของบอท
      if (child) return send(res, 200, { ok: false, busy: true, error: 'บอทกำลังทำงานอย่างอื่นอยู่ (' + (childKind || 'งานเดิม') + ') — รอให้เสร็จ หรือกด "หยุด" ก่อน แล้วลองใหม่' });
      settings.auto = !!b.auto; saveSettings();
      job = freshJob(); logLines = [];
      try { fs.unlinkSync(F('import.txt')); } catch { /* ไม่มี */ }
      try { fs.unlinkSync(F('import-ai.txt')); } catch { /* ไม่มี */ }
      setPhase('asking', { msg: 'กำลังอ่านคำตอบจาก AI…' });
      runWorker('import', ['import'], {}, { exit: code => {
        if (aborted) return;
        let t = ''; try { t = fs.readFileSync(F('import.txt'), 'utf8'); } catch { /* ไม่มี */ }
        if (code === 0 && t.trim()) {
          let k = ''; try { k = fs.readFileSync(F('import-ai.txt'), 'utf8').trim(); } catch { /* ไม่มี */ }
          if (AI_NAME[k] && k !== 'other' && k !== settings.ai) { addLog(`ตรวจพบว่าคุณเขียน prompt ด้วย ${AI_NAME[k]} → บอทจะใช้ ${AI_NAME[k]} ตลอดงานนี้ (แปลง/ปรับ/แก้/ถาม)`); settings.ai = k; saveSettings(); }
          ingest(t, AI_NAME[k] || 'แชต AI', false);
        } else setPhase('error', { error: lastErr() });
      } });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ask-here') { // ส่งคำสั่งส่งออกเข้า "แชตที่เปิดอยู่" ของ AI (เช่น Project ของลูกค้า) แล้วอ่านคำตอบ — ไม่ต้องให้ลูกค้าแปะคำสั่งเอง
      if (child) return send(res, 200, { ok: false, busy: true, error: 'บอทกำลังทำงานอย่างอื่นอยู่ — รอให้เสร็จ หรือกด "หยุด" ก่อน แล้วลองใหม่' });
      if (settings.ai === 'other') return send(res, 200, { ok: false, error: 'เลือก AI ที่ใช้ (Claude/ChatGPT/Gemini) ที่หน้าแรกก่อน' });
      job = freshJob(); logLines = [];
      settings.auto = !!b.auto; saveSettings();
      setPhase('asking', { msg: `ส่งคำสั่งเข้าแชตที่เปิดอยู่ใน ${AI_NAME[settings.ai]} … (เปิดแชต/Project ที่มีเรื่องของคุณไว้ในหน้าต่าง Chrome ของบอท)`, error: '' });
      const note = String(b.note || '').slice(0, 800);
      const msg = 'ส่งออกให้ FlowBot' + (note ? ' — หมายเหตุ: ' + note : '') + '\n\n' + lib.buildInstruction({ topic: '(ตามเรื่อง ตัวละคร ฉาก และบทที่เราทำไว้ในแชต/โปรเจ็กต์นี้ — ห้ามคิดเรื่องใหม่ ห้ามเปลี่ยนดีไซน์ตัวละคร)', parts: settings.parts, ratio: settings.ratio, seconds: settings.videoSeconds, videoMode: settings.videoMode, refs: activeRefs(), part: partNo });
      addLog('ส่งคำสั่งส่งออกเข้าแชตที่เปิดอยู่ → ' + AI_NAME[settings.ai]);
      askAI(msg, 1, (err, out) => {
        if (err) return setPhase('error', { error: `ส่งเข้าแชตที่เปิดอยู่ไม่สำเร็จ: ${err}`, msg: '' });
        ingest(out, 'แชตที่เปิดอยู่', false, false, false);
      }, true);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/convert') { // วางข้อความแบบไหนก็ได้ → ให้ AI ที่เลือกไว้แปลงเป็นรูปแบบที่บอทอ่านได้
      if (child) return send(res, 200, { ok: false, busy: true, error: 'บอทกำลังทำงานอย่างอื่นอยู่ — รอให้เสร็จ หรือกด "หยุด" ก่อน แล้วลองใหม่' });
      const text = String(b.text || '');
      if (text.trim().length < 80) return send(res, 200, { ok: false, error: 'วางข้อความก่อน (สั้นเกินไป)' });
      if (settings.ai === 'other') return send(res, 200, { ok: false, error: 'เลือก AI ที่ใช้ (Claude/ChatGPT/Gemini) ที่หน้าแรกก่อน บอทถึงจะส่งไปแปลงให้ได้' });
      job = freshJob(); logLines = [];
      settings.auto = !!b.auto; saveSettings();
      setPhase('asking', { msg: `ส่งให้ ${AI_NAME[settings.ai]} แปลงเป็นรูปแบบที่บอทอ่านได้… (ต้องล็อกอิน ${AI_NAME[settings.ai]} ไว้ในหน้าต่าง Chrome ของบอท)`, error: '' });
      addLog('ผู้ใช้สั่งให้ AI แปลงข้อความ → ' + AI_NAME[settings.ai]);
      askAI(lib.buildConvert(text, activeRefs()), 0, (err, out) => {
        if (err) return setPhase('error', { error: `ให้ ${AI_NAME[settings.ai]} แปลงให้ไม่สำเร็จ: ${err} — ตรวจว่าล็อกอิน ${AI_NAME[settings.ai]} ไว้ในหน้าต่าง Chrome ของบอทแล้ว`, msg: '' });
        ingest(out, 'ข้อความที่ AI แปลงให้', false, false, true);
      });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/paste') { // มี prompt อยู่แล้ว
      if (child) return send(res, 200, { ok: false, busy: true, error: 'บอทกำลังทำงานอย่างอื่นอยู่ (' + (childKind || 'งานเดิม') + ') — รอให้เสร็จ หรือกด "หยุด" ก่อน แล้วลองใหม่' });
      job = freshJob(); logLines = [];
      settings.auto = !!b.auto; saveSettings();
      return send(res, 200, { ok: ingest(String(b.text || ''), 'ที่วาง', false) });
    }
    if (p === '/api/pre') { // หน้าตรวจก่อนส่ง: ai | edit | go
      if (b.action === 'ai') { job.notice = ''; if (settings.ai === 'other') return send(res, 200, { ok: false, error: 'AI อื่นใช้ปรับอัตโนมัติไม่ได้ เลือก "แก้เอง" ได้เลย' }); lighten(); }
      else if (b.action === 'edit') { setPhase('edit', { edit: readPrompts() }); }
      else if (b.action === 'go') { job.lightened = true; job.risks = []; startRun(false); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/save-edit') { // บันทึก prompt ที่แก้เอง แล้วตรวจใหม่ (ไม่วนซ้ำ) → ทำต่อ
      const t = lib.normalizePrompts(String(b.text || '')), plan = lib.planOf(t), bad = validate(plan, false);
      if (bad) return send(res, 200, { ok: false, error: bad });
      fs.writeFileSync(F('prompts.txt'), t, 'utf8'); job.lightened = true; job.risks = []; startRun(false);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/flag') {
      const im = job.plan && job.plan.images.find(x => x.name === b.name);
      if (!im || im.status !== 'done' || !['work', 'review'].includes(job.phase)) return send(res, 200, { ok: false });
      im.flag = !im.flag;
      let c = {}; try { c = JSON.parse(fs.readFileSync(F('control.json'), 'utf8')); } catch { /* ใหม่ */ }
      c.flagTimes = c.flagTimes || {}; if (im.flag) c.flagTimes[im.name] = Date.now(); else delete c.flagTimes[im.name];
      fs.writeFileSync(F('control.json'), JSON.stringify(c)); saveJob();
      return send(res, 200, { ok: true, flag: im.flag });
    }
    if (p === '/api/redo' || p === '/api/approve') {
      if (job.phase !== 'review') return send(res, 200, { ok: false });
      if (p === '/api/approve') { job.approved = true; job.plan.images.forEach(x => { x.flag = false; }); }
      seq += 1; writeControl({ cmd: { seq, type: p === '/api/redo' ? 'redo' : 'approve' } });
      if (p === '/api/redo') setPhase('work'); else saveJob();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/retry') { // ท่อนที่ติดปัญหา: ใช้ prompt ที่แก้เอง แล้วทำต่อ
      if (!job.stop || child) return send(res, 200, { ok: false });
      const nb = lib.normalizePrompts(String(b.text || '')).trim();
      const orig = lib.parseBlock(blockOf(job.stop.seg)), nw = lib.parseBlock(lib.splitBlocks(nb)[0] || '');
      if (nb && nw.kind === orig.kind && nw.text) fs.writeFileSync(F('prompts.txt'), lib.replaceSegment(readPrompts(), job.stop.seg, lib.splitBlocks(nb)[0]), 'utf8');
      job.stop.attempts = 0; job.stop.aiFailed = ''; startRun(true);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ai-fix') { if (!job.stop || child || settings.ai === 'other') return send(res, 200, { ok: false }); aiFix(); return send(res, 200, { ok: true }); }
    if (p === '/api/resume') { if (child) return send(res, 200, { ok: false }); job.error = ''; startRun(true); return send(res, 200, { ok: true }); }
    if (p === '/api/stop') {
      killWorker();
      if (['work', 'review', 'videos', 'fix', 'asking'].includes(job.phase)) setPhase(job.plan && job.phase !== 'asking' ? 'stopped' : 'home', { msg: 'หยุดแล้ว' });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/reset') { killWorker(); job = freshJob(); partNo = 1; saveJob(); return send(res, 200, { ok: true }); }
    if (p === '/api/update-check') { await upd.check(); if (upd.state.status === 'available' && settings.autoUpdate) tryApply(); return send(res, 200, { ok: true, update: upd.state }); }
    if (p === '/api/update-apply') { if (child || !['home', 'done', 'error', 'stopped'].includes(job.phase)) return send(res, 200, { ok: false, error: 'กำลังทำงานอยู่ รอให้เสร็จก่อน' }); return send(res, 200, { ok: doApply(), update: upd.state }); }
    if (p === '/api/next-part') { // ทำช่วงต่อไปของเรื่องเดิม (จำ Character Sheet / รูปเดิมไว้)
      if (child || job.phase !== 'done') return send(res, 200, { ok: false });
      partNo += 1; job = freshJob(); logLines = []; saveJob();
      return send(res, 200, { ok: true, part: partNo });
    }
    if (p === '/api/qc-test') { // ทดสอบตัวตรวจคลิปกับคลิปที่มีอยู่แล้วในโปรเจ็กต์ Flow (ไม่เสียเครดิต) ผลอยู่ที่ data/qc-test.json
      if (child) return send(res, 200, { ok: false });
      return send(res, 200, { ok: runWorker('qctest', ['qctest', String(Number(b.n) || 3), b.ai ? 'ai' : ''], {}, {}) });
    }
    if (p === '/api/ref-add') { // อัปโหลดรูปอ้างอิง: { name, data: dataURL, kind?, note? }
      if (/^data:image\/(heic|heif)/i.test(String(b.data || '')) || /\.(heic|heif)$/i.test(String(b.name || ''))) return send(res, 200, { ok: false, error: 'รูป HEIC จาก iPhone ยังใช้ไม่ได้ — เปิดรูปแล้วแคปหน้าจอ หรือแปลงเป็น JPG ก่อน' });
      const m = String(b.data || '').match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
      if (!m) return send(res, 200, { ok: false, error: 'ไฟล์ต้องเป็นรูป png / jpg / webp' });
      const buf = Buffer.from(m[2], 'base64'); if (buf.length > 12 * 1024 * 1024) return send(res, 200, { ok: false, error: 'รูปใหญ่เกิน 12MB' });
      const kind = KIND_WORD[b.kind] ? b.kind : 'other';
      const refs = readRefs();
      let want = refName(b.name);
      if (junkName(want)) { let i = 1; while (refs.some(r => r.name.toLowerCase() === (KIND_WORD[kind] + i).toLowerCase())) i++; want = KIND_WORD[kind] + i; }
      const name = b.replace ? want : uniqueRefName(want, refs); // ชื่อซ้ำ = เก็บทั้งคู่ (image.png สองรูปจะไม่ทับกัน)
      const old = refs.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (old) { try { fs.unlinkSync(path.join(IMG, old.file)); } catch { /* ไม่มีไฟล์ */ } }
      const file = name + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
      fs.writeFileSync(path.join(IMG, file), buf);
      const next = refs.filter(x => x !== old); next.push({ name, file, kind, note: String(b.note || '').slice(0, 120), on: true }); writeRefs(next);
      return send(res, 200, { ok: true, name, refs: next });
    }
    if (p === '/api/ref-edit') { // แก้ชื่อ/ประเภท/คำอธิบาย/เปิดปิดการใช้ในเรื่องนี้: { name, newName?, kind?, note?, on? }
      const refs = readRefs(), hit = refs.find(x => x.name === b.name);
      if (!hit) return send(res, 200, { ok: false, error: 'ไม่พบรูปนี้แล้ว' });
      if (b.kind !== undefined && KIND_WORD[b.kind]) hit.kind = b.kind;
      if (b.note !== undefined) hit.note = String(b.note || '').slice(0, 120);
      if (b.on !== undefined) hit.on = !!b.on;
      if (b.newName !== undefined) {
        const want = refName(b.newName);
        if (!want) return send(res, 200, { ok: false, error: 'ชื่อรูปต้องมีตัวอักษรหรือตัวเลข' });
        if (want !== hit.name) {
          const name = uniqueRefName(want, refs, hit), file = name + path.extname(hit.file);
          try { fs.renameSync(path.join(IMG, hit.file), path.join(IMG, file)); hit.name = name; hit.file = file; } catch (e) { return send(res, 200, { ok: false, error: 'เปลี่ยนชื่อไม่ได้: ' + e.message }); }
        }
      }
      if (b.all !== undefined) refs.forEach(r => { r.on = !!b.all; }); // เปิด/ปิดทุกรูปพร้อมกัน
      writeRefs(refs);
      return send(res, 200, { ok: true, name: hit.name, refs });
    }
    if (p === '/api/ref-del') {
      const refs = readRefs(), hit = refs.find(x => x.name === b.name);
      if (hit) { try { fs.unlinkSync(path.join(IMG, hit.file)); } catch { /* ไม่มีไฟล์ */ } writeRefs(refs.filter(x => x !== hit)); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/login') { // ล็อกอินครั้งแรก: flow = เปิด Chrome ของบอท, ai = เปิดเว็บ AI ที่เลือก
      if (child) return send(res, 200, { ok: false });
      if (b.what === 'flow') { settings.login.flow = true; saveSettings(); return send(res, 200, { ok: runWorker('login', ['login'], {}, {}) }); }
      const url = AI_URL[b.ai || settings.ai]; if (!url) return send(res, 200, { ok: false });
      settings.login[b.ai || settings.ai] = true; saveSettings();
      return send(res, 200, { ok: runWorker('open', ['open', url], {}, {}) });
    }
    if (p === '/api/report') { // ปุ่มส่งรายงานปัญหา: รวมข้อมูลเป็นไฟล์ zip (ไม่มีรหัสผ่าน/คุกกี้) ให้ลูกค้าส่งต่อให้ผู้พัฒนา
      try { return send(res, 200, makeReport(String((b && b.note) || ''))); }
      catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (p === '/api/open-flow') return send(res, 200, { ok: runWorker('open', ['open', 'https://flow.google.com/'], {}, {}) });
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
}).on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log('เปิดอยู่แล้ว กำลังเปิดหน้าควบคุม...'); openBrowser(); setTimeout(() => process.exit(0), 1500); } else { console.error(e.message); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`FlowBot ${VERSION} พร้อมแล้วที่ http://127.0.0.1:${PORT}  (ปิดหน้าต่างนี้ = ปิดโปรแกรม)`);
  openBrowser();
});

function openBrowser() {
  if (process.env.FLOWBOT_NOOPEN) return;
  const url = `http://127.0.0.1:${PORT}`;
  if (process.platform === 'win32') exec(`start "" "${url}"`); else if (process.platform === 'darwin') exec(`open ${url}`);
}
process.on('exit', () => { if (child) killWorker(); });
