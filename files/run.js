// flow-bot: ใส่ prompt ทีละ segment ใน Google Flow แล้วรอผล (ไม่โหลดคลิป)
// ใช้: node run.js login   -> เปิด Chrome ปกติ ให้ล็อกอิน Google เอง (ครั้งแรก)
//      node run.js         -> รันตาม prompts.txt
// หมายเหตุ: Google บล็อกการล็อกอินในเบราว์เซอร์ที่ถูกสคริปต์เปิดเอง
// จึงเปิด Chrome ปกติด้วยตัวเอง แล้วค่อยเชื่อมเข้าไปควบคุมผ่านพอร์ต debug
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sel = JSON.parse(fs.readFileSync(path.join(__dirname, 'selectors.json'), 'utf8'));
// เลือกเฉพาะปุ่ม/ช่องที่มองเห็นจริง (Flow มีปุ่มซ้ำที่ซ่อนอยู่ ทำให้ .first() ไปจับตัวที่ซ่อนแล้ว timeout)
for (const k of ['settingsButton', 'generateButton', 'promptBox', 'addButton']) { if (sel[k] && !/visible=true/.test(sel[k])) sel[k] = sel[k] + ' >> visible=true'; }
const DATA = process.env.FLOWBOT_DATA || __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
cfg.qc = 'basic'; // ตรวจคลิปแบบตัวเลขเป็นค่าเริ่มต้น (ปรับได้ในฟันเฟือง)
// การตั้งค่าจากหน้าจอ (ฟันเฟือง) ทับค่าใน config.json
try { const st = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')); if (st.ratio) cfg.ratio = st.ratio; if (st.videoSeconds) cfg.videoSeconds = Number(st.videoSeconds); if (st.videoMode) cfg.videoMode = st.videoMode; if (st.dedupe) cfg.dedupe = true; if (st.qc) cfg.qc = st.qc; if (st.qcRedo) cfg.qcRedo = true; if (st.ai) cfg.ai = st.ai; } catch { /* ไม่มีไฟล์ตั้งค่า */ }
const profileDir = path.join(DATA, 'chrome-profile'); // โปรไฟล์แยกของบอท ล็อกอินครั้งเดียว
// พอร์ตควบคุม Chrome ของบอท: ปกติ 9222 แต่ถ้าโปรแกรมอื่นในเครื่องใช้พอร์ตนี้อยู่ (ตอบ 404) บอทจะย้ายไปพอร์ตว่างและจำไว้
const PORT_FILE = path.join(DATA, 'cdp-port.txt');
let PORT = 9222;
try { const n = Number(fs.readFileSync(PORT_FILE, 'utf8').trim()); if (n > 1024 && n < 65535) PORT = n; } catch { /* ใช้ค่าเริ่มต้น */ }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

const esc = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const lib = require('./lib');
const { splitBlocks, parseSegments, inferPipeline } = lib;
const loadSegments = () => inferPipeline(parseSegments(fs.readFileSync(path.join(DATA, 'prompts.txt'), 'utf8')));

// ---------- สถานะงาน (รูปที่เจนแล้ว/เวอร์ชัน/วิดีโอที่เสร็จ) เก็บใน data/state.json เพื่อรันต่อได้ ----------
const STATE_FILE = path.join(DATA, 'state.json');
let state = { tag: '', imgs: {}, vids: {} };
function loadState() { try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* ใหม่ */ } state.imgs = state.imgs || {}; state.vids = state.vids || {}; }
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
const keyOf = n => String(n || '').trim().toLowerCase();
// ชื่อจริงของรูป (รวมเวอร์ชัน) ที่ใช้ค้นในไลบรารี Flow — ถ้าไม่ใช่รูปที่บอทเจนเอง คืนชื่อเดิม
function resolveName(name) { const s = state.imgs[keyOf(name)]; return s && s.done && s.base ? s.base : s && s.prev ? s.prev : name; }
const sendEv = (tag, ...a) => console.log('@@' + tag + ' ' + a.join(' '));
// คำสั่งจากหน้าจอ (data/control.json): { flagTimes:{ชื่อรูป:เวลาที่แตะ}, cmd:{seq,type} }
function readControl() { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'control.json'), 'utf8')); } catch { return { flagTimes: {}, cmd: { seq: 0 } }; } }


// ล้างพรอมต์ (ข้อความ + ภาพที่แนบค้างจาก segment ก่อนหน้า) ด้วยปุ่ม "ล้างพรอมต์" ถ้ามี
async function clearPrompt(page) {
  const btn = page.locator(sel.clearPrompt).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await sleep(800);
  }
}

const IMG_DIR = path.join(DATA, 'images');
function findImage(name) {
  let files = [];
  try { files = fs.readdirSync(IMG_DIR); } catch { /* ไม่มีโฟลเดอร์ images */ }
  const n = name.trim().toLowerCase();
  const exact = files.find(f => f.toLowerCase() === n) || files.find(f => path.parse(f).name.toLowerCase() === n);
  if (exact) return exact;
  // ชื่อใกล้เคียง: เลือกอันที่ความยาวชื่อใกล้ที่สุด (เช่น "character" ต้องได้ characterpng ไม่ใช่ "Character Sheet A-xxxx" ที่บอทเจนไว้) และให้รูปที่ผู้ใช้อัปโหลดเองมาก่อน
  let userFiles = [];
  try { userFiles = JSON.parse(fs.readFileSync(path.join(DATA, 'refs.json'), 'utf8')).map(r => r.file); } catch { /* ไม่มี refs */ }
  const near = files.filter(f => { const b = path.parse(f).name.toLowerCase(); return b.length >= 3 && (n.startsWith(b) || b.startsWith(n)); });
  near.sort((a, b) => (userFiles.includes(b) - userFiles.includes(a)) || (Math.abs(path.parse(a).name.length - n.length) - Math.abs(path.parse(b).name.length - n.length)));
  return near[0];
}

// แนบภาพ: เปิดเมนู + ค้นหาในไลบรารีของ Flow ก่อน ถ้าไม่เจอและมีไฟล์ในโฟลเดอร์ images ให้อัปโหลด แล้วกด "เพิ่มไปยังพรอมต์"
async function attachImages(page, names) {
  try { await attachImages0(page, names); }
  catch (e) { // ปิดเมนูเลือกภาพเสมอเมื่อพลาด ไม่งั้นมันบังปุ่มอื่นแล้วเกิด error ต่อเนื่อง
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape').catch(() => {}); await sleep(400); if (!(await page.locator(sel.pickerUpload).first().isVisible().catch(() => false))) break; }
    throw e;
  }
}
async function attachImages0(page, names) {
  for (const orig of names) {
    const name = resolveName(orig);
    const file = findImage(name);
    const base = file ? path.parse(file).name : name;
    const key = base.slice(0, 20);
    log(`แนบภาพ: ${orig}${name !== orig ? ' → ' + name : ''}${file ? ` (ไฟล์ ${file})` : ' (ไม่มีไฟล์ในโฟลเดอร์ images จะค้นหาในไลบรารี Flow)'}`);
    if (!(await page.locator(sel.pickerUpload).first().isVisible().catch(() => false))) {
      await page.locator(sel.addButton).first().click(); // เมนูยังไม่เปิด ค่อยกดปุ่ม +
    }
    await page.locator(sel.pickerUpload).first().waitFor({ timeout: 15000 });
    const search = page.locator(sel.pickerSearch).first();
    const findItem = async () => {
      await search.fill(base);
      await sleep(1500);
      const exact = await findAsset(page, base);
      if (exact) return exact;
      if (state.imgs[keyOf(orig)]) return null; // รูปที่บอทเจนเอง ต้องตรงชื่อเวอร์ชันเท่านั้น
      const item = page.locator(sel.pickerItem).filter({ hasText: key }).first();
      return (await item.isVisible().catch(() => false)) ? item : null;
    };
    let item = await findItem();
    if (!item && file) {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15000 }),
        page.locator(sel.pickerUpload).first().click(),
      ]);
      await chooser.setFiles(path.join(IMG_DIR, file));
      log('อัปโหลดไฟล์แล้ว รอ Flow ประมวลผล...');
      for (let t = 0; t < 10 && !item; t++) { await sleep(3000); item = await findItem(); }
    }
    if (!item) throw new Error(`ไม่พบรูปอ้างอิง "${orig}" — ยังไม่ได้อัปโหลดรูปนี้ในหน้าแรกของ FlowBot (ช่อง "รูปอ้างอิง") และไม่มีในไลบรารีของโปรเจ็กต์ Flow`);
    await item.click();
    await sleep(1500);
    // ภาพ: คลิกแล้วเข้าพรอมต์เลย / วิดีโอ: ต้องกด "เพิ่มไปยังพรอมต์" อีกที
    const addBtn = page.locator(sel.pickerAdd).first();
    if (await addBtn.isVisible().catch(() => false)) await addBtn.click();
    await sleep(1500);
    // ปิดเมนูถ้ายังเปิดอยู่
    if (await page.locator(sel.pickerUpload).first().isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await sleep(800);
    }
  }
}


// ---------- โหมดคีย์เฟรม: เจนรูป -> อัปโหลดเข้าไลบรารี -> เจนวิดีโอแบบเฟรม ----------
const safeName = n => String(n).replace(/[^\w\-ก-๙ ()]/g, '_');

async function clickRadio(page, labels) {
  const L = [].concat(labels), label = L[0];
  const all = page.locator('button[role=radio]');
  const info = await all.evaluateAll(els => els.map(e => {
    const r = e.getBoundingClientRect();
    return { t: (e.innerText || '').replace(/\s+/g, ' ').trim(), vis: r.width > 0 && r.height > 0 };
  }));
  const idx = info.findIndex(x => x.vis && L.some(l => x.t === l || x.t.endsWith(' ' + l)));
  if (idx < 0) { log(`หาปุ่มตั้งค่า "${label}" ไม่เจอ (มี: ${info.map(x => x.t).join(' | ')})`); return false; }
  await all.nth(idx).click();
  return true;
}
async function chipText(page) {
  return (await page.locator(sel.settingsButton).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}
// ปิดหน้าต่าง/แบนเนอร์ของ Flow ที่อาจบังปุ่ม (หน้าต้อนรับผู้ใช้ใหม่, ทัวร์แนะนำ, มีอะไรใหม่, แบนเนอร์เครดิต)
// กดเฉพาะปุ่มปิด/ข้าม เท่านั้น — ไม่กด "ยอมรับ"/"ตกลง" อะไรแทนลูกค้า
async function dismissOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {}); await sleep(400);
  const n = await page.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const TXT = /^(close|ปิด|ข้าม|skip|เข้าใจแล้ว|รับทราบ|got it|ไม่ใช่ตอนนี้|not now|ไว้ทีหลัง|maybe later|later|dismiss|no thanks|ไม่เป็นไร)$/i;
    const LBL = /^(ปิด|close|dismiss|ข้าม|skip)$|^ปิดแบนเนอร์|^(close|dismiss) (banner|dialog|tour)/i;
    let c = 0;
    const inLayer = [...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button, [aria-modal=true] button, .cdk-overlay-container button')];
    const labelled = [...document.querySelectorAll('button[aria-label]')];
    for (const b of new Set([...inLayer, ...labelled])) {
      if (!vis(b) || b.closest('[role=radiogroup]')) continue;
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim(), l = (b.getAttribute('aria-label') || '').trim();
      const inside = inLayer.includes(b);
      if ((inside && TXT.test(t)) || LBL.test(l)) { b.click(); c++; }
    }
    return c;
  }).catch(() => 0);
  if (n) { log(`ปิดหน้าต่าง/แบนเนอร์ของ Flow ที่อาจบังปุ่ม ${n} อัน`); await sleep(800); }
  return n;
}

// เก็บข้อมูลตอนกดปุ่มไม่ได้: ภาพหน้าจอ + อะไรทับปุ่มอยู่ (ใส่ในรายงานปัญหาอัตโนมัติ)
async function diagButton(page, locator, tag) {
  await page.screenshot({ path: path.join(DATA, `fail-${tag}.png`) }).catch(() => {});
  const info = await locator.evaluate(b => {
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const d = e => e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : ''}${e.getAttribute('aria-label') ? '[aria-label=' + e.getAttribute('aria-label') + ']' : ''} "${(e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)}"` : 'ไม่มี';
    return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], view: [innerWidth, innerHeight], covered: !!top && top !== b && !b.contains(top), top: d(top) };
  }, null, { timeout: 3000 }).catch(() => null);
  const dialogs = await page.evaluate(() => [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 150))).catch(() => []);
  const btns = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],[role=switch],[role=tab]')]
    .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(b => `${(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 18)}|${b.getAttribute('aria-label') || ''}|${String(b.className || '').split(' ').filter(c => c && !/^(mat-|mdc-|_|flow-)/.test(c)).slice(0, 3).join('.')}`).slice(0, 45)).catch(() => []);
  log(`[วินิจฉัย ${tag}] url=${page.url()} | ปุ่ม=${info ? JSON.stringify(info) : 'หาไม่เจอในหน้า'} | หน้าต่างที่เปิดอยู่=${dialogs.length ? dialogs.join(' || ') : 'ไม่มี'}`);
  log(`[วินิจฉัย ${tag}] ปุ่มที่เห็นในหน้า (${btns.length}): ${btns.join(' ; ')}`);
  if (info) info.dialogs = dialogs;
  return info;
}

// Flow รุ่นใหม่บางบัญชีเปิดโหมด "Agent" เป็นค่าเริ่มต้น → แถบตั้งค่าเดิมหายไป: ลองกดปุ่ม Agent เพื่อสลับกลับโหมดปกติ
async function toggleAgent(page) {
  return page.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const c = [...document.querySelectorAll('button,[role=button],[role=switch],[role=tab]')].filter(vis)
      .filter(b => /^agent$/i.test((b.innerText || '').replace(/\s+/g, ' ').trim()) || /^agent( mode)?$/i.test((b.getAttribute('aria-label') || '').trim()));
    if (!c.length) return false; c[0].click(); return true;
  }).catch(() => false);
}

// ไม่เจอปุ่มตั้งค่าที่มองเห็นเลย → ลองสลับออกจากโหมด Agent (ถ้าเจอปุ่มนั้น)
async function tryLeaveAgent(page, btn, isOpen) {
  const shown = async () => (await page.locator(sel.settingsButton).count().catch(() => 0)) > 0;
  if (await shown() || !(await toggleAgent(page))) return false;
  log('ไม่เจอปุ่มตั้งค่า แต่เจอปุ่ม Agent — ลองสลับออกจากโหมด Agent'); await sleep(2000);
  if (await shown()) {
    await btn.click({ timeout: 8000 }).catch(() => {}); await sleep(1000);
    if (await isOpen()) { log('สลับออกจากโหมด Agent แล้วเปิดเมนูตั้งค่าได้'); return true; }
  } else { await toggleAgent(page); await sleep(800); log('สลับโหมด Agent แล้วยังไม่เจอปุ่มตั้งค่า — สลับกลับให้เหมือนเดิม'); }
  return false;
}

// เปิดเมนูตั้งค่า: กดไม่โดน → ปิดสิ่งที่บัง แล้วลองใหม่ (แทนรอ 30 วิแล้วล้ม)
async function openSettings(page, isOpen) {
  const btn = page.locator(sel.settingsButton).first();
  let agentTried = false;
  if (!(await btn.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false))) {
    agentTried = true;
    if (await tryLeaveAgent(page, btn, isOpen)) return;
  }
  for (let i = 1; i <= 3; i++) {
    try { await btn.click({ timeout: 8000 }); await sleep(1000); if (await isOpen()) return; }
    catch { /* ลองใหม่ด้านล่าง */ }
    log(`กดปุ่มตั้งค่าของ Flow ไม่โดน (ครั้งที่ ${i}/3) — ปิดหน้าต่างที่อาจบังอยู่แล้วลองใหม่`);
    await dismissOverlays(page);
  }
  if (!agentTried && await tryLeaveAgent(page, btn, isOpen)) return;
  const info = await diagButton(page, btn, 'settings');
  // มีหน้าต่างของ Flow ที่ต้องให้ลูกค้าตัดสินใจเอง (เช่น ข้อกำหนด) → หยุดบอกลูกค้า ไม่กดแทน
  if (info && info.covered && info.dialogs && info.dialogs.length) throw new Error(`Flow มีหน้าต่างค้างอยู่ที่บอทปิดเองไม่ได้: "${info.dialogs[0].slice(0, 100)}" · ไปที่หน้าต่าง Chrome ของบอท อ่านแล้วกดปิด/ตอบหน้าต่างนั้นเอง แล้วกด "ลองใหม่"`);
  // ทางสุดท้าย: กดตรงที่ปุ่มแบบไม่สนสิ่งที่บัง
  await btn.click({ force: true, timeout: 5000 }).catch(() => {}); await sleep(1000);
  if (await isOpen()) { log('เปิดเมนูตั้งค่าได้ด้วยการกดแบบบังคับ'); return; }
  await btn.evaluate(b => b.click(), null, { timeout: 3000 }).catch(() => {}); await sleep(1000);
  if (await isOpen()) { log('เปิดเมนูตั้งค่าได้ด้วยการกดผ่านหน้าเว็บ'); return; }
  const why = !info ? 'ไม่เจอปุ่มตั้งค่าในหน้า (หน้า Flow อาจยังโหลดไม่เสร็จ หรือไม่ได้อยู่ในหน้าโปรเจ็กต์)'
    : info.covered ? `มีบางอย่างบังปุ่มตั้งค่าอยู่: ${info.top}` : 'กดปุ่มตั้งค่าแล้วแต่เมนูไม่เปิด';
  throw new Error(`เปิดเมนูตั้งค่าของ Flow ไม่ได้ — ${why} · ไปที่หน้าต่าง Chrome ของบอท ปิดหน้าต่าง/ป๊อปอัปที่ค้างอยู่ แล้วกด "ลองใหม่" (ถ้ายังไม่ได้ กด "ส่งรายงานปัญหา" — ในรายงานมีภาพหน้าจอตอนนั้นแล้ว)`);
}

// ตั้งโหมด: type = image | video, frames = ใช้โหมดเฟรม (วิดีโอ), พร้อมสัดส่วน/วินาที/จำนวนจาก config.json
async function setMode(page, { type, frames }) {
  const isOpen = async () => (await page.locator('button[role=radio]').count()) > 0 && await page.locator('button[role=radio]').first().isVisible().catch(() => false);
  if (!(await isOpen())) await openSettings(page, isOpen);
  await clickRadio(page, type === 'image' ? ['รูปภาพ', 'Image'] : ['วิดีโอ', 'Video']); await sleep(800);
  if (type === 'video') { await clickRadio(page, frames ? ['เฟรม', 'Frames'] : ['องค์ประกอบ', 'Ingredients']); await sleep(600); }
  if (cfg.ratio) await clickRadio(page, cfg.ratio);
  if (type === 'video' && cfg.videoSeconds) await clickRadio(page, [`${cfg.videoSeconds} วินาที`, `${cfg.videoSeconds}s`, `${cfg.videoSeconds} s`]);
  await clickRadio(page, 'x' + (type === 'image' ? (cfg.imageCount || 1) : (cfg.videoCount || 1)));
  await sleep(400);
  await page.keyboard.press('Escape'); await sleep(800);
  log(`ตั้งโหมด: ${await chipText(page)}${frames ? ' (เฟรม)' : ''}`);
}

async function typePrompt(page, text) {
  const box = page.locator(sel.promptBox).first();
  await box.waitFor({ timeout: 30000 });
  await box.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

// รายการรูปที่แสดงในหน้าโปรเจ็กต์ (id จาก flow-content.google/image/<id>)
async function imageIds(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('img').forEach(i => {
      const r = i.getBoundingClientRect(); const src = i.currentSrc || i.src || '';
      const m = src.match(/flow-content\.google\/image\/([0-9a-f-]{36})/);
      if (m && r.width > 60) out.push({ id: m[1], src });
    });
    return out;
  });
}

async function waitImages(page, beforeIds, expected) {
  const deadline = Date.now() + cfg.segmentTimeoutMs;
  const started = Date.now();
  let sawProgress = false, lastSeen = Date.now(), stableSince = 0, lastCount = -1;
  while (Date.now() < deadline) {
    const progress = await page.locator(sel.progressIndicator).count();
    const fresh = [];
    for (const it of await imageIds(page)) if (!beforeIds.has(it.id) && !fresh.find(f => f.id === it.id)) fresh.push(it);
    if (progress > 0) { sawProgress = true; lastSeen = Date.now(); }
    if (fresh.length !== lastCount) { lastCount = fresh.length; stableSince = Date.now(); }
    if (fresh.length >= expected && progress === 0 && Date.now() - stableSince > 4000) return { status: 'done', fresh };
    if (sawProgress && progress === 0 && Date.now() - lastSeen > 45000) return { status: fresh.length ? 'done' : 'failed', fresh };
    if (!sawProgress && Date.now() - started > (cfg.noProgressTimeoutMs || 240000)) return { status: fresh.length ? 'done' : 'failed', fresh };
    await sleep(2500);
  }
  return { status: 'timeout', fresh: [] };
}

async function saveImage(page, src, name) {
  const r = await page.evaluate(async u => {
    const res = await fetch(u); const b = await res.blob(); const a = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return { t: b.type, b64: btoa(s) };
  }, src);
  const ext = /jpe?g/.test(r.t) ? '.jpg' : /webp/.test(r.t) ? '.webp' : '.png';
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const file = path.join(IMG_DIR, safeName(name) + ext);
  fs.writeFileSync(file, Buffer.from(r.b64, 'base64'));
  return file;
}

async function findAsset(page, name) {
  const items = page.locator(sel.pickerItem);
  const texts = await items.evaluateAll(els => els.map(e => e.innerText)).catch(() => []);
  const re = new RegExp('(^|\\s)' + esc(name) + '(\\.\\w+)?(\\s|$)', 'i');
  const idx = texts.findIndex(t => re.test(t));
  return idx >= 0 ? items.nth(idx) : null;
}
async function openPlusPicker(page) {
  if (await page.locator(sel.pickerUpload).first().isVisible().catch(() => false)) return;
  const byAria = page.locator(sel.addButton).first();
  if (await byAria.isVisible().catch(() => false)) await byAria.click();
  else {
    const h = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'add' && !['เมนูเพิ่มสื่อ', 'Add media menu'].includes(b.getAttribute('aria-label')) && b.getBoundingClientRect().y > 600) || null);
    const el = h.asElement(); if (!el) throw new Error('ไม่พบปุ่ม + สำหรับเปิดไลบรารี'); await el.click();
  }
  await page.locator(sel.pickerUpload).first().waitFor({ timeout: 15000 });
}
// อัปโหลดไฟล์ในโฟลเดอร์ images เข้าไลบรารี Flow (ชื่อ = ชื่อไฟล์) ถ้ายังไม่มี
async function uploadToLibrary(page, file, name) {
  await openPlusPicker(page);
  const search = page.locator(sel.pickerSearch).first();
  await search.fill(name); await sleep(1500);
  let item = await findAsset(page, name);
  if (!item) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.locator(sel.pickerUpload).first().click(),
    ]);
    await chooser.setFiles(file);
    for (let t = 0; t < 12 && !item; t++) { await sleep(3000); await search.fill(name); await sleep(1200); item = await findAsset(page, name); }
  }
  if (await page.locator(sel.pickerUpload).first().isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await sleep(800); }
  if (!item) throw new Error(`อัปโหลดภาพ "${name}" เข้าไลบรารีไม่สำเร็จ`);
}

// หาไทล์รูปจาก id รูป แล้วคืนตัวชี้ไทล์ (ใช้ตอนลบสำเนาซ้ำ / ตรวจปุ่มลบ)
async function tileHandle(page, id) {
  const h = await page.evaluateHandle(id => {
    const img = [...document.querySelectorAll('img')].find(i => (i.currentSrc || i.src || '').includes(id) && i.getBoundingClientRect().width > 60);
    if (!img) return null;
    let el = img;
    for (let k = 0; k < 6 && el.parentElement; k++) { const r = el.parentElement.getBoundingClientRect(); if (r.width > img.getBoundingClientRect().width * 2.2) break; el = el.parentElement; }
    return el;
  }, id);
  return h.asElement();
}
// ลบรูปต้นฉบับที่ Flow เจน หลังอัปโหลดสำเนาตั้งชื่อแล้ว (เปิดใช้ด้วย dedupe ใน settings.json เท่านั้น เพราะลบแล้วย้อนไม่ได้)
async function dedupeOriginal(page, id) {
  try {
    const tile = await tileHandle(page, id);
    if (!tile) { log('ลบรูปซ้ำ: ไม่พบไทล์ต้นฉบับ ข้ามไป'); return false; }
    await tile.hover(); await sleep(600);
    const btns = await tile.$$('button');
    let target = null;
    for (const b of btns) { const t = ((await b.getAttribute('aria-label')) || '') + ' ' + ((await b.innerText().catch(() => '')) || ''); if (/ลบ|delete|trash|ถังขยะ/i.test(t)) { target = b; break; } }
    if (!target) { log('ลบรูปซ้ำ: ไม่พบปุ่มลบในไทล์ ข้ามไป'); return false; }
    await target.click(); await sleep(900);
    const confirm = page.locator('[role=dialog] button, [role=alertdialog] button').filter({ hasText: /ลบ|ยืนยัน|delete/i }).first();
    if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await sleep(900); }
    log('ลบรูปต้นฉบับที่ซ้ำกับสำเนาแล้ว');
    return true;
  } catch (e) { log('ลบรูปซ้ำไม่สำเร็จ (ไม่กระทบงาน): ' + e.message); return false; }
}

async function runImageStep(page, seg, n, vname) {
  const name = seg.name || `K${n}`;
  await setMode(page, { type: 'image' });
  await clearPrompt(page);
  await typePrompt(page, seg.text);
  if (seg.images.length) await attachImages(page, seg.images);
  await page.screenshot({ path: path.join(DATA, `shot-seg${n}.png`) }).catch(() => {});
  const m = (await chipText(page)).match(/x(\d)/);
  const expected = m ? Number(m[1]) : 1;
  const before = new Set((await imageIds(page)).map(i => i.id));
  await page.locator(sel.generateButton).first().click();
  log(`Segment ${n}: กำลังเจนรูป ${name}... (คาดว่าได้ ${expected} รูป)`);
  const r = await waitImages(page, before, expected);
  if (r.status !== 'done') return { status: r.status };
  const file = await saveImage(page, r.fresh[0].src, vname);
  log(`Segment ${n}: บันทึกรูป ${path.basename(file)} แล้ว กำลังอัปโหลดเข้าไลบรารี Flow`);
  await uploadToLibrary(page, file, safeName(vname));
  if (cfg.dedupe) await dedupeOriginal(page, r.fresh[0].id);
  return { status: 'done', file: path.basename(file) };
}

const SLOT_RE = { 'เริ่ม': /^\s*(เริ่ม|Start)\s*$/i, 'สิ้นสุด': /^\s*(สิ้นสุด|End)\s*$/i };
async function pickFrame(page, slotLabel, orig) {
  const name = resolveName(orig);
  const chip = page.locator('button.empty-chip').filter({ hasText: SLOT_RE[slotLabel] || slotLabel }).first();
  if (!(await chip.isVisible().catch(() => false))) throw new Error(`ไม่พบช่องเฟรม "${slotLabel}" (ต้องอยู่โหมดเฟรม)`);
  await chip.click();
  await page.locator(sel.pickerUpload).first().waitFor({ timeout: 15000 });
  const search = page.locator(sel.pickerSearch).first();
  await search.fill(name); await sleep(1500);
  let item = await findAsset(page, name);
  const file = findImage(name);
  if (!item && file) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.locator(sel.pickerUpload).first().click(),
    ]);
    await chooser.setFiles(path.join(IMG_DIR, file));
    for (let t = 0; t < 12 && !item; t++) { await sleep(3000); await search.fill(name); await sleep(1200); item = await findAsset(page, name); }
  }
  if (!item) throw new Error(`ไม่พบภาพ "${name}" สำหรับช่องเฟรม "${slotLabel}"`);
  await item.click(); await sleep(1500);
  const addBtn = page.locator(sel.pickerAdd).first();
  if (await addBtn.isVisible().catch(() => false)) { await addBtn.click(); await sleep(1000); }
  if (await page.locator(sel.pickerUpload).first().isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await sleep(800); }
  const stillEmpty = await page.locator('button.empty-chip').filter({ hasText: SLOT_RE[slotLabel] || slotLabel }).count();
  if (stillEmpty) throw new Error(`ใส่ภาพ "${name}" ในช่อง "${slotLabel}" ไม่สำเร็จ`);
  log(`ใส่เฟรม ${slotLabel} = ${orig}${name !== orig ? ' (' + name + ')' : ''} แล้ว`);
}

// เลือกโหมดวิดีโอของท่อนนี้: auto = ตามแท็ก (มีช่องเริ่ม/จบ = เฟรม, มีรูปแนบ = องค์ประกอบ) · ingredients/frames = บังคับ (ตั้งในฟันเฟือง)
function pickVideoMode(seg, mode) {
  const imgs = seg.images || [];
  const hasFrames = !!(seg.start || seg.end);
  let frames = hasFrames, start = seg.start, end = seg.end, ingredients = imgs;
  if (mode === 'ingredients') { frames = false; ingredients = imgs.length ? imgs : [seg.start, seg.end].filter(Boolean); }
  else if (mode === 'frames') {
    frames = true;
    if (!hasFrames) { const L = imgs.filter(n => !/character|sheet|storyboard/i.test(n)); const pool = L.length ? L : imgs; start = pool[0]; end = pool.length > 1 ? pool[pool.length - 1] : null; }
  } else if (!hasFrames) frames = false;
  return { frames, start: frames ? start : null, end: frames ? end : null, ingredients: frames ? [] : ingredients };
}
async function runVideoStep(page, seg, n) {
  const { frames, start, end, ingredients } = pickVideoMode(seg, cfg.videoMode);
  await setMode(page, { type: 'video', frames });
  await clearPrompt(page);
  if (start) await pickFrame(page, 'เริ่ม', start);
  if (end) await pickFrame(page, 'สิ้นสุด', end);
  await typePrompt(page, seg.text);
  if (ingredients.length && !frames) await attachImages(page, ingredients);
  await page.screenshot({ path: path.join(DATA, `shot-seg${n}.png`) }).catch(() => {});
  const m = (await chipText(page)).match(/x(\d)/);
  const expected = m ? Number(m[1]) : 1;
  const before = await doneCount(page);
  await creditGate(page);
  await page.locator(sel.generateButton).first().click();
  log(`Segment ${n}: กำลังเจนวิดีโอ${frames ? ` (${seg.start || '-'} → ${seg.end || '-'})` : ''}... (คาดว่าได้ ${expected} คลิป)`);
  return waitResult(page, before, expected);
}


// อ่านเครดิตคงเหลือจากหน้า Flow: สแกนข้อความ/aria-label ที่มีคำว่าเครดิต (ไทย) / credit (อังกฤษ) + ตัวเลข
// ถ้ายังไม่เจอ ลองชี้เมาส์ที่ป้าย PRO/ไอคอนบัญชีมุมขวาบน (Flow แสดงยอดในป้ายช่วย) แล้วสแกนซ้ำ · คืน {credits, low, hits, mentions}
async function scanCredits(page) {
  return page.evaluate(() => {
    const hits = [], mentions = [];
    const num = t => { const m = String(t).replace(/,/g, '').match(/\d{1,6}/g); return m ? m.map(Number) : []; };
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.children.length < 4 ? (el.innerText || '') : '')).replace(/\s+/g, ' ').trim();
      if (!t || t.length > 160 || !/เครดิต|credit/i.test(t)) return;
      if (num(t).length) hits.push(t); else mentions.push(t);
    });
    let credits = null;
    for (const t of hits) { const m = t.replace(/,/g, '').match(/(?:เครดิต[^\d]{0,24}|credits?[^\d]{0,24})(\d{1,6})|(\d{1,6})\s*(?:เครดิต|credits?)/i); if (m) { credits = Number(m[1] || m[2]); break; } }
    const low = mentions.concat(hits).some(t => /เหลือน้อย|ใกล้หมด|low on|running low|credits? (?:are |is )?low|low credits?|out of credits|ไม่เพียงพอ|insufficient/i.test(t));
    return { credits, low, hits: [...new Set(hits)].slice(0, 12), mentions: [...new Set(mentions)].slice(0, 8) };
  }).catch(() => ({ credits: null, low: false, hits: [], mentions: [] }));
}
async function readCredits(page, hover) {
  let c = await scanCredits(page);
  if (c.credits == null && hover) {
    // ลองชี้เมาส์ที่ป้ายมุมขวาบน (PRO / ULTRA / ไอคอนบัญชี)
    for (const q of ['text=/^(PRO|ULTRA|PLUS|FREE)$/i', 'header [aria-label*="account" i]', 'a[aria-label*="Google Account" i]']) {
      const el = page.locator(q).first();
      if (await el.isVisible().catch(() => false)) {
        await el.hover({ timeout: 3000 }).catch(() => {});
        await sleep(900);
        const c2 = await scanCredits(page);
        c.hits = [...new Set([...c.hits, ...c2.hits])]; c.mentions = [...new Set([...c.mentions, ...c2.mentions])]; c.low = c.low || c2.low;
        if (c2.credits != null) { c.credits = c2.credits; break; }
      }
    }
    await page.mouse.move(5, 300).catch(() => {});
  }
  return c;
}

// อ่านข้อความที่ Flow แจ้งตอนล้มเหลว (เช่น "พรอมต์อาจละเมิดนโยบาย...")
async function failReason(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('*')].filter(e => e.children.length < 6 && /ล้มเหลว|failed|couldn.t|not charged|policy/i.test(e.innerText || '') && (e.innerText || '').length < 400);
    if (!els.length) return '';
    els.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const t = (els[els.length - 1].innerText || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 250);
  }).then(t => (/เครดิต|credit/i.test(t) ? 'เครดิตไม่พอ/มีปัญหาเรื่องเครดิต — ' : '') + t).catch(() => '');
}

// ก่อนกดสร้าง: Flow ไม่ได้แสดงยอดเครดิตเป็นตัวเลขบนหน้าหลัก แต่จะขึ้น "คำเตือนเครดิตไม่เพียงพอ" ข้างช่อง prompt และปุ่มสร้างจะกดไม่ได้เมื่อไม่พอ
// → ถ้าเจอคำเตือน + ปุ่มกดไม่ได้ = หยุดอย่างสุภาพ (กด "ทำต่อ" ได้หลังเติมเครดิต) ไม่ใช่รอจนหมดเวลา
async function creditGate(page) {
  const probe = async () => {
    const c = await scanCredits(page);
    const warn = [...c.mentions, ...c.hits].some(t => /เครดิตไม่เพียงพอ|เครดิตไม่พอ|insufficient credit|not enough credit/i.test(t));
    const gen = page.locator(sel.generateButton).first();
    const dis = !(await gen.isVisible().catch(() => false)) || (await gen.isDisabled().catch(() => false)); // ไม่มีปุ่ม หรือกดไม่ได้ = สร้างไม่ได้
    return { c, warn, dis };
  };
  let p = await probe();
  if (p.warn) { await sleep(2500); p = await probe(); }
  if (p.warn && p.dis) throw new Error('เครดิต Google Flow ไม่พอสำหรับคลิปนี้ — เติมเครดิต (หรือรอรีเซ็ตรายเดือน) แล้วกด "ทำต่อ" บอทจะเจนต่อจากท่อนนี้');
  if (p.warn) log('⚠ Flow แสดงคำเตือนเครดิตไม่เพียงพอ แต่ยังกดสร้างได้ — ลองสร้างต่อ');
  else if (p.c.low) log('ℹ Flow แจ้งเครดิตเหลือน้อย — ระวังเครดิตหมดกลางทาง');
}

const readline = require('readline');
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}

// ถ้ายังไม่ได้อยู่ในโปรเจ็กต์ (ไม่มีช่องพิมพ์) ให้กด "โปรเจ็กต์ใหม่" เอง
async function ensureProject(page) {
  const box = page.locator(sel.promptBox).first();
  if (await box.isVisible().catch(() => false)) return;
  log('ยังไม่ได้อยู่ในโปรเจ็กต์ กำลังสร้างโปรเจ็กต์ใหม่...');
  const NEWP = /โปรเจ็กต์ใหม่|โปรเจกต์ใหม่|New project|เริ่มสร้าง|Get started|Start creating|Create new/i;
  const findBtn = () => page.getByRole('button', { name: NEWP });
  const findTxt = () => page.getByText(NEWP);
  // เลือก "อันแรกที่มองเห็นจริง" (ตัวแรกใน DOM อาจเป็นข้อความที่ซ่อนอยู่ ทำให้รอจนหมดเวลา)
  const pick = async () => {
    for (const mk of [findBtn, findTxt]) {
      const all = await mk().all().catch(() => []);
      for (const l of all) if (await l.isVisible().catch(() => false)) return l;
    }
    return null;
  };
  await page.keyboard.press('Escape').catch(() => {}); // ปิดเมนูบัญชี/หน้าต่างที่เปิดค้างอยู่
  let btn = null;
  for (let round = 1; round <= 3 && !btn; round++) {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000 && !btn) {
      if (await box.isVisible().catch(() => false)) return;
      btn = await pick();
      if (!btn) await sleep(1000);
    }
    if (btn) break;
    // ตรวจว่าติดหน้าล็อกอิน/หน้าอื่นหรือเปล่า
    const url = page.url();
    const body = await page.locator('body').innerText().catch(() => '');
    if (/accounts\.google\.com/.test(url) || /sign in|ลงชื่อเข้าใช้|เข้าสู่ระบบ/i.test(body.slice(0, 600)) && !/โปรเจ็กต์|project/i.test(body)) {
      await page.screenshot({ path: path.join(DATA, 'flow-wait.png') }).catch(() => {});
      throw new Error('Google Flow ให้ล็อกอินอยู่ — ไปที่หน้าต่าง Chrome ของบอท ล็อกอิน Google ให้เรียบร้อย แล้วกด "ลองต่อจากจุดที่ค้าง"');
    }
    log(`ยังไม่เห็นปุ่มสร้างโปรเจ็กต์ (รอบ ${round}/3) — โหลดหน้า Flow ใหม่`);
    await page.screenshot({ path: path.join(DATA, 'flow-wait.png') }).catch(() => {});
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(5000);
  }
  if (!btn) {
    await page.screenshot({ path: path.join(DATA, 'flow-wait.png') }).catch(() => {});
    throw new Error('ไม่เจอปุ่ม "โปรเจ็กต์ใหม่" ในหน้า Flow — ในหน้าต่าง Chrome ของบอท ให้กดสร้างโปรเจ็กต์ใหม่เอง (หรือเปิดโปรเจ็กต์ที่มีอยู่) จนเห็นช่องพิมพ์ prompt แล้วกด "ลองต่อจากจุดที่ค้าง"');
  }
  await btn.click();
  await box.waitFor({ timeout: 40000 }).catch(() => { throw new Error('กดสร้างโปรเจ็กต์แล้ว แต่ไม่เห็นช่องพิมพ์ prompt ใน 40 วินาที — เช็คหน้าต่าง Chrome ของบอท หรือเน็ตช้า แล้วกด "ลองต่อจากจุดที่ค้าง"'); });
}

// กันเจนผิดโหมด (เช่น โปรเจ็กต์ใหม่เริ่มที่โหมดรูปภาพ) จะได้ไม่เสียเครดิตเปล่า
async function ensureVideoMode(page) {
  for (;;) {
    const t = (await page.locator(sel.settingsButton).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (/วิดีโอ|video/i.test(t)) { log(`ตั้งค่าปัจจุบัน: ${t}`); return; }
    log(`ตอนนี้ไม่ใช่โหมดวิดีโอ (${t || 'อ่านค่าไม่ได้'})`);
    if (!process.stdin.isTTY) throw new Error('ยังไม่ใช่โหมดวิดีโอ: ไปตั้งโหมดวิดีโอ/ความละเอียด/สัดส่วน/จำนวนคลิป ในหน้าต่าง Chrome ของบอทก่อน แล้วกดเริ่มใหม่');
    await ask('ไปตั้งโหมดวิดีโอ ความละเอียด สัดส่วน และจำนวนคลิป ในหน้าต่าง Chrome ของบอทให้เรียบร้อย แล้วกด Enter ที่นี่: ');
  }
}

function findChrome() {
  const candidates = [
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

// 'chrome' = Chrome ที่ควบคุมได้ · 'other' = มีโปรแกรมอื่นใช้พอร์ตนี้ · 'free' = ว่าง
async function probePort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return 'other';
    const j = await r.json().catch(() => ({}));
    return j && j.webSocketDebuggerUrl ? 'chrome' : 'other';
  } catch (e) { return /abort|timeout/i.test(String(e && (e.name || e.message))) ? 'other' : 'free'; }
}
async function chromeIsUp() { return (await probePort(PORT)) === 'chrome'; }

async function ensureChrome() {
  if (await chromeIsUp()) return;
  if ((await probePort(PORT)) === 'other') { // พอร์ตถูกโปรแกรมอื่นจองไว้ → หาพอร์ตว่างใหม่
    const old = PORT;
    for (const p of [9333, 9334, 9335, 9444, 9555, 9666, 9777, 9888]) {
      const st = await probePort(p);
      if (st === 'chrome' || st === 'free') { PORT = p; break; }
    }
    if (PORT === old) throw new Error(`พอร์ต ${old} ถูกโปรแกรมอื่นในเครื่องใช้อยู่ และหาพอร์ตว่างไม่ได้ ลองรีสตาร์ตเครื่องแล้วเปิด FlowBot ใหม่`);
    try { fs.writeFileSync(PORT_FILE, String(PORT)); } catch { /* เขียนไม่ได้ก็ใช้รอบนี้ไปก่อน */ }
    log(`พอร์ต ${old} ถูกโปรแกรมอื่นใช้อยู่ ย้าย Chrome ของบอทไปใช้พอร์ต ${PORT}`);
    if (await chromeIsUp()) return;
  }
  const exe = findChrome();
  if (!exe) throw new Error('หา Chrome ไม่เจอ ติดตั้ง Google Chrome ก่อน');
  spawn(exe, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // กัน Chrome หยุดวาดหน้าเว็บเมื่อหน้าต่างถูกบัง/ย่อ (เว็บ AI จะไม่แสดงคำตอบจนกว่าจะเปิดดู → บอทอ่านได้ 0 ตัวอักษรแล้วหมดเวลา)
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    sel.url,
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) {
    if (await chromeIsUp()) return;
    await sleep(1000);
  }
  throw new Error('เปิด Chrome ไม่สำเร็จ');
}

// นับการ์ดที่เจนเสร็จแล้ว: ใช้ค่าที่มากกว่าระหว่างจำนวนวิดีโอ (videoTile) กับแถบ prompt ใต้การ์ด (doneTile)
// เพราะบางครั้งการ์ดโผล่แล้วแต่ Flow ยังโหลดวิดีโอไม่เสร็จ
async function doneCount(page) {
  const v = await page.locator(sel.videoTile).count();
  const f = sel.doneTile ? await page.locator(sel.doneTile).count() : 0;
  return Math.max(v, f);
}

// ตัดสินผลจาก: ตัวเลข % ระหว่างเจน (progressIndicator) และจำนวนวิดีโอที่เพิ่มขึ้น (videoTile)
// เสร็จ = % หายไป และวิดีโอเพิ่มครบตามจำนวนที่ตั้งไว้ (x1-x4)
async function waitResult(page, before, expected) {
  const deadline = Date.now() + cfg.segmentTimeoutMs;
  const started = Date.now();
  let sawProgress = false;
  let lastSeen = Date.now();
  while (Date.now() < deadline) {
    const progress = await page.locator(sel.progressIndicator).count();
    const gained = (await doneCount(page)) - before;
    if (progress > 0) { sawProgress = true; lastSeen = Date.now(); }
    if (gained >= expected) return 'done'; // วิดีโอเพิ่มครบแล้ว ถือว่าเสร็จ ไม่ต้องรอให้ % หาย
    if (sawProgress && progress === 0 && Date.now() - lastSeen > 45000) {
      // เคยเห็น % แต่หายไปเกิน 20 วิแล้ว วิดีโอก็ยังไม่ครบ
      return gained > 0 ? `partial(${gained}/${expected})` : 'failed';
    }
    // ไม่เคยเห็น % เลย (อาจรอคิวนาน) ให้รอนานขึ้นก่อนค่อยตัดสินว่าล้มเหลว
    if (!sawProgress && Date.now() - started > (cfg.noProgressTimeoutMs || 240000)) return 'failed';
    await sleep(3000);
  }
  return 'timeout';
}

// ---------- อ่านคำตอบล่าสุดของ AI จากหน้าเว็บ ----------
const AI_HOST = /claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com/;
async function readLastAnswer(pg, mode) {
  return pg.evaluate((mode) => {
    const host = location.host;
    const userSel = '[data-testid="user-message"], [data-message-author-role="user"], user-query, .user-query-bubble-with-background';
    const users = [...document.querySelectorAll(userSel)];
    const lastUser = users[users.length - 1];
    const out = [];
    let started = !lastUser;
    const SKIP = /^(button|svg|style|script|textarea|form|nav|aside|input|noscript)$/;
    const walk = n => {
      if (!started) {
        if (n === lastUser) { started = true; return; }          // เริ่มเก็บหลังข้อความล่าสุดของผู้ใช้
        if (n.nodeType === 1 && n.contains(lastUser)) { n.childNodes.forEach(walk); }
        return;
      }
      if (n.nodeType === 3) { out.push(n.textContent); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (SKIP.test(tag)) return;
      if (tag === 'pre') { const c = n.querySelector('code') || n; out.push('\n```\n' + c.innerText.replace(/\n+$/, '') + '\n```\n'); return; }
      const block = /^(p|div|li|h[1-6]|ul|ol|section|br|tr)$/.test(tag);
      n.childNodes.forEach(walk);
      if (block) out.push('\n');
    };
    if (lastUser && mode !== 'assistant') {
      walk(document.querySelector('main') || document.body);
    } else {
      // ไม่พบข้อความผู้ใช้ ใช้คำตอบล่าสุดตามชนิดเว็บแทน
      let msgs = [];
      if (host.includes('claude.ai')) msgs = [...document.querySelectorAll('.font-claude-response, [data-testid="assistant-message"]')];
      else if (/chatgpt|openai/.test(host)) msgs = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      else if (host.includes('gemini')) msgs = [...document.querySelectorAll('message-content, .model-response-text')];
      if (!msgs.length) msgs = [...document.querySelectorAll('article, [role=article]')];
      const last = msgs[msgs.length - 1];
      if (last) { started = true; walk(last); }
    }
    return out.join('');
  }, mode);
}
// คะแนนว่าข้อความนี้ "หน้าตาเหมือนชุด prompt" แค่ไหน: จำนวนกล่องโค้ดที่มีคำเฉพาะของ prompt (กันอ่านผิดแท็บ/ผิดส่วนของหน้า เช่น แผงโค้ด)
function planScore(t) {
  const blocks = String(t || '').match(/```[^\n]*\n[\s\S]*?```/g) || [];
  let n = blocks.filter(b => /(^|\n)\s*(SHOT|STYLE|VOICE)\s*:|\[\s*(รูป|วิดีโอ|ภาพ|image|video)|character sheet|start frame/i.test(b)).length;
  if (!n && /(^|\n)\s*\[\s*(รูป|วิดีโอ)[^\]]*\]/m.test(t)) n = 1;
  return n;
}
// คำตอบทุกข้อของแชต (แยกตามข้อความผู้ใช้) ใช้กรณีคำตอบล่าสุดเป็นแค่ข้อความสั้น/คำตอบแก้ไข แต่ชุด prompt เต็มอยู่ก่อนหน้า
async function readAnswerHistory(pg) {
  return pg.evaluate(() => {
    const userSel = '[data-testid="user-message"], [data-message-author-role="user"], user-query, .user-query-bubble-with-background';
    const users = new Set([...document.querySelectorAll(userSel)]);
    if (!users.size) return [];
    const segs = []; let cur = null;
    const SKIP = /^(button|svg|style|script|textarea|form|nav|aside|input|noscript)$/;
    const walk = n => {
      if (users.has(n)) { cur = []; segs.push(cur); return; }
      if (n.nodeType === 3) { if (cur) cur.push(n.textContent); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (SKIP.test(tag)) return;
      if (tag === 'pre') { if (cur) { const c = n.querySelector('code') || n; cur.push('\n```\n' + c.innerText.replace(/\n+$/, '') + '\n```\n'); } return; }
      const block = /^(p|div|li|h[1-6]|ul|ol|section|br|tr)$/.test(tag);
      n.childNodes.forEach(walk);
      if (block && cur) cur.push('\n');
    };
    walk(document.querySelector('main') || document.body);
    return segs.map(s => s.join('')).slice(-8);
  }).catch(() => []);
}
// สำรอง: ถ้าอ่านจาก DOM ไม่ได้ ให้กดปุ่ม Copy ใต้คำตอบล่าสุดของเว็บ AI แล้วอ่านจากคลิปบอร์ด (ได้ markdown พร้อมกล่องโค้ดครบ)
async function readViaCopy(pg) {
  if (process.platform !== 'win32') return '';
  const sels = ['button[data-testid="copy-turn-action-button"]', 'button[data-testid="action-bar-copy"]', 'button[aria-label="Copy" i]', 'button[aria-label*="Copy" i]', 'button[aria-label*="คัดลอก"]', 'button[mattooltip*="Copy" i]', 'button[data-test-id="copy-button"]'];
  for (const s of sels) {
    try {
      const loc = pg.locator(s); if (!(await loc.count())) continue;
      await loc.last().scrollIntoViewIfNeeded().catch(() => {});
      await loc.last().click({ force: true, timeout: 4000 });
      await sleep(900);
      const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'], { encoding: 'utf8', timeout: 6000 });
      if (out && out.trim().length > 50) return out;
    } catch { /* ลองตัวถัดไป */ }
  }
  return '';
}
async function pageProbe(pg) {
  return pg.evaluate(() => {
    const c = s => document.querySelectorAll(s).length;
    return { host: location.host, title: document.title, users: c('[data-testid="user-message"], [data-message-author-role="user"], user-query'), assistants: c('[data-message-author-role="assistant"], .font-claude-response, message-content, .model-response-text'), pre: c('pre'), articles: c('article, [role=article]'), turns: c('[data-testid^="conversation-turn"]'), main: !!document.querySelector('main'), textLen: (document.body.innerText || '').length };
  }).catch(e => ({ error: String(e.message || e) }));
}
// อ่านทุกแท็บ AI ด้วยสองวิธี แล้วเลือกอันที่เหมือนชุด prompt ที่สุด (เท่ากัน = แท็บล่าสุดที่เปิด/อ่านวิธีแรกก่อน)
async function readBestAnswer(pages) {
  let best = null;
  for (let i = 0; i < pages.length; i++) {
    const host = new URL(pages[i].url()).host;
    const cands = (await readAnswerHistory(pages[i])).map(t => ({ text: t, sc: planScore(t), old: true })); // เก่า → ใหม่
    for (const mode of ['turn', 'assistant']) {
      const text = await readLastAnswer(pages[i], mode).catch(() => '');
      cands.push({ text, sc: planScore(text) });
    }
    // เอาคำตอบล่าสุดที่เป็นชุด prompt เต็ม (>=2 กล่อง) ถ้าไม่มีเลย เอาคะแนนสูงสุด (เท่ากันเอาอันหลัง)
    let pick = null;
    for (let k = cands.length - 1; k >= 0; k--) if (cands[k].sc >= 2) { pick = cands[k]; break; }
    if (!pick) pick = cands.reduce((x, y) => (y.sc >= x.sc ? y : x), cands[0]);
    if (!best || pick.sc > best.sc) best = { text: pick.text, sc: pick.sc, i, mode: pick.old ? 'history' : 'turn', host };
  }
  return best;
}

// เว็บ AI ที่รองรับแบบอัตโนมัติ (เปิดแชตใหม่ → พิมพ์ → ส่ง → รอ → อ่านคำตอบ)
const AI_SITES = {
  claude: { name: 'Claude', url: 'https://claude.ai/new', host: /claude\.ai/, input: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"]', stop: 'button[aria-label*="Stop" i], button[aria-label*="หยุด"]', send: 'button[aria-label*="Send" i], button[aria-label*="ส่ง"]' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', host: /chatgpt\.com|chat\.openai\.com/, input: '#prompt-textarea, div[contenteditable="true"]', stop: 'button[data-testid="stop-button"], button[aria-label*="Stop" i]', send: 'button[data-testid="send-button"], button[aria-label*="Send" i]' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app', host: /gemini\.google\.com/, input: 'rich-textarea div.ql-editor, div.ql-editor[contenteditable="true"], div[contenteditable="true"]', stop: 'button[aria-label*="Stop" i], button[aria-label*="หยุด"]', send: 'button[aria-label*="Send" i], button[aria-label*="ส่ง"]' },
};
async function askAI(context, key, message, expect, files, here) {
  const site = AI_SITES[key]; if (!site) throw new Error('ไม่รู้จัก AI: ' + key);
  const cands = context.pages().filter(p => site.host.test(p.url()));
  let pg = cands[0];
  if (here) { // ใช้แชตที่เปิดอยู่ (เช่นแชตใน Project ของลูกค้า) ไม่เปิดแชตใหม่ — เลือกแท็บที่เห็นอยู่ ถ้าไม่มีเลือกแท็บล่าสุด
    if (!cands.length) throw new Error(`ไม่พบแท็บ ${site.name} ใน Chrome ของบอท — เปิดแชต/Project ที่ต้องการในหน้าต่าง Chrome ของบอทก่อน`);
    for (const p of cands) { if (await p.evaluate(() => document.visibilityState === 'visible').catch(() => false)) { pg = p; break; } }
    if (pg === cands[0]) pg = cands[cands.length - 1];
  }
  if (!pg) pg = await context.newPage();
  await pg.bringToFront().catch(() => {});
  try { const cs = await pg.context().newCDPSession(pg); await cs.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* ไม่เป็นไร */ } // ให้หน้าเว็บ AI ทำงานเหมือนอยู่หน้าสุดเสมอ
  // ให้เว็บ AI คิดว่าหน้าต่างมองเห็นอยู่เสมอ (ถ้าหน้าต่างถูกบัง/ย่อ บางเว็บหยุดวาดคำตอบ → บอทอ่านได้ 0 ตัวอักษร)
  const KEEP_VISIBLE = `(()=>{try{Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});document.hasFocus=()=>true;const stop=e=>e.stopImmediatePropagation();window.addEventListener('visibilitychange',stop,true);document.addEventListener('visibilitychange',stop,true);}catch(e){}})();`;
  await pg.addInitScript({ content: KEEP_VISIBLE }).catch(() => {});
  await pg.evaluate(KEEP_VISIBLE).catch(() => {});
  if (here) log(`ใช้แชตที่เปิดอยู่ใน ${site.name}: ${(await pg.title().catch(() => '')).slice(0, 60)}`);
  else {
    log(`เปิดแชตใหม่ใน ${site.name}...`);
    await pg.goto(site.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  const input = pg.locator(site.input).first();
  try { await input.waitFor({ state: 'visible', timeout: 30000 }); }
  catch { throw new Error(`ยังไม่ได้ล็อกอิน ${site.name} (หรือหน้าเว็บเปลี่ยน) กดปุ่มล็อกอินในหน้าแรก แล้วลองใหม่`); }
  await sleep(1500);
  if (files && files.length) { // แนบรูปเข้าแชต (Claude / ChatGPT มี input[type=file] ซ่อนอยู่)
    const fi = pg.locator('input[type=file]').first();
    if (!(await fi.count().catch(() => 0))) throw new Error(`${site.name} แนบไฟล์อัตโนมัติไม่ได้`);
    await fi.setInputFiles(files);
    await sleep(4000);
  }
  await pg.keyboard.press('Escape').catch(() => {}); await sleep(300); // ปิดป๊อปอัป/แบนเนอร์ที่อาจบังช่องพิมพ์
  try { await input.click({ timeout: 8000 }); }
  catch (e1) {
    await pg.screenshot({ path: path.join(DATA, 'ask-fail.png') }).catch(() => {});
    try { await input.click({ force: true, timeout: 5000 }); }
    catch { await input.focus({ timeout: 5000 }).catch(() => { throw e1; }); }
  }
  await pg.keyboard.insertText(message);
  await sleep(1200);
  await pg.keyboard.press('Enter');
  await sleep(2500);
  // ถ้ายังอยู่ในช่องพิมพ์ แปลว่า Enter ไม่ได้ส่ง ลองกดปุ่มส่ง
  const left = (await input.innerText().catch(() => '')).trim().length;
  if (left > 40) {
    const sb = pg.locator(site.send).last();
    if (await sb.isVisible().catch(() => false)) { await sb.click().catch(() => {}); await sleep(2000); }
  }
  log(`ส่งคำสั่งให้ ${site.name} แล้ว รอคำตอบ...`);
  const t0 = Date.now(); let last = '', stableSince = Date.now(), lastCopyTry = 0, lastDiag = 0;
  while (Date.now() - t0 < 8 * 60 * 1000) {
    await sleep(3000);
    let text = await readLastAnswer(pg).catch(() => '');
    if (!text.trim()) text = await readLastAnswer(pg, 'assistant').catch(() => '');
    if (!text.trim()) { const h = await readAnswerHistory(pg); text = (h[h.length - 1] || ''); }
    if (!text.trim() && Date.now() - t0 > 20000) { // ทางสุดท้าย: เก็บทุกกล่องโค้ด (pre) ในหน้า — เผื่อเว็บ AI เปลี่ยนโครงสร้างจนหาข้อความล่าสุดไม่เจอ
      text = await pg.evaluate(() => [...document.querySelectorAll('pre')].map(p => (p.querySelector('code') || p).innerText.replace(/\n+$/, '')).filter(t => t.trim().length > 20).map(t => '\n```\n' + t + '\n```\n').join('')).catch(() => '');
    }
    if (!text.trim() && Date.now() - t0 > 25000 && Date.now() - lastCopyTry > 15000) { // อ่านจากหน้าเว็บไม่ได้เลย → กดปุ่ม Copy ของเว็บ AI
      lastCopyTry = Date.now();
      if (!(await pg.locator(site.stop).first().isVisible().catch(() => false))) text = await readViaCopy(pg);
    }
    if (!text.trim() && last.trim()) text = last; // อ่านได้แล้วเกิดอ่านว่างชั่วคราว (หน้าเว็บวาดใหม่) ให้ถือว่าข้อความเดิมยังอยู่ ไม่รีเซ็ตตัวนับ
    if (Date.now() - lastDiag > 20000) { // บอกสถานะการรอทุก 20 วินาที เพื่อให้รู้ว่าค้างตรงไหน
      lastDiag = Date.now();
      const stopV = await pg.locator(site.stop).first().isVisible().catch(() => false);
      log(`รอคำตอบจาก ${site.name}: อ่านได้ ${text.length} ตัวอักษร · กล่องโค้ด ${Math.floor((text.match(/```/g) || []).length / 2)} · ปุ่มหยุด${stopV ? 'แสดงอยู่ (AI ยังตอบอยู่)' : 'ไม่แสดง'} · ผ่านไป ${Math.round((Date.now() - t0) / 1000)} วิ`);
      if (Date.now() - t0 > 40000 && !text.trim()) await pg.bringToFront().catch(() => {}); // แท็บอยู่เบื้องหลัง เว็บ AI อาจหยุดวาดคำตอบ → ดึงขึ้นหน้า
      if (Date.now() - t0 > 60000 && !text.trim()) {
        await pg.screenshot({ path: path.join(DATA, 'ask-wait.png') }).catch(() => {});
        try { // เก็บข้อมูลโครงสร้างหน้าเว็บ ไว้ให้ผู้พัฒนาดูว่าทำไมอ่านคำตอบไม่ได้
          const dbg = await pg.evaluate(() => {
            const cnt = s => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
            const tags = {}; document.querySelectorAll('*').forEach(e => { if (e.tagName.includes('-')) tags[e.tagName.toLowerCase()] = (tags[e.tagName.toLowerCase()] || 0) + 1; });
            return { url: location.href, realVis: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get.call(document), main: cnt('main'), pre: cnt('pre'), codeBlock: cnt('code-block'), msgContent: cnt('message-content'), modelResp: cnt('.model-response-text'), userQuery: cnt('user-query'), tags, bodyLen: document.body.innerText.length };
          });
          fs.writeFileSync(path.join(DATA, 'ask-debug.json'), JSON.stringify(dbg, null, 1), 'utf8');
        } catch { /* ข้าม */ }
      }
    }
    if (text !== last) { last = text; stableSince = Date.now(); continue; }
    const blocks = (text.match(/```/g) || []).length / 2;
    const stopping = await pg.locator(site.stop).first().isVisible().catch(() => false);
    const quiet = Date.now() - stableSince;
    const openFence = ((text.match(/```/g) || []).length % 2) === 1; // กล่องโค้ดยังไม่ปิด = คำตอบยังไม่จบ/อ่านได้ครึ่งเดียว
    if (openFence && quiet < 45000) continue;
    if (text.trim().length > 50 && !stopping && ((expect && blocks >= expect && quiet > 6000) || (blocks >= 1 && quiet > 8000) || quiet > 60000)) return text;
  }
  if (last.trim()) return last;
  throw new Error(`${site.name} ไม่ตอบภายใน 8 นาที`);
}


// ---------- ตรวจคุณภาพคลิปหลังสร้าง (ไม่ใช้ API) ----------
// เปิดคลิปใน Flow → แคปแถบภาพตัวอย่างตลอดคลิป (timeline) → ตรวจแบบตัวเลข (นิ่ง/มืด/ตัดฉาก/ท้ายนิ่ง) → (ถ้าเลือก) ให้ AI ในแชตของผู้ใช้ดูภาพแถบนั้น
async function openClipByIndex(page, index) {
  const h = await page.evaluateHandle((index) => {
    const all = [...document.querySelectorAll('div,button,a')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 20 && /^play_circle/.test((e.innerText || '').trim()); });
    const icons = all.filter(e => !all.some(o => o !== e && e.contains(o)));
    const icon = icons[index]; if (!icon) return null;
    const ir = icon.getBoundingClientRect();
    return [...document.querySelectorAll('img')].find(i => { const r = i.getBoundingClientRect(); return r.width > 80 && Math.abs(r.x - ir.x) < 8 && Math.abs(r.y - ir.y) < 8; }) || icon;
  }, index);
  const el = h.asElement(); if (!el) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 8000 });
  return true;
}
// แถวภาพตัวอย่างใต้ตัวเล่น: รูปขนาดเท่ากันหลายใบอยู่แถวเดียวกัน (ไม่พึ่งข้อความ/ภาษา)
async function filmstripThumbs(page) {
  return page.evaluateHandle(() => {
    const rows = {};
    [...document.querySelectorAll('img')].forEach(i => { const r = i.getBoundingClientRect(); if (r.width < 40 || r.width > 220 || r.height < 24 || r.height > 160 || r.y < innerHeight * 0.35) return; const k = Math.round(r.y / 4) + ':' + Math.round(r.height / 4); (rows[k] = rows[k] || []).push(i); });
    const best = Object.values(rows).sort((a, b) => b.length - a.length)[0] || [];
    return best.length >= 4 ? best.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x) : [];
  });
}
// วิเคราะห์เฟรม (ส่ง PNG base64 เข้าไปคำนวณในเบราว์เซอร์): คืน { n, bright[], diffs[] }
async function analyzeFrames(page, b64s) {
  return page.evaluate(async (list) => {
    const W = 36, H = 64, data = [];
    for (const b of list) {
      const img = new Image(); img.src = 'data:image/png;base64,' + b; await img.decode();
      const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
      data.push(g.getImageData(0, 0, W, H).data);
    }
    const bright = data.map(d => { let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return Math.round(s / (d.length / 4)); });
    const diffs = [];
    for (let k = 1; k < data.length; k++) { let s = 0; const a = data[k - 1], b = data[k]; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); diffs.push(Math.round(s / (a.length / 4 * 3) * 10) / 10); }
    return { n: data.length, bright, diffs };
  }, b64s);
}
// เกณฑ์ตัวเลข → รายการธง (ภาษาไทยให้ลูกค้าอ่านเข้าใจ)
function qcFlags(m) {
  const flags = [];
  if (m.n < 4) return { flags, note: 'ภาพตัวอย่างน้อยเกินไป ตรวจไม่ได้' };
  const med = [...m.diffs].sort((a, b) => a - b)[Math.floor(m.diffs.length / 2)] || 0;
  const maxD = Math.max(...m.diffs);
  if (m.bright.filter(b => b < 14).length >= Math.ceil(m.n / 2)) flags.push('ภาพมืด/ดำเกือบทั้งคลิป');
  else if (m.bright.some(b => b < 8)) flags.push('มีช่วงภาพดำ');
  if (maxD < 2.2) flags.push('ภาพแทบไม่ขยับ (นิ่งทั้งคลิป)');
  else {
    if (maxD > Math.max(38, med * 5)) flags.push('ภาพกระโดด/ตัดฉากกะทันหัน');
    const tail = m.diffs.slice(Math.floor(m.diffs.length * 0.6));
    const head = m.diffs.slice(0, Math.floor(m.diffs.length * 0.6));
    if (tail.length >= 3 && Math.max(...tail) < 1.5 && Math.max(...head) > 4) flags.push('ช่วงท้ายคลิปนิ่ง');
  }
  return { flags };
}
function sheetFileName(n) { return path.join(DATA, 'qc', `seg${n}.png`); }
// หัวใจ: ตรวจคลิปใหม่ล่าสุด (index 0) คืน { ok, flags[], ai, file }
async function qcClip(page, ctx) {
  const out = { ok: true, flags: [], ai: null, file: '', n: 0 };
  const projUrl = page.url();
  try {
    if (!(await openClipByIndex(page, ctx.index || 0))) { out.note = 'หาคลิปที่จะตรวจไม่เจอ'; return out; }
    const getThumbs = async () => { const hs = await filmstripThumbs(page); const props = await hs.getProperties(); return [...props.values()].map(v => v.asElement()).filter(Boolean); };
    let thumbs = [];
    for (let t = 0; t < 12 && thumbs.length < 4; t++) { await sleep(1500); thumbs = await getThumbs(); }
    if (thumbs.length < 4) { out.note = 'ไม่พบแถบภาพตัวอย่างของคลิป'; return out; }
    await sleep(2500); // ให้รูปในแถบโหลดครบ (Flow วาดแถบใหม่ได้ระหว่างโหลด → ถ้าองค์ประกอบหลุดให้หาใหม่แล้วแคปซ้ำ)
    let b64s = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      try { thumbs = await getThumbs(); if (thumbs.length < 4) throw new Error('แถบภาพยังไม่ครบ'); b64s = []; for (const th of thumbs) b64s.push((await th.screenshot({ type: 'png', timeout: 8000 })).toString('base64')); break; }
      catch (e) { if (attempt === 3) throw e; await sleep(2000); }
    }
    const m = await analyzeFrames(page, b64s);
    const r = qcFlags(m); out.flags = r.flags; out.n = m.n; out.metrics = { bright: m.bright, diffs: m.diffs };
    if (r.note) out.note = r.note;
    // เก็บภาพแถบทั้งแถวไว้ (ให้ AI ดู / ให้ผู้ใช้เปิดดูได้)
    const boxes = []; for (const th of thumbs) boxes.push(await th.boundingBox());
    const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y)), x1 = Math.max(...boxes.map(b => b.x + b.width)), y1 = Math.max(...boxes.map(b => b.y + b.height));
    fs.mkdirSync(path.join(DATA, 'qc'), { recursive: true });
    const file = sheetFileName(ctx.seg || 0);
    await page.screenshot({ path: file, clip: { x: Math.max(0, x0), y: Math.max(0, y0), width: x1 - x0, height: y1 - y0 } });
    out.file = file;
  } catch (e) { out.note = 'ตรวจไม่สำเร็จ: ' + e.message; }
  finally {
    // กลับหน้าโปรเจ็กต์ให้ท่อนถัดไปทำงานต่อได้
    await page.goBack({ timeout: 8000 }).catch(() => {});
    const box = page.locator(sel.promptBox).first();
    if (!(await box.waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false))) {
      await page.goto(projUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await box.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
    }
  }
  out.ok = out.flags.length === 0;
  return out;
}
// ให้ AI ในแชตของผู้ใช้ดูภาพแถบเฟรม (+ รูปตัวละครถ้ามี) แล้วตอบ PASS/FAIL · คืน { verdict:'PASS'|'FAIL'|null, why }
async function aiJudge(context, key, file, refFile, segText) {
  if (!file || !['claude', 'chatgpt'].includes(key)) return { verdict: null, why: key === 'gemini' ? 'Gemini ยังแนบรูปอัตโนมัติไม่ได้' : '' };
  const brief = String(segText || '').replace(/\s+/g, ' ').slice(0, 900);
  const msg = `ภาพแรกคือแถบเฟรมของคลิปวิดีโอการ์ตูน 3D ยาว 10 วินาที เรียงจากซ้ายไปขวา (ต้นคลิป → ท้ายคลิป)` + (refFile ? ` ภาพที่สองคือตัวละครต้นฉบับ` : '') + `\nคำสั่งที่ใช้สร้างคลิป (ย่อ): ${brief}\n\nช่วยตรวจ: 1) ตัวละครหน้าตา/ชุดเหมือนเดิมทุกเฟรม${refFile ? ' และตรงกับตัวต้นฉบับ' : ''}ไหม 2) กล้องเคลื่อนที่เรียบ ไม่มีภาพกระโดดหรือบิดเบี้ยวไหม 3) มีของแปลก/มือเกิน/ตัวอักษรบนภาพไหม 4) ภาพตรงกับคำสั่งไหม\nตอบบรรทัดแรกเป็นคำเดียว PASS หรือ FAIL แล้วบรรทัดถัดไปเหตุผลสั้นๆ ภาษาไทยไม่เกิน 2 ประโยค`;
  const text = await askAI(context, key, msg, 0, refFile ? [file, refFile] : [file]);
  const m = String(text).match(/(^|\n)\s*(PASS|FAIL)\b[:：\s\-–—]*([^\n]*(?:\n(?!\s*$)[^\n]*)?)/i);
  return m ? { verdict: m[2].toUpperCase(), why: (m[3] || '').replace(/\s+/g, ' ').trim().slice(0, 240) } : { verdict: null, why: 'อ่านคำตอบของ AI ไม่ออก' };
}
// ใช้ในสายงานหลัก: ตรวจ 1 คลิป แล้วส่งผลให้หน้าจอ (@@QC)
async function qcAfterVideo(page, x) {
  const context = page.context();
  const q = await qcClip(page, { seg: x.n, index: 0 });
  if (cfg.qc === 'ai' && context) {
    try {
      const refFile = findRefForSeg(x.s);
      const j = await aiJudge(context, cfg.ai || 'claude', q.file, refFile, x.s.text);
      q.ai = j; if (j.verdict === 'FAIL') { q.flags.push('AI ว่าไม่ผ่าน: ' + (j.why || 'ดูภาพแล้วไม่ตรง')); q.ok = false; }
      await page.bringToFront().catch(() => {});
    } catch (e) { q.ai = { verdict: null, why: 'ถาม AI ไม่สำเร็จ: ' + e.message }; await page.bringToFront().catch(() => {}); }
  }
  sendEv('QC', JSON.stringify({ seg: x.n, ok: q.ok, flags: q.flags, ai: q.ai, note: q.note || '' }));
  log(`ตรวจคลิป Segment ${x.n}: ${q.ok ? 'ปกติ ✓' : 'น่าสงสัย — ' + q.flags.join(', ')}${q.note ? ' (' + q.note + ')' : ''}`);
  return q;
}
// รูปตัวละครที่ท่อนนี้แนบ (ถ้ามีไฟล์ในโฟลเดอร์ images) ให้ AI เทียบ
function findRefForSeg(seg) {
  for (const n of (seg.images || [])) { const f = findImage(resolveName(n)); if (f) return path.join(IMG_DIR, f); }
  return '';
}

// ---------- ขั้นตอนหลัก: เจนรูปคีย์เฟรม (มีตรวจ/เจนใหม่แบบลูกโซ่) → เจนวิดีโอ ----------
const IMPL = { image: (...a) => runImageStep(...a), video: (...a) => runVideoStep(...a), why: (...a) => failReason(...a), qc: (...a) => (process.env.FLOWBOT_SIM ? null : qcAfterVideo(...a)) }; // เปลี่ยนได้ตอนทดสอบ (FLOWBOT_SIM)
async function runPipeline(page, segments) {
  const review = process.env.FLOWBOT_REVIEW !== '0';
  const resume = process.env.FLOWBOT_RESUME === '1';
  if (resume) loadState();
  else {
    let keep = {};
    if (process.env.FLOWBOT_KEEP === '1') { // ทำช่วงต่อไปของเรื่องเดิม: จำชื่อรูปจากช่วงก่อน (เช่น Character Sheet) แต่ให้เจนรูปของช่วงนี้ใหม่
      loadState(); keep = state.imgs; Object.keys(keep).forEach(k => { keep[k] = { ...keep[k], done: false, ver: 0 }; });
      // ชื่อที่ยังหาเจอในไลบรารีได้ต้องเป็นชื่อเดิม: ใช้ base เดิมต่อ จนกว่าช่วงนี้จะเจนรูปชื่อเดียวกันใหม่
      Object.keys(keep).forEach(k => { keep[k].prev = keep[k].base; });
    }
    state = { tag: Math.random().toString(36).slice(2, 6), imgs: keep, vids: {} }; saveState();
  }
  const imgs = [], vids = [];
  segments.forEach((s, i) => (s.kind === 'image' ? imgs : vids).push({ s, n: i + 1 }));
  const nameOf = x => x.s.name || ('K' + (x.n - 1));
  imgs.forEach(x => { x.s.name = nameOf(x); });
  sendEv('PLAN', JSON.stringify({ images: imgs.map(x => ({ seg: x.n, name: x.s.name })), videos: vids.map(x => ({ seg: x.n })), review }));
  log(`FlowBot เวอร์ชัน 4.1 · รูป ${imgs.length} ใบ → วิดีโอ ${vids.length} คลิป${review ? ' (หยุดให้ตรวจรูป)' : ' (ทำต่อเนื่อง)'}`);

  const genAt = {}, startedAt = Date.now();
  let seenSeq = (readControl().cmd || {}).seq || 0;
  const stop = async (n, why) => {
    const shot = path.join(DATA, `fail-seg${n}.png`); await page.screenshot({ path: shot }).catch(() => {});
    log(`หยุดทำงาน: Segment ${n} ไม่สำเร็จ${why ? ' — ' + why : ''}`);
    sendEv('STOP', JSON.stringify({ seg: n, why: String(why || '').slice(0, 300) }));
  };
  const flaggedDone = () => {
    const ft = readControl().flagTimes || {};
    const out = [];
    imgs.forEach((x, idx) => { const st = state.imgs[keyOf(x.s.name)]; if (st && st.done && ft[x.s.name] && ft[x.s.name] > Math.max(startedAt, genAt[keyOf(x.s.name)] || 0)) out.push(idx); });
    return out;
  };
  // เจนใหม่เฉพาะรูปที่แตะ + รูปที่แนบรูปนั้น (ต่อกันเป็นลูกโซ่) — รูปที่ไม่เกี่ยวกันไม่ต้องเจนใหม่
  const rewind = flagged => {
    const redo = new Set(flagged);
    imgs.forEach((x, j) => { if (!redo.has(j) && (x.s.images || []).some(n => [...redo].some(r => keyOf(imgs[r].s.name) === keyOf(n)))) redo.add(j); });
    for (const j of [...redo].sort((a, b) => a - b)) {
      const st = state.imgs[keyOf(imgs[j].s.name)];
      if (st && st.done) { st.done = false; sendEv('IMG', JSON.stringify({ seg: imgs[j].n, name: imgs[j].s.name, status: 'pending' })); }
    }
    saveState();
    log(`เจนใหม่: ${[...redo].sort((a, b) => a - b).map(j => imgs[j].s.name).join(', ')} (รวมรูปที่ต่อจากรูปที่แตะ)`);
  };

  sendEv('PHASE', 'images');
  for (;;) {
    let i = 0;
    while (i < imgs.length) {
      const fl = flaggedDone();
      if (fl.length) { rewind(fl); i = Math.min(...fl); }
      const x = imgs[i], k = keyOf(x.s.name);
      const cur = state.imgs[k];
      if (cur && cur.done) { sendEv('IMG', JSON.stringify({ seg: x.n, name: x.s.name, status: 'done', file: cur.file })); i++; continue; }
      const ver = ((cur && cur.ver) || 0) + 1;
      const vname = `${x.s.name}-${state.tag}` + (ver > 1 ? `-v${ver}` : '');
      sendEv('IMG', JSON.stringify({ seg: x.n, name: x.s.name, status: 'gen' }));
      log(`Segment ${x.n}: เจนรูป ${x.s.name}${ver > 1 ? ` (ครั้งที่ ${ver})` : ''}`);
      let r;
      try { r = await IMPL.image(page, x.s, x.n, vname); }
      catch (e) { await stop(x.n, e.message); return 'stopped'; }
      if (r.status !== 'done') { await stop(x.n, (await IMPL.why(page)) || r.status); return 'stopped'; }
      state.imgs[k] = { ver, base: vname, file: r.file, done: true };
      genAt[k] = Date.now(); saveState();
      sendEv('IMG', JSON.stringify({ seg: x.n, name: x.s.name, status: 'done', file: r.file }));
      i++;
      await sleep(cfg.delayBetweenMs);
    }
    if (flaggedDone().length) continue;      // มีคนแตะรูปตอนรูปสุดท้ายเพิ่งเสร็จ
    if (!review) break;
    sendEv('PHASE', 'review');
    log('วาดรูปครบแล้ว รอตรวจรูป (แตะรูปที่ไม่ชอบ แล้วกดวาดใหม่ หรือกดทำวิดีโอต่อ)');
    let approved = false;
    while (!approved) {
      await sleep(1200);
      const c = readControl(); const cmd = c.cmd || {};
      if (cmd.seq > seenSeq) {
        seenSeq = cmd.seq;
        if (cmd.type === 'approve') approved = true;
        else if (cmd.type === 'redo' && flaggedDone().length) { sendEv('PHASE', 'images'); break; }
      }
    }
    if (approved) break;
  }

  sendEv('PHASE', 'videos');
  for (const x of vids) {
    if (state.vids[x.n] === 'done') { sendEv('VID', JSON.stringify({ seg: x.n, status: 'done' })); continue; }
    sendEv('VID', JSON.stringify({ seg: x.n, status: 'gen' }));
    log(`Segment ${x.n}: เจนวิดีโอ${x.s.start ? ` (${x.s.start} → ${x.s.end})` : ''}`);
    let st;
    try { st = await IMPL.video(page, x.s, x.n); }
    catch (e) { await stop(x.n, e.message); return 'stopped'; }
    if (st !== 'done') { await stop(x.n, (await IMPL.why(page)) || st); return 'stopped'; }
    state.vids[x.n] = 'done'; saveState();
    sendEv('VID', JSON.stringify({ seg: x.n, status: 'done' }));
    if (cfg.qc && cfg.qc !== 'off') { // ตรวจคลิปที่เพิ่งได้ (ตัวเลข / ให้ AI ดู) ผิดพลาดตรงนี้ไม่กระทบงานหลัก
      let q = null;
      try { q = await IMPL.qc(page, x); } catch (e) { log('ข้ามการตรวจคลิป: ' + e.message); }
      if (q && !q.ok && cfg.qcRedo && !x.redone) { // เจนใหม่ 1 ครั้ง (เสียเครดิตเพิ่ม) เฉพาะเมื่อผู้ใช้เปิดไว้
        x.redone = true; log(`Segment ${x.n}: ตรวจแล้วน่าสงสัย → เจนใหม่ 1 ครั้ง`);
        sendEv('VID', JSON.stringify({ seg: x.n, status: 'gen' }));
        let st2 = 'failed'; try { st2 = await IMPL.video(page, x.s, x.n); } catch (e) { log('เจนใหม่ไม่สำเร็จ: ' + e.message); }
        sendEv('VID', JSON.stringify({ seg: x.n, status: 'done' }));
        if (st2 === 'done') { try { await IMPL.qc(page, x); } catch { /* ข้าม */ } }
      }
    }
    await sleep(cfg.delayBetweenMs);
  }
  sendEv('PHASE', 'done');
  log('สำเร็จครบทุกขั้นตอน คลิปอยู่ใน Flow แล้ว');
  return 'done';
}

(async () => {
  if (process.argv[2] === 'status') {
    // ตรวจสถานะการเชื่อมต่อ (ไม่เปิด Chrome เอง): Chrome ของบอทเปิดอยู่ไหม มีแท็บ Flow / AI ที่ล็อกอินแล้วไหม
    const out = { chrome: false, flow: false, ai: [] };
    if (await chromeIsUp()) {
      out.chrome = true;
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      for (const p of b.contexts()[0].pages()) {
        const u = p.url();
        if (/flow\.google/.test(u) && !/accounts\.google/.test(u)) { out.flow = true; if (out.credits == null) { const c = await readCredits(p); out.creditLow = !!c.low; if (c.credits != null) out.credits = c.credits; try { fs.writeFileSync(path.join(DATA, 'credits-debug.json'), JSON.stringify(c, null, 1)); } catch { /* ข้าม */ } } }
        for (const [k, s] of Object.entries(AI_SITES)) {
          if (s.host.test(u) && !/login|signin|sign-in|auth|accounts\.google/i.test(u) && !out.ai.includes(k)) out.ai.push(k);
        }
      }
      await b.close();
    }
    console.log('@@STATUS ' + JSON.stringify(out));
    return;
  }
  if (process.env.FLOWBOT_SIM) return require(process.env.FLOWBOT_SIM)({ IMPL, runPipeline, loadSegments, DATA, sleep, log, fs, path });
  const wasUp = await chromeIsUp();
  await ensureChrome();

  if (process.argv[2] === 'login') {
    if (wasUp) {
      // Chrome ของบอทเปิดค้างอยู่แล้ว (อาจซ่อนอยู่หลังหน้าต่างอื่น) ดึงขึ้นมาข้างหน้า
      try {
        const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
        const ctx = b.contexts()[0];
        const pg = ctx.pages().find(p => p.url().includes('flow')) || ctx.pages()[0] || await ctx.newPage();
        await pg.bringToFront();
        log('Chrome ของบอทเปิดอยู่แล้ว ดึงขึ้นมาข้างหน้าให้แล้ว (ถ้ายังไม่เห็น ให้ดูไอคอน Chrome ตัวที่สองบนแถบงาน Taskbar)');
      } catch (e) { log('Chrome ของบอทเปิดอยู่แล้ว ดูที่ไอคอน Chrome บนแถบงาน Taskbar'); }
    } else {
      log('เปิด Chrome ของบอทแล้ว ล็อกอิน Google ในหน้าต่างนั้นได้เลย');
    }
    log('ล็อกอิน Google / ตั้งค่า Flow ให้เรียบร้อย แล้วปล่อยหน้าต่างนั้นไว้ ไม่ต้องปิด');
    return;
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];

  if (process.argv[2] === 'open') {
    // เปิดแท็บเว็บ (เช่น Claude / ChatGPT) ใน Chrome ของบอท ให้ผู้ใช้ล็อกอินครั้งเดียว
    const url = process.argv[3] || 'https://claude.ai/';
    const pg = await context.newPage();
    await pg.goto(url).catch(() => {});
    log(`เปิด ${url} ในหน้าต่าง Chrome ของบอทแล้ว ล็อกอินที่นั่นได้เลย`);
    return;
  }

  if (process.argv[2] === 'import') {
    // ดึงคำตอบล่าสุดของ AI (บล็อกโค้ดแต่ละบล็อก = 1 segment) จากแท็บแชตที่เปิดอยู่ แล้วเขียนลง import.txt
    const pages = context.pages().filter(p => AI_HOST.test(p.url()));
    if (!pages.length) throw new Error('ไม่พบแท็บ Claude / ChatGPT / Gemini ใน Chrome ของบอท');
    let best = await readBestAnswer(pages.slice().reverse());
    if (!best || !best.text.trim() || best.sc === 0) { // อ่านจากหน้าเว็บไม่ได้/ไม่เจอชุด prompt → ลองกดปุ่ม Copy ของเว็บ AI
      log('อ่านจากหน้าเว็บไม่ได้ ลองกดปุ่ม Copy ของเว็บ AI แทน…');
      for (const pg of pages.slice().reverse()) {
        await pg.bringToFront().catch(() => {});
        const t = await readViaCopy(pg); if (!t) continue;
        const sc = planScore(t); if (!best || sc > best.sc || !best.text.trim()) best = { text: t, sc, i: 0, mode: 'copy', host: new URL(pg.url()).host };
        if (sc >= 2) break;
      }
    }
    if (!best || !best.text.trim()) { const dbg = []; for (const pg of pages) dbg.push(await pageProbe(pg)); fs.writeFileSync(path.join(DATA, 'import-debug.json'), JSON.stringify(dbg, null, 1)); }
    const text = best ? best.text : '';
    log(`อ่านคำตอบล่าสุดจากแท็บ: ${best ? best.host : '-'} (${best && best.sc ? 'พบชุด prompt ' + best.sc + ' กล่อง' : 'ไม่พบกล่อง prompt ในทุกแท็บ'})`);
    log(`อ่านได้ ${text.length} ตัวอักษร, กล่องโค้ด ${(text.match(/```/g) || []).length / 2} กล่อง`);
    if (!text.trim()) throw new Error('อ่านคำตอบไม่ได้ (หน้าเว็บอาจเปลี่ยนหน้าตา) ลองใช้ปุ่ม Copy แล้วให้แอปจับคลิปบอร์ดแทน');
    fs.writeFileSync(path.join(DATA, 'import.txt'), text, 'utf8');
    try { const hk = best && best.host ? Object.keys(AI_SITES).find(k => AI_SITES[k].host.test(best.host)) : ''; if (hk) fs.writeFileSync(path.join(DATA, 'import-ai.txt'), hk, 'utf8'); } catch { /* ไม่เป็นไร */ }
    log(`ดึงข้อความแล้ว (${text.length} ตัวอักษร)`);
    return;
  }

  if (process.argv[2] === 'ask') {
    // ส่งข้อความ (data/ask.txt) ให้ AI ในแชตใหม่ รอจนตอบเสร็จ แล้วเขียนคำตอบลง import.txt
    const key = process.argv[3] || 'claude';
    const msg = fs.readFileSync(path.join(DATA, 'ask.txt'), 'utf8');
    const here = process.env.FLOWBOT_HERE === '1';
    // AI บางครั้งตอบปัดสั้นๆ เช่น "ฉันเป็นแค่โมเดลภาษา…" (เจอกับ Gemini) แทนที่จะเขียน prompt → เปิดแชตใหม่ถามซ้ำ ไม่เกิน 3 ครั้ง
    const NOANS = /โมเดลภาษา|นอกเหนือ(จาก)?ความสามารถ|ไม่สามารถ(ช่วย|ตอบ|ทำ)|I['’]m (just )?a language model|I can['’]?t (help|assist)|I cannot (help|assist)|unable to (help|assist)|I['’]m not able to/i;
    const isNoAnswer = t => !(t.match(/```/g) || []).length && (t.trim().length < 400 || NOANS.test(t));
    let text = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      text = await askAI(context, key, msg, Number(process.env.FLOWBOT_EXPECT || 0), null, here);
      if (here || !isNoAnswer(text)) break;
      log(`${AI_SITES[key].name} ตอบปัด ไม่ได้เขียน prompt ("${text.replace(/\s+/g, ' ').trim().slice(0, 60)}") — ${attempt < 3 ? 'เปิดแชตใหม่ถามซ้ำ (' + attempt + '/3)' : 'ลองครบ 3 ครั้งแล้ว'}`);
      if (attempt === 3) throw new Error(`${AI_SITES[key].name} ตอบปัดทั้ง 3 ครั้ง (เช่น "ฉันเป็นแค่โมเดลภาษา…") — ลองกดเริ่มใหม่ หรือสลับไปใช้ ChatGPT / Claude แทน`);
      await sleep(4000);
    }
    fs.writeFileSync(path.join(DATA, 'import.txt'), text, 'utf8');
    log(`ได้คำตอบจาก ${AI_SITES[key].name} แล้ว (${text.length} ตัวอักษร, กล่องโค้ด ${(text.match(/```/g) || []).length / 2} กล่อง)`);
    return;
  }
  let page = context.pages().find(p => p.url().includes('flow'));
  if (!page) {
    page = await context.newPage();
    await page.goto(sel.url);
  }

  if (process.argv[2] === 'qctest') {
    // ทดสอบระบบตรวจคลิปกับคลิปที่มีอยู่แล้วในโปรเจ็กต์ (ไม่สร้างคลิปใหม่ ไม่เสียเครดิต): qctest <จำนวนคลิป> [ai]
    const n = Number(process.argv[3]) || 3, withAi = process.argv[4] === 'ai';
    const results = [];
    for (let i = 0; i < n; i++) {
      const q = await qcClip(page, { seg: 900 + i, index: i });
      const r = { i, ok: q.ok, flags: q.flags, note: q.note || '', frames: q.n, metrics: q.metrics, file: q.file };
      if (withAi && i === 0) {
        try { r.ai = await aiJudge(context, cfg.ai || 'claude', q.file, '', 'ทดสอบ: คลิปการ์ตูน 3D ตัวละครเดียวในฉากนอกบ้าน กล้องเคลื่อนช้าๆ'); } catch (e) { r.ai = { verdict: null, why: 'ถาม AI ไม่สำเร็จ: ' + e.message }; }
        await page.bringToFront().catch(() => {});
      }
      results.push(r);
      log(`ตรวจคลิป #${i + 1}: ${q.ok ? 'ปกติ' : 'น่าสงสัย — ' + q.flags.join(', ')}${q.note ? ' (' + q.note + ')' : ''}${r.ai ? ' · AI: ' + r.ai.verdict + ' ' + r.ai.why : ''}`);
    }
    fs.writeFileSync(path.join(DATA, 'qc-test.json'), JSON.stringify(results, null, 1));
    log('เขียนผลที่ data/qc-test.json แล้ว');
    await browser.close();
    return;
  }

  if (process.argv[2] === 'inspecttile') {
    // ตรวจปุ่มบนไทล์รูป/สถานะเครดิต โดยไม่กดอะไรที่ลบหรือเสียเครดิต: เอาเมาส์วางบนไทล์รูปแรก แล้วถ่ายรูป + จดรายชื่อปุ่ม
    const ids = await imageIds(page);
    const out = { tiles: ids.length, buttons: [], credits: await readCredits(page) };
    if (ids.length) {
      const tile = await tileHandle(page, ids[0].id);
      if (tile) {
        await tile.scrollIntoViewIfNeeded().catch(() => {}); await tile.hover(); await sleep(900);
        for (const b of await tile.$$('button')) out.buttons.push({ aria: await b.getAttribute('aria-label'), text: ((await b.innerText().catch(() => '')) || '').slice(0, 40), cls: ((await b.getAttribute('class')) || '').slice(0, 60) });
        await page.screenshot({ path: path.join(DATA, 'inspecttile.png') }).catch(() => {});
      }
    }
    fs.writeFileSync(path.join(DATA, 'inspecttile.json'), JSON.stringify(out, null, 1));
    log(`ตรวจแล้ว: ไทล์รูป ${out.tiles} ใบ · ปุ่มบนไทล์ ${out.buttons.length} ปุ่ม · เครดิตที่อ่านได้ ${out.credits.credits == null ? 'อ่านไม่ได้' : out.credits.credits}`);
    await browser.close();
    return;
  }
  if (process.argv[2] === 'inspect') {
    // สำรวจหน้า Flow ตอนนี้ แล้วเก็บรายชื่อปุ่ม/ช่องพิมพ์/ข้อความ ลงไฟล์ inspect-<ชื่อ>.json
    const name = process.argv[3] || 'page';
    const act = process.argv[4]; // ตัวเลือก: click:<ชื่อคีย์ใน selectors.json หรือ css> กดก่อนสำรวจ (เช่น เปิดเมนู +)
    if (act && act.startsWith('click:')) {
      const key = act.slice(6);
      await page.locator(sel[key] || key).first().click();
      await sleep(2000);
    }
    await page.screenshot({ path: path.join(__dirname, `inspect-${name}.png`) }).catch(() => {});
    const data = await page.evaluate(() => {
      const q = 'textarea,input,[contenteditable="true"],[role="textbox"],button,[role="button"],[role="progressbar"],[role="alert"],[role="status"],[aria-live],[role="menuitem"],[role="option"],[role="dialog"],[role="tab"],[role="listbox"],label';
      const items = [];
      document.querySelectorAll(q).forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        items.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          aria: el.getAttribute('aria-label'),
          text: (el.innerText || el.value || '').trim().slice(0, 80),
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
          id: el.id || null,
          cls: el.className ? el.className.toString().slice(0, 100) : null,
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        });
      });
      const videos = [...document.querySelectorAll('video')].map(v => {
        const r = v.getBoundingClientRect();
        return { src: (v.currentSrc || v.src || '').slice(0, 100), ready: v.readyState, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
      });
      const images = [...document.querySelectorAll('img')].filter(i => i.getBoundingClientRect().width > 60).map(i => ({ src: (i.currentSrc || i.src || '').slice(0, 100), alt: i.alt }));
      const percents = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode.textContent.trim();
        if (/\d+\s*%/.test(t) || /(ล้มเหลว|ข้อผิดพลาด|ไม่สำเร็จ|failed|error)/i.test(t)) percents.push(t.slice(0, 100));
      }
      const fileInputs = [...document.querySelectorAll('input[type="file"]')].map(i => ({ accept: i.accept, multiple: i.multiple, cls: (i.className || '').toString().slice(0, 80) }));
      return { url: location.href, bodyText: document.body.innerText.slice(0, 4000), items, videos, images, percents, fileInputs };
    });
    const file = path.join(__dirname, `inspect-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    log(`บันทึกแล้ว: ${file} (${data.items.length} รายการ)`);
    await browser.close();
    return;
  }

  const todo = Object.entries(sel).filter(([, v]) => typeof v === 'string' && v.startsWith('TODO')).map(([k]) => k);
  if (todo.length) {
    console.error('selectors.json ยังใส่ไม่ครบ: ' + todo.join(', '));
    await browser.close();
    process.exit(1);
  }

  if (process.argv[2] === 'attach') {
    // ทดสอบแนบภาพอย่างเดียว ไม่เจนคลิป: node run.js attach ชื่อภาพ1 ชื่อภาพ2
    await clearPrompt(page);
    await attachImages(page, process.argv.slice(3));
    await sleep(1500);
    await page.screenshot({ path: path.join(__dirname, 'attach-result.png') });
    log('แนบภาพเสร็จ ดูผลใน attach-result.png (ยังไม่ได้เจนคลิป)');
    await browser.close();
    return;
  }

  if (process.argv[2] === 'ingtest') {
    // ทดสอบวิดีโอโหมด "องค์ประกอบ": ตั้งโหมด → พิมพ์ prompt → แนบรูปจากไลบรารี (เหมือนกดเพิ่มรูปใน prompt) → ถ่ายภาพ
    // ถ้าตั้ง FLOWBOT_GENERATE=1 จะกดสร้างจริงด้วย (เสียเครดิต) ไม่งั้นหยุดก่อนกดสร้าง
    const names = process.argv.slice(3);
    await ensureProject(page);
    await setMode(page, { type: 'video', frames: false });
    await clearPrompt(page);
    await typePrompt(page, 'SHOT: Vertical 9:16, 10 seconds. One smooth continuous camera move: a slow dolly-in. The character from the attached images stands in the scene and slowly looks around, then smiles. Same character design in every second. No text.');
    await attachImages(page, names);
    await sleep(1500);
    const n = await page.locator(sel.ingredientImg).count().catch(() => -1);
    log(`รูปองค์ประกอบที่แนบในช่อง prompt: ${n} รูป (ต้องการ ${names.length})`);
    log(`ตั้งค่าปัจจุบัน: ${await chipText(page)}`);
    await page.screenshot({ path: path.join(DATA, 'ingtest.png') });
    if (process.env.FLOWBOT_GENERATE === '1' && n >= names.length) {
      const before = await doneCount(page);
      await page.locator(sel.generateButton).first().click();
      log('กดสร้างวิดีโอแล้ว รอผล...');
      log('ผล: ' + await waitResult(page, before, 1));
    } else log('ยังไม่กดสร้าง (ตรวจดูภาพ ingtest.png)');
    await browser.close();
    return;
  }

  await ensureProject(page);
  let segments;
  try { segments = loadSegments(); } catch (e) { log('หยุด: ' + e.message); console.log('@@TOTAL 0'); await browser.close(); process.exit(1); }
  if (segments.some(x => x.kind !== 'text')) {
    const out = await runPipeline(page, segments);
    await browser.close();
    process.exit(out === 'done' ? 0 : 2);
  }
  // โหมดเดิม (prompt ล้วน ไม่มีแท็ก): ใส่ prompt ทีละ segment แล้วเจนวิดีโอ
  await ensureVideoMode(page);
  const results = [];
  log('FlowBot เวอร์ชัน 4.1 (โหมด prompt ล้วน)');
  log(`พบ ${segments.length} segment`);
  console.log(`@@TOTAL ${segments.length}`);

  const startFrom = Math.max(1, Number(process.env.FLOWBOT_FROM || 1));
  for (let i = startFrom - 1; i < segments.length; i++) {
    const n = i + 1;
    const seg = segments[i];
    try {
      log(`Segment ${n}: ใส่ prompt`);
      const box = page.locator(sel.promptBox).first();
      await box.waitFor({ timeout: 30000 });
      await clearPrompt(page);
      await box.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(seg.text);
      if (seg.images.length) await attachImages(page, seg.images);
      await page.screenshot({ path: path.join(DATA, `shot-seg${n}.png`) }).catch(() => {});
      const st = await page.locator(sel.settingsButton).first().innerText().catch(() => '');
      const m = st.match(/x(\d)/);
      const expected = m ? Number(m[1]) : 1;
      const before = await doneCount(page);
      await page.locator(sel.generateButton).first().click();
      log(`Segment ${n}: กำลังเจน... (คาดว่าได้ ${expected} คลิป)`);
      const status = await waitResult(page, before, expected);
      log(`Segment ${n}: ${status}`);
      results.push({ segment: n, status });
      console.log(`@@RESULT ${n} ${status}`);
      if (status !== 'done') await page.screenshot({ path: path.join(DATA, `fail-seg${n}.png`) }).catch(() => {});
    } catch (e) {
      log(`Segment ${n}: ผิดพลาด ${e.message}`);
      results.push({ segment: n, status: 'error', detail: e.message });
      console.log(`@@RESULT ${n} error`);
    }
    if (i < segments.length - 1) await sleep(cfg.delayBetweenMs);
  }

  fs.writeFileSync(path.join(DATA, 'results.json'), JSON.stringify(results, null, 2));
  const bad = results.filter(r => r.status !== 'done');
  log(bad.length ? `มี ${bad.length} segment ที่ไม่สำเร็จ: ${bad.map(b => b.segment).join(', ')}` : 'สำเร็จครบทุก segment');
  await browser.close(); // แค่ตัดการเชื่อมต่อ Chrome ยังเปิดอยู่
})().then(() => process.exit(0)).catch(e => { console.error('ผิดพลาด:', e.message); process.exit(1); });
