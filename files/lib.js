// FlowBot 2.0 — ฟังก์ชันกลางที่ใช้ร่วมกันระหว่าง server.js และ run.js (แยก prompt, ตรวจคำเสี่ยง, สร้างคำสั่งให้ AI)
const SEP = /^\s*-{3,}\s*$/m;
const TAG_RE = /^\s*\[\s*(รูปภาพ|รูป|ภาพ|image|img|วิดีโอ|video|คลิป)\s*([^\]]*)\]\s*$/i;

// แท็กหัว segment: [รูป K0] = เจนรูปคีย์เฟรมชื่อ K0 · [วิดีโอ S1: K0 → K1] = เจนวิดีโอแบบเฟรม เริ่ม K0 จบ K1
function parseTag(text) {
  const lines = text.split('\n');
  const m = lines[0].match(TAG_RE);
  if (!m) return { kind: 'text', text };
  const rest = lines.slice(1).join('\n').trim();
  const word = m[1].toLowerCase();
  const body = m[2].trim();
  if (/รูป|ภาพ|image|img/.test(word)) {
    const name = body.split(/[:：]/)[0].trim();
    return { kind: 'image', name, text: rest };
  }
  const mm = body.match(/(?:^|[:：\s])([^\s:：→>\[\]]+)\s*(?:→|->|=>|>|ถึง|to)\s*([^\s\]]+)\s*$/i);
  return { kind: 'video', start: mm ? mm[1] : null, end: mm ? mm[2] : null, text: rest };
}

function parseBlock(block) {
  block = String(block || '').replace(/\[\s*attach(?:ed)?\s*:/gi, '[แนบ:');
  const images = [];
  // มาร์กเกอร์แนบภาพ [แนบภาพ @: ชื่อ] / [แนบ: ชื่อ1, ชื่อ2] อยู่ตรงไหนของข้อความก็ได้ (สกิลบางตัวใส่ไว้ต้น prompt บรรทัดเดียวกัน)
  const cleaned = block.replace(/\[แนบ(?:ภาพ)?\s*@?\s*:\s*([^\]\n]*)\][ \t]*/g, (_, list) => {
    // AI บางตัว (Gemini) ใส่คำนำหน้า "รูป"/"ภาพ" ติดมากับชื่อ เช่น [แนบ: รูป Character Sheet น้อง] → ตัดออก ให้ตรงกับแท็ก [รูป Character Sheet น้อง]
    list.split(/,|\s\+\s/).map(x => x.trim().replace(/^(?:รูปภาพ|รูป|ภาพ|image|img)\s+(?=\S)/i, '').trim()).filter(Boolean).forEach(n => images.push(n));
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  const t = parseTag(cleaned);
  return { ...t, images };
}

// แบ่ง prompts.txt เป็นบล็อก (ตัดบล็อกว่างทิ้ง) — ลำดับนี้คือเลข segment (เริ่มที่ 1)
function splitBlocks(raw) {
  return String(raw || '').split(SEP).map(b => b.trim()).filter(b => b && parseBlock(b).text);
}
function parseSegments(raw) { return splitBlocks(raw).map(parseBlock); }

const looksVideo = t => /(^|\n)\s*SHOT\s*:/i.test(t) || /start(s|ing)? exactly on the start frame/i.test(t);
// ถ้า AI ส่ง prompt แบบเก่า (ไม่มีแท็ก) ให้เดาเองว่าอันไหนคือรูป อันไหนคือวิดีโอ
function inferPipeline(segs) {
  if (segs.some(x => x.kind !== 'text')) return segs;
  const vids = segs.filter(x => looksVideo(x.text)).length;
  if (!vids || vids === segs.length) return segs;
  let k = 0, v = 0;
  const imgCount = segs.length - vids;
  const sheetFirst = /character sheet|turnaround|five expressions|5 expressions/i.test(segs[0].text) && !looksVideo(segs[0].text);
  const need = vids + 1 + (sheetFirst ? 1 : 0);
  if (imgCount !== need) {
    throw new Error(`แยกรูป/วิดีโอไม่ได้แน่ชัด (รูป ${imgCount} ใบ วิดีโอ ${vids} คลิป คาดว่ารูปต้องเป็น ${need}) ให้ AI ส่งแบบมีแท็ก [รูป K0] / [วิดีโอ S1: K0 → K1]`);
  }
  return segs.map((x, i) => {
    if (looksVideo(x.text)) { v++; return { ...x, kind: 'video', start: 'K' + (v - 1), end: 'K' + v, images: [] }; }
    if (i === 0 && sheetFirst) return { ...x, kind: 'image', name: 'Character Sheet' };
    return { ...x, kind: 'image', name: 'K' + (k++) };
  });
}

// แปลงข้อความจาก AI (มี ```บล็อกโค้ด``` แยกต่อ segment) เป็นรูปแบบ prompts.txt: segment คั่นด้วย ---
function normalizePrompts(raw) {
  raw = String(raw || '').replace(/\[\s*attach(?:ed)?\s*:/gi, '[แนบ:').replace(/\r\n/g, '\n').trim();
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  const blocks = []; let m, prevEnd = 0;
  while ((m = fence.exec(raw))) {
    const before = raw.slice(prevEnd, m.index);
    const lines = before.split('\n').map(x => x.trim());
    const tags = lines.filter(x => /^\[\s*(รูปภาพ|รูป|ภาพ|image|img|วิดีโอ|video|คลิป)[^\]]*\]$/i.test(x));
    // บรรทัดที่มีแต่มาร์กเกอร์แนบภาพ (หลายอันในบรรทัดเดียวก็ได้) เช่น "[แนบภาพ @: Character Sheet] [แนบภาพ @: L1]"
    const MARK = /\[แนบ(?:ภาพ)?\s*@?\s*:[^\]]*\]/g;
    const marks = [];
    lines.forEach(x => { const f = x.match(MARK); if (f && !x.replace(MARK, '').trim()) marks.push(...f); });
    let body = m[1].trim();
    const head = [];
    // สกิลแบบเก่าไม่มีแท็ก แต่มีบรรทัดป้ายก่อนกล่องโค้ด: "Sheet A: …" / "K1b (…)" / "Segment 1 · …" + "ช่องเริ่ม: K0 · ช่องจบ: K1"
    if (!tags.length && !/^\s*\[\s*(รูป|ภาพ|image|img|วิดีโอ|video|คลิป)/i.test(body)) {
      const vm = before.match(/ช่องเริ่ม\s*[:：]\s*([^\s·,|]+)[\s\S]*?ช่องจบ\s*[:：]\s*([^\s·,|]+)/);
      const sg = before.match(/Segment\s+(\d+)/i);
      let lab = null;
      if (vm) lab = `[วิดีโอ S${sg ? sg[1] : blocks.length + 1}: ${vm[1]} → ${vm[2]}]`;
      else if (sg) lab = `[วิดีโอ S${sg[1]}]`; // Segment N แบบไม่มีช่องเริ่ม/จบ = โหมดองค์ประกอบ (แนบภาพตามมาร์กเกอร์)
      else {
        for (const ln of lines) {
          let x;
          if ((x = ln.replace(/[*#_`]/g, '').trim().match(/^Character\s+Sheet\s*[:：\-–]\s*([^()（]+?)\s*(?:[(（].*)?$/i))) lab = `[รูป Character Sheet ${x[1].trim()}]`;
          else if ((x = ln.replace(/[*#_`]/g, '').trim().match(/^Set\s+Reference\s*[:：\-–]?\s*([^()（]*?)\s*(?:[(（].*)?$/i))) lab = `[รูป Set Reference${x[1].trim() ? ' ' + x[1].trim() : ''}]`;
          else if ((x = ln.match(/^(?:Character\s+)?Sheet\s+([A-Za-z0-9]+)\b/i))) lab = `[รูป Character Sheet ${x[1].toUpperCase()}]`;
          else if ((x = ln.match(/^(?:\d+\)\s*)?Storyboard\b/i))) lab = `[รูป Storyboard]`;
          else if ((x = ln.match(/^\d+\)\s*Character\s+Sheet\b/i))) lab = `[รูป Character Sheet]`;
          else if ((x = ln.match(/^([A-Z]\d+[a-z]?)(?=$|[\s(:：·])/))) lab = `[รูป ${x[1]}]`;
        }
      }
      // เดาจากเนื้อหาเมื่อหัวข้ออ่านไม่ออก/ได้ป้ายกว้างเกินไป: แผ่นตัวละครที่ "named X" และฉากว่างก่อนคีย์เฟรมแรก
      if (/character design sheet|character sheet/i.test(body) && !/^\s*SHOT\s*:/im.test(body)) {
        const nm = body.match(/\bnamed\s+([A-Z][\w-]*)/);
        if (nm && (!lab || /^\[รูป Character Sheet\]$/.test(lab) || /^\[รูป Character Sheet [A-Z]\]$/.test(lab))) lab = `[รูป Character Sheet ${nm[1]}]`;
        else if (!lab) lab = '[รูป Character Sheet]';
      } else if (!lab && !blocks.some(b => /^\[(รูป K|วิดีโอ)/i.test(b)) && !/(^|\n)\s*SHOT\s*:/i.test(body)) {
        lab = '[รูป Set Reference]';
      }
      if (lab) tags.push(lab);
    }
    if (tags.length && !/^\s*\[\s*(รูป|ภาพ|image|img|วิดีโอ|video|คลิป)/i.test(body)) head.push(tags[tags.length - 1]);
    if (marks.length && !/\[แนบ/.test(body)) head.push(...marks);
    if (head.length) body = head.join('\n') + '\n' + body;
    // แท็กรูปแผ่นตัวละครที่ไม่มีชื่อ แต่เนื้อหาบอก "named X" → ใส่ชื่อให้ตรงกับที่ K อื่นแนบ ("Character Sheet X")
    if (/^\s*\[\s*(?:รูป|ภาพ|image|img)\s+Character Sheet\s*\]/i.test(body)) {
      const nm = body.match(/\bnamed\s+([A-Z][\w-]*)/);
      if (nm) body = body.replace(/^(\s*\[\s*(?:รูป|ภาพ|image|img)\s+Character Sheet)\s*\]/i, `$1 ${nm[1]}]`);
    }
    if (body && !/^STYLE\s*:/i.test(body)) {
      // AI บางตัว (Gemini) ใส่ทุกท่อนไว้ในกล่องโค้ดเดียว คั่นด้วยบรรทัดว่าง → แยกที่บรรทัดแท็ก [รูป …] / [วิดีโอ …]
      const TAGL = /^\s*\[\s*(?:รูปภาพ|รูป|ภาพ|image|img|วิดีโอ|video|คลิป)\s[^\n]*$/i;
      const ls = body.split('\n'), cuts = [];
      ls.forEach((ln, i) => { if (TAGL.test(ln)) cuts.push(i); });
      if (cuts.length > 1) {
        cuts.forEach((c, k) => { const part = ls.slice(c, k + 1 < cuts.length ? cuts[k + 1] : ls.length).join('\n').trim(); if (part) blocks.push(part); });
      } else blocks.push(body);
    }
    prevEnd = m.index + m[0].length;
  }
  if (blocks.length) return blocks.join('\n\n---\n\n').replace(/\[แนบ(ภาพ)?(\s*@?\s*:\s*)([^\]\n]*)\]/g, (m, ph, sep, list) => `[แนบ${ph || ''}${sep}${list.split(',').map(x => x.trim().replace(/^(?:รูปภาพ|รูป|ภาพ|image|img)\s+(?=\S)/i, '')).join(', ')}]`);
  return raw;
}
const countSegs = t => splitBlocks(t).length;

// สรุปแผน: รูปกี่ใบ วิดีโอกี่คลิป (ใช้โชว์หน้าจอ + ประมาณเครดิต)
function planOf(raw) {
  let segs;
  try { segs = inferPipeline(parseSegments(raw)); } catch (e) { return { error: e.message, segs: [], images: [], videos: [] }; }
  const images = [], videos = [];
  segs.forEach((s, i) => {
    if (s.kind === 'image') images.push({ seg: i + 1, name: s.name || 'K' + i });
    else if (s.kind === 'video') videos.push({ seg: i + 1, start: s.start, end: s.end });
    else videos.push({ seg: i + 1, start: null, end: null });
  });
  const pipeline = segs.some(s => s.kind !== 'text');
  return { segs, images, videos, pipeline, error: null };
}
const creditPerVideo = sec => Math.round((Number(sec) || 10) * 1.5); // 10 วิ = 15 เครดิต (ประมาณการ)
const estimateCredits = (plan, sec) => (plan.videos ? plan.videos.length : 0) * creditPerVideo(sec);

// ---------- ตรวจคำเสี่ยงก่อนส่งเข้า Flow ----------
// รายการนี้เป็น "คำที่มักทำให้ Flow ปฏิเสธ" จากประสบการณ์ ไม่ใช่รายการทางการของ Google — ใช้เป็นตัวช่วยเตือนเท่านั้น
const RISK = [
  ['blood|bloody|bleeding|gore|gory', 'ฉากเลือด/ความรุนแรง', 'ใช้สัญลักษณ์แทน เช่น รอยแดงจางๆ หรือตัดออก'],
  ['corpses?|dead bod(?:y|ies)|cadavers?|skeletons?', 'ศพ', 'ตัดออก หรือเล่าด้วยภาพเมืองที่เงียบลง'],
  ['dead|dying|death|died', 'ความตาย', 'ใช้คำเบากว่า เช่น หายไป/จากไป หรือเล่าเป็นสัญลักษณ์'],
  ['kill(?:s|ed|ing)?|murder(?:s|ed|ing)?|massacre|slaughter', 'การฆ่า', 'เปลี่ยนเป็นเหตุการณ์ที่ไม่แสดงความรุนแรง'],
  ['suicide|self-harm|hang(?:s|ed|ing)? (?:him|her|them)self', 'การทำร้ายตัวเอง', 'ห้ามมีในคลิป ตัดออกทั้งฉาก'],
  ['guns?|rifles?|pistols?|shoot(?:s|ing)?|shot dead|bullets?|weapons?', 'อาวุธ/ยิง', 'เปลี่ยนเป็นวัตถุที่ไม่ใช่อาวุธ หรือตัดออก'],
  ['bombs?|explosions?|explod(?:e|es|ed|ing)|terror(?:ist|ism)?', 'ระเบิด/ก่อการร้าย', 'ใช้ภาพควันจางๆ/เสียงดัง แทนการระเบิดตรงๆ'],
  ['naked|nude|nudity|sexual|sex|rape|erotic', 'เนื้อหาเพศ', 'ตัดออก'],
  ['torture|tortured|abuse|abused|beating|beaten', 'การทรมาน/ทารุณ', 'เล่าเป็นสัญลักษณ์ ไม่แสดงตรงๆ'],
  ['drugs?|cocaine|heroin|meth(?:amphetamine)?|overdose', 'ยาเสพติด', 'ตัดออก หรือใช้คำกลางๆ'],
  ['infected (?:people|person|bod(?:y|ies))|plague victims?|patients? (?:lying|dying)', 'ผู้ป่วย/ผู้ติดเชื้อในสภาพรุนแรง', 'ใช้ภาพถนนเงียบ/คนใส่หน้ากากแทน'],
  ['ศพ|ซากศพ', 'ศพ', 'ตัดออก หรือเล่าด้วยภาพเมืองที่เงียบลง'],
  ['เลือด|นองเลือด', 'ฉากเลือด', 'ใช้สัญลักษณ์แทน หรือตัดออก'],
  ['ฆ่าตัวตาย|ทำร้ายตัวเอง', 'การทำร้ายตัวเอง', 'ห้ามมีในคลิป ตัดออกทั้งฉาก'],
  ['ฆ่า|สังหาร|ฆาตกรรม|สังหารหมู่', 'การฆ่า', 'เปลี่ยนเป็นเหตุการณ์ที่ไม่แสดงความรุนแรง'],
  ['ความตาย|เสียชีวิต|ล้มตาย|ตายหมู่|ตาย', 'ความตาย', 'ใช้คำเบากว่า เช่น จากไป/หายไป'],
  ['ปืน|ยิง|กระสุน|อาวุธ', 'อาวุธ/ยิง', 'เปลี่ยนเป็นวัตถุที่ไม่ใช่อาวุธ หรือตัดออก'],
  ['ระเบิด|ก่อการร้าย', 'ระเบิด/ก่อการร้าย', 'ใช้ภาพควันจางๆ แทน'],
  ['เปลือย|โป๊|ข่มขืน|เซ็กส์|เพศสัมพันธ์', 'เนื้อหาเพศ', 'ตัดออก'],
  ['ทรมาน|ทารุณ|ทุบตี', 'การทรมาน/ทารุณ', 'เล่าเป็นสัญลักษณ์ ไม่แสดงตรงๆ'],
  ['ยาเสพติด|โคเคน|เฮโรอีน|ยาบ้า', 'ยาเสพติด', 'ตัดออก หรือใช้คำกลางๆ'],
  ['ผู้ติดเชื้อ|ผู้ป่วยนอน', 'ผู้ป่วย/ผู้ติดเชื้อในสภาพรุนแรง', 'ใช้ภาพถนนเงียบ/คนใส่หน้ากากแทน'],
].map(([re, label, tip], i) => ({ re: new RegExp(/[ก-๙]/.test(re) ? `(${re})` : `\\b(${re})\\b`, 'gi'), label, tip, i }));

// คืนรายการ { seg, word, label, tip, snippet } — 1 รายการต่อ (segment, ป้ายกำกับ) เพื่อไม่ให้ยาวเกินไป
function riskScan(raw) {
  const out = [];
  const blocks = splitBlocks(raw);
  blocks.forEach((b, bi) => {
    const body = parseBlock(b).text;
    const seen = new Set();
    for (const r of RISK) {
      r.re.lastIndex = 0;
      const m = r.re.exec(body);
      if (!m || seen.has(r.label)) continue;
      seen.add(r.label);
      const a = Math.max(0, m.index - 40), z = Math.min(body.length, m.index + m[0].length + 40);
      out.push({ seg: bi + 1, word: m[0], label: r.label, tip: r.tip, before: body.slice(a, m.index).replace(/\s+/g, ' '), after: body.slice(m.index + m[0].length, z).replace(/\s+/g, ' ') });
    }
  });
  return out;
}

// ---------- รูปจริงของผู้ใช้ (อัปโหลดในบอท) ----------
// refs: [{ name, kind: 'person'|'product'|'place'|'other', note }] หรือ [ชื่อ] แบบเก่า
const REF_KIND = { person: 'คน', product: 'สินค้า', place: 'สถานที่/ฉาก', outfit: 'ชุด/เสื้อผ้า', other: 'รูปอ้างอิง' };
const normRefs = refs => (refs || []).map(r => (typeof r === 'string' ? { name: r } : r)).filter(r => r && r.name);
function refsBlockTH(refs) {
  refs = normRefs(refs);
  if (!refs.length) return '';
  const has = k => refs.some(r => r.kind === k);
  const rows = refs.map(r => `- ชื่อรูป: "${r.name}" | ประเภท: ${REF_KIND[r.kind] || 'รูปอ้างอิง'}${r.note ? ' | คำอธิบาย: ' + String(r.note).slice(0, 120) : ''}`);
  return `

รูปจริงที่ผู้ใช้อัปโหลดไว้ในบอทแล้ว (ห้ามเขียน prompt สร้างรูปเหล่านี้ใหม่ ให้อ้างชื่อใน [แนบ: …] เท่านั้น ใส่เฉพาะข้อความในเครื่องหมายคำพูดหลัง "ชื่อรูป:" ให้ตรงเป๊ะ เช่น [แนบ: ${refs[0].name}] ห้ามใส่ประเภทหรือคำอธิบายต่อท้ายชื่อ):
${rows.join('\n')}
วิธีใช้รูปจริง:
- ทุกกล่องรูปและวิดีโอที่มีคน/สินค้า/ชุด/สถานที่ในรายการนี้อยู่ในภาพ ต้องใส่ชื่อนั้นใน [แนบ: …] ทุกครั้ง (ไม่ใช่แค่กล่องแรก)${has('person') ? `
- คน: ใช้รูปนี้แทน Character Sheet ของคนนั้น (ห้ามสร้าง Character Sheet ใหม่ให้คนที่มีรูปจริง) ใน prompt เขียนว่า "the same person as in the attached photo — same face, hairstyle and skin tone" ห้ามบรรยายหน้าตาใหม่` : ''}${has('product') ? `
- สินค้า: ใน prompt เขียนว่า "exactly the product in the attached photo — same shape, color, label and logo" ห้ามเปลี่ยนรูปทรง สี หรือฉลาก ห้ามใส่ตัวหนังสือใหม่บนสินค้า` : ''}${has('outfit') ? `
- ชุด: ให้ตัวละครใส่ชุดตามรูปที่แนบ เหมือนเดิมทุกกล่อง` : ''}
- ถ้าผู้ใช้ไม่ได้ขอสไตล์อื่น ให้ภาพดูสมจริงเหมือนรูปถ่ายที่แนบ (ไม่ต้องเป็นการ์ตูน)
- ถ้าเรื่องไม่ได้ใช้รูปไหนในรายการ ก็ไม่ต้องแนบรูปนั้น`;
}

// ---------- คำสั่งให้ AI ----------
const toFenced = raw => splitBlocks(raw).map(b => '```\n' + b + '\n```').join('\n\n');
const STORY_RULES = `กฎคุณภาพหนังสั้น (ให้ต่อเนื่องเหมือนงานละครจริง):
- เรื่องทั้งหมดต้องมีจังหวะ: ท่อนแรกเปิดสถานการณ์และตัวละคร → ท่อนกลางมีปัญหาหรือความตึงเครียดเพิ่มขึ้น → ท่อนสุดท้ายมีจุดคลี่คลายหรือภาพจบที่จำได้ ท่อนละ 1 เหตุการณ์หลัก ห้ามยัดหลายเหตุการณ์
- ท่อนจบของแต่ละท่อน ต้องเป็นสถานะที่ท่อนถัดไปเริ่มต่อได้เลย (ตำแหน่ง ท่าทาง อารมณ์ แสง ตรงกัน) ห้ามกระโดดเวลา สถานที่ หรือเสื้อผ้าโดยไม่มีเหตุผลในเรื่อง
- ตัวละครต้องหน้าตา ผม ชุด ของถือ เหมือนเดิมทุกกล่อง: ทุก prompt ให้เขียนลักษณะตัวละครสั้นๆ ซ้ำให้ครบ (วัย ผม ชุด) ห้ามใช้แค่ "เขา" หรือ "เธอ"
- อารมณ์คือหัวใจ: กำหนดอารมณ์หลักของแต่ละท่อน (เช่น ระแวง ตกใจ เศร้า โล่งใจ) ให้อารมณ์ไล่ระดับต่อเนื่องข้ามท่อน ไม่สลับแบบไม่มีเหตุผล
- ทุก prompt วิดีโอต้องเขียนการแสดงให้เห็นภาพ: สีหน้า (คิ้ว ตา ปาก) สายตามองไปไหน ท่าทางร่างกาย จังหวะหายใจ/ลังเล เปลี่ยนตามอารมณ์ ห้ามเขียนแค่ "ดูเศร้า" ให้บอกว่าแสดงออกอย่างไร และตัวละครไม่ยืนนิ่ง
- น้ำเสียง: กำหนดเสียงของตัวละครแต่ละคนครั้งเดียว (วัย โทนสูงต่ำ ลักษณะเสียง) แล้วใช้ข้อความเดิมซ้ำทุกท่อนที่ตัวละครนั้นพูด ทุกบทพูดให้ระบุวิธีพูดตามอารมณ์ เช่น กระซิบสั่นๆ พูดเร็วขึ้นตอนตกใจ เสียงแผ่วลงตอนเสียใจ หยุดเว้นจังหวะ (เขียนเป็นภาษาอังกฤษนำหน้าบทพูดในเครื่องหมายคำพูด)
- ทิศทางการเดิน/เคลื่อนที่ (สำคัญมาก AI วิดีโอมักสับสนจนตัวละครเดินถอยหลังหรือลอย): ทุกครั้งที่ตัวละครเดิน วิ่ง หรือเคลื่อนที่ ใน prompt วิดีโอภาษาอังกฤษต้องเขียนให้ชัด 3 อย่าง (1) ตำแหน่งกล้องเทียบกับตัวละคร เช่น "camera behind him, we see his back" / "camera at his side" / "camera in front of him" (2) ตัวละครหันหน้าไปทางที่เดินเสมอ เขียนว่า "walks forward, facing the direction he is moving, never walking backwards" (3) ทิศที่เดินเทียบกล้อง เช่น "walks away from the camera into the shop" หรือ "walks toward the camera" ห้ามให้กล้องถอยหลังพร้อมกับตัวละครที่เดินเข้าหากล้อง เว้นแต่ผู้ใช้สั่ง ถ้าฉากเปิดเป็นตัวละครเดินเข้าสถานที่ ให้ใช้กล้องตามหลังหรือด้านข้างที่เดินเข้าไปในฉาก (ผู้ใช้ระบุเป็นอย่างอื่นให้ทำตามผู้ใช้) และรูป Scene ของฉากนั้นต้องจัดตัวละครให้ตรงกับทิศเดียวกัน
- เลือกขนาดช็อตสลับกันตามอารมณ์ (กว้าง/กลาง/ใกล้) กล้องเคลื่อนช้าๆ แบบเดียวต่อท่อน
- แสง โทนสี และสไตล์ภาพ ต้องคงเดิมทั้งเรื่อง เปลี่ยนได้เมื่อเวลาในเรื่องเปลี่ยนจริงเท่านั้น
- ถ้ามีบทพากย์หรือบทพูด ให้ฟังเป็นธรรมชาติ สั้น ตรงกับภาพในท่อนนั้น ไม่เล่าซ้ำสิ่งที่เห็นอยู่แล้ว`;
const SAFE_RULES = `กฎเนื้อหา (สำคัญ เพื่อไม่ให้ Google Flow ปฏิเสธ):
- สไตล์ภาพ: ตามที่ผู้ใช้หรือ prompt เดิมกำหนด ห้ามเปลี่ยนสไตล์ของ prompt ที่มีอยู่แล้ว ถ้าไม่ได้กำหนดเลย ให้เลือก "สไตล์เดียว" ที่เหมาะกับเรื่อง แล้วใช้เหมือนกันทุกกล่อง: เรื่องคน/ละคร/หนังสั้น/รีวิวสินค้า = ภาพสมจริงแบบภาพยนตร์ · เรื่องสำหรับเด็ก = การ์ตูน 3D นุ่มนวล (ห้ามเลือกการ์ตูนเองเพียงเพราะไม่มีคำสั่งสไตล์)
- ห้ามมีเลือด บาดแผล ศพ อาวุธ ความรุนแรง การทำร้ายตัวเอง เนื้อหาเพศ ยาเสพติด
- ห้ามใส่ชื่อบุคคลจริงหรือคนดังใน prompt ใช้คำกลางๆ แทน เช่น "นักวิ่งชาวอิตาลีคนหนึ่ง"
- เรื่องอ่อนไหว (โรคระบาด สงคราม ภัยพิบัติ) เล่าด้วยสัญลักษณ์นุ่มๆ เช่น ถนนเงียบ คนใส่หน้ากาก ไม่แสดงผู้เสียหาย
- ไม่มีตัวอักษร ลายน้ำ หรือโลโก้ในภาพ`;

function castBlock(cast) {
  cast = (cast || []).filter(c => c && (c.name || c.look || c.voice));
  if (!cast.length) return '';
  const rows = cast.map((c, i) => `- ตัวละคร ${i + 1}: ${c.name || '(ไม่ระบุชื่อ)'} | หน้าตา: ${c.look || '(ให้ AI ออกแบบ แล้วคงเดิมทุกกล่อง)'} | น้ำเสียง: ${c.voice || '(ให้ AI กำหนด แล้วคงเดิมทุกกล่อง)'}`);
  return `

ตัวละครที่ผู้ใช้กำหนด (ใช้ตามนี้เป๊ะ ห้ามเปลี่ยนหน้าตาหรือน้ำเสียง):
${rows.join('\n')}
กฎของตัวละครเหล่านี้:
- ทำ [รูป Character Sheet ชื่อ] แยกกล่องละ 1 ตัวละคร ตามหน้าตาที่กำหนด (ยกเว้นตัวที่มีรูปจริงในรายการรูป)
- ทุก prompt ที่มีตัวละครนี้อยู่ในภาพ ให้เขียนหน้าตาตามที่กำหนดซ้ำให้ครบ
- ทุกบทพูดต้องบอกว่าใครพูด และใส่ "น้ำเสียง" ที่กำหนดเป็นภาษาอังกฤษข้อความเดิมซ้ำทุกครั้งที่ตัวละครนั้นพูด ตามด้วยวิธีพูดตามอารมณ์ของฉากนั้น แล้วจึงตามด้วยบทพูดในเครื่องหมายคำพูด
- ถ้ามีหลายตัวละครอยู่ในช่วงเดียวกัน ให้แยกให้ชัดว่าประโยคไหนใครพูด และเสียงต้องต่างกันตามที่กำหนด`;
}

function scriptBlock(script) {
  script = String(script || '').trim();
  if (!script) return '';
  return `

บทพูดที่ผู้ใช้กำหนด (เรียงตามลำดับที่จะพูดในเรื่อง รูปแบบ "ชื่อ: คำพูด"):
${script}
กฎของบทพูด:
- ใช้ถ้อยคำตามบทพูดนี้ ห้ามแก้เนื้อหา ห้ามเพิ่มหรือตัดประโยคของผู้ใช้ ห้ามเปลี่ยนลำดับ
- แบ่งบทพูดลงแต่ละท่อนตามลำดับ ท่อนละไม่เกินประมาณ 48-56 พยางค์ (ประโยคไหนไม่พอ ให้ยกไปท่อนถัดไป อย่าย่อประโยค)
- ใส่ในบทพูดของแต่ละท่อนให้ตรงกับภาพและอารมณ์ของท่อนนั้น พร้อมระบุคนพูดและวิธีพูดตามกฎน้ำเสียง
- ถ้าผู้ใช้ไม่ได้ระบุบทพูดสำหรับท่อนไหน ให้ท่อนนั้นไม่มีบทพูด (ใช้ภาพและเสียงบรรยากาศเล่า) ห้ามแต่งบทเพิ่มเอง`;
}

function storyBlock(story) {
  story = (story || []).filter(x => x && (x.what || x.place || x.say || x.mood || x.shot));
  if (!story.length) return '';
  const rows = story.map((x, i) => {
    const say = x.say ? '\n   บทพูดของฉากนี้ (ใช้ถ้อยคำนี้เป๊ะ):\n' + String(x.say).split(/\n/).filter(Boolean).map(l => '   ' + l).join('\n') : '\n   บทพูด: ไม่มี (ใช้ภาพและเสียงบรรยากาศเล่า)';
    return `ฉาก ${i + 1}${x.role ? ' [' + x.role + ']' : ''}
   ที่ไหน/เมื่อไหร่: ${x.place || '(ให้ AI เลือกให้เข้ากับเรื่อง)'}
   ใครอยู่ในฉาก: ${(x.who || []).length ? x.who.join(', ') : '(ตามเนื้อเรื่อง)'}
   เกิดอะไรขึ้น: ${x.what || '(ให้ AI คิดต่อจากฉากก่อนหน้าให้เข้ากับเรื่อง)'}
   ต่อเนื่องจากฉากก่อน: ${i > 0 && x.link ? 'ใช่ — อยู่ที่เดิม ฉากเดิมต่อเนื่อง' : 'ไม่ (ภาพใหม่อิสระ)'}
   อารมณ์ของฉาก: ${x.mood || '(ตามเนื้อเรื่อง)'}
   ช็อต/มุมกล้อง: ${x.shot || '(ให้ AI เลือกให้เหมาะกับอารมณ์)'}${say}`;
  });
  return `

เนื้อเรื่องทีละฉากที่ผู้ใช้เขียนไว้ (${story.length} ฉาก = ${story.length} ท่อน):
${rows.join('\n')}
กฎของเนื้อเรื่องนี้:
- ใช้ตามนี้ตามลำดับ: ฉาก i = [รูป Scene i] = [วิดีโอ S i] ห้ามสลับ ข้าม หรือรวมฉาก ห้ามเปลี่ยนสถานที่และเหตุการณ์ที่ผู้ใช้เขียน
- เติมรายละเอียดภาพได้เอง (ท่าทาง สีหน้า แสง สิ่งของในฉาก การเคลื่อนกล้อง) แต่ห้ามเพิ่มเหตุการณ์ใหม่หรือตัวละครใหม่ที่ผู้ใช้ไม่ได้เขียน
- ฉากที่ระบุว่า "ต่อเนื่องจากฉากก่อน: ใช่": [รูป Scene i] ต้องมีบรรทัดแนบเป็น [แนบ: Scene (i-1), Character Sheet ของตัวละครในฉากนั้น] และ prompt เริ่มด้วย "Recreate the attached scene exactly — same location, same set and props, same lighting and time of day, same art style. Change only:" แล้วบอกเฉพาะสิ่งที่เปลี่ยน (ขนาดช็อต/มุมกล้อง ท่าทางและสีหน้าตัวละคร ตำแหน่งตัวละคร) ส่วนวิดีโอของฉากนั้นต้องเริ่มจากท่าทางและตำแหน่งที่ฉากก่อนจบ
- ฉากที่ระบุว่า "ไม่": เป็นภาพใหม่อิสระ ไม่ต้อง Recreate
- ถ้าเรื่องย่อ ลูกเล่น หรือหัวข้อด้านบนขัดกับฉากที่ผู้ใช้เขียน ให้ยึดฉากที่ผู้ใช้เขียนเป็นหลัก
- ช่องที่ผู้ใช้เว้นว่าง ให้เลือกเองให้เข้ากับเรื่องและต่อเนื่องจากฉากก่อนหน้า
- บทพูดของฉากไหน ใส่ในวิดีโอของฉากนั้นเท่านั้น ห้ามแก้ถ้อยคำ ห้ามเพิ่มหรือตัดประโยค ตามกฎน้ำเสียงของตัวละคร ถ้าฉากไหนไม่มีบทพูด ห้ามแต่งบทเพิ่ม`;
}

function seriesBlock(s) {
  if (!s) return '';
  const recap = (s.recap || []).filter(e => e && e.summary).map(e => `- ตอนที่ ${e.n}: ${e.summary}`).join('\n');
  return `

นี่คือซีรีส์ "${s.name}" ตอนที่ ${s.ep}${s.style ? '\nสไตล์ภาพของซีรีส์ (ห้ามเปลี่ยน): ' + s.style : ''}${s.world ? '\nโลก/สถานที่หลักของซีรีส์: ' + s.world : ''}
${recap ? 'เหตุการณ์ที่เกิดขึ้นแล้วในตอนก่อนๆ (ตอนใหม่ต้องต่อเนื่อง ห้ามขัดแย้ง ห้ามเล่าซ้ำ):\n' + recap : 'นี่คือตอนแรกของซีรีส์'}
กฎของซีรีส์:
- ตอนที่ ${s.ep} ต้องดำเนินเรื่องต่อจากเหตุการณ์ข้างบน ตัวละครมีความรู้สึกและสถานการณ์ต่อเนื่องจากตอนก่อน
- ตัวละครทุกตัวต้องมีหน้าตาและน้ำเสียงเหมือนเดิมเป๊ะตามรายชื่อตัวละคร ให้ทำ Character Sheet ของตอนนี้จากข้อความหน้าตาเดิมนั้นทุกตอน
- ท่อนสุดท้ายของตอนควรจบด้วยภาพหรือเหตุการณ์ที่ค้างให้อยากดูตอนต่อไป`;
}

function buildInstructionTH({ topic, cast = [], script = '', story = [], series = null, film = false, parts = 4, ratio = '9:16', seconds = 10, videoMode = 'auto', refs = [], part = 1 } = {}) {
  const n = Math.max(1, Number(parts) || 4);
  const ks = Array.from({ length: n + 1 }, (_, i) => 'K' + i).join(', ');
  const ing = film || videoMode === 'ingredients';
  const refLine = refsBlock(refs) + castBlock(cast) + seriesBlock(series) + storyBlock(story) + ((story || []).some(x => x && x.say) ? '' : scriptBlock(script));
  const personRef = normRefs(refs).some(r => r.kind === 'person');
  const partLine = part > 1 ? `\nนี่คือ "ช่วงที่ ${part}" ของเรื่องเดิม: เรื่อง/ตัวละคร/สไตล์ต้องต่อเนื่องจากช่วงก่อน ห้ามสร้าง Character Sheet ใหม่ (ระบบจำของเดิมไว้แล้ว อ้างชื่อ Character Sheet ใน [แนบ: …] ได้เลย) เริ่มรูปแรกของช่วงนี้ให้ต่อจากเหตุการณ์ล่าสุด\n` : '';
  const vid = ing
    ? `3) [วิดีโอ S1], [วิดีโอ S2], ... ถึง [วิดีโอ S${n}] — แบบ "องค์ประกอบ": บรรทัดที่สองของทุกกล่องเป็น [แนบ: Character Sheet, (ภาพฉากของท่อนนั้น)] prompt วิดีโอภาษาอังกฤษแบบข้อความล้วน เริ่มด้วย "SHOT: Vertical ${ratio}, ${seconds} seconds." บอกการเคลื่อนกล้อง 1 แบบ และแอ็กชันตัวละคร ถ้ามีบทพากย์ภาษาไทยให้ใส่ในเครื่องหมายคำพูด (ประมาณ 48-56 พยางค์ต่อท่อน) (ภาพในข้อ 2 จะมีกี่ใบก็ได้ ไม่ต้องเท่ากับ ${n + 1})`
    : `3) [วิดีโอ S1: K0 → K1], [วิดีโอ S2: K1 → K2], ... ถึง [วิดีโอ S${n}: K${n - 1} → K${n}] — prompt วิดีโอภาษาอังกฤษแบบข้อความล้วน เริ่มด้วย "SHOT: Vertical ${ratio}, ${seconds} seconds. The shot starts exactly on the start frame and ends exactly on the end frame." บอกการเคลื่อนกล้อง 1 แบบ และแอ็กชันตัวละคร ถ้ามีบทพากย์ภาษาไทยให้ใส่ในเครื่องหมายคำพูด (ประมาณ 48-56 พยางค์ต่อท่อน)`;
  const imgStep = film ? `2) [รูป Scene 1], [รูป Scene 2], ... ถึง [รูป Scene ${n}] (รวม ${n} รูป) — นี่คือ "สตอรี่บอร์ด": ภาพตั้งต้นของแต่ละฉากตามลำดับเรื่อง 1 ฉาก = 1 รูป = 1 วิดีโอ
   - ทุกรูปเป็นภาพใหม่ของฉากนั้น ไม่ต้อง Recreate รูปก่อนหน้า เปลี่ยนสถานที่ เวลา แสง ขนาดช็อต และมุมกล้องได้อิสระตามเรื่อง แต่ตัวละครต้องหน้าตา ผม ชุด เหมือนเดิม และสไตล์ภาพต้องเหมือนกันทุกฉาก
   - บรรทัดที่สองของทุกรูปเป็น [แนบ: Character Sheet ของตัวละครที่อยู่ในฉากนั้น${personRef ? ' หรือชื่อรูปจริงของคนนั้น' : ''}] (ถ้าฉากนั้นไม่มีตัวละคร ไม่ต้องแนบ) แล้วตามด้วย prompt ภาษาอังกฤษที่บอกครบ: สถานที่ เวลา แสง ตัวละครในภาพ (เขียนหน้าตาซ้ำ) ท่าทางและสีหน้า ขนาดช็อต มุมกล้อง สิ่งของสำคัญในฉาก` : `2) [รูป K0], [รูป K1], ... ถึง [รูป K${n}] (รวม ${n + 1} รูป: ${ks}) — ${ing ? 'ภาพฉาก/คีย์เฟรมของแต่ละท่อน' : 'คีย์เฟรมต่อเนื่องกัน'}
   - ทุกรูปที่ไม่ใช่รูปแรก ให้ใส่บรรทัดที่สองเป็น [แนบ: K(รูปก่อนหน้า), Character Sheet${personRef ? ' หรือชื่อรูปจริงของคนนั้น' : ''}] แล้วตามด้วย prompt รูปแบบ "Recreate the attached image exactly — same set, same style. Change only: ..." (บอกเฉพาะสิ่งที่เปลี่ยน)`;
  const vidStep = film ? `3) [วิดีโอ S1], [วิดีโอ S2], ... ถึง [วิดีโอ S${n}] — แบบ "องค์ประกอบ": บรรทัดที่สองของทุกกล่องเป็น [แนบ: Character Sheet ของตัวละครในฉากนั้น, Scene i] (Scene i คือรูปสตอรี่บอร์ดของฉากเดียวกัน) prompt วิดีโอภาษาอังกฤษแบบข้อความล้วน เริ่มด้วย "SHOT: Vertical ${ratio}, ${seconds} seconds." บอกการเคลื่อนกล้อง 1 แบบ แล้วบรรยายแอ็กชันเรียงตามจังหวะ (3-5 จังหวะ) พร้อมสีหน้าและท่าทางที่เปลี่ยนตามอารมณ์ ถ้ามีบทพูดภาษาไทยให้ใส่ในเครื่องหมายคำพูด (ประมาณ 48-56 พยางค์ต่อท่อน) ตามกฎน้ำเสียง แต่ละฉากเล่าเหตุการณ์เดียวให้จบในตัวเอง และฉากถัดไปต่อเรื่องตามลำดับ` : vid;
  return `ช่วยเขียน prompt สำหรับทำ${film ? 'หนังสั้น' : 'คลิป'}แนวตั้งเล่าเรื่องใน Google Flow แบบ "${ing ? 'องค์ประกอบ' : 'คีย์เฟรม'}" (เจนรูปก่อน แล้วค่อยทำวิดีโอ${ing ? 'โดยแนบรูปเป็นองค์ประกอบ' : 'โดยใช้รูปเป็นเฟรมเริ่ม/จบ'})

หัวข้อเรื่อง: ${topic || '(ผู้ใช้ยังไม่ระบุ — คิดหัวข้อที่น่าสนใจเอง)'}
จำนวนท่อน: ${n} ท่อน (ท่อนละ ${seconds} วินาที) · สัดส่วนภาพ ${ratio}${refLine}${partLine}
ตอบเป็น "กล่องโค้ด" (\`\`\`) แยกทีละกล่อง กล่องละ 1 ขั้นตอน ตามลำดับนี้ และ **บรรทัดแรกของทุกกล่องต้องเป็นแท็ก**:
${part > 1 ? '1) (ข้ามขั้น Character Sheet — ใช้ของเดิม)' : personRef ? '1) (คนที่มีรูปจริงในรายการด้านบน ใช้รูปนั้นแทน Character Sheet ไม่ต้องสร้าง) ถ้ามีตัวละครอื่นที่ไม่มีรูปจริง ให้ทำ [รูป Character Sheet ชื่อ] ให้ตัวนั้น' : '1) [รูป Character Sheet] — ภาพตัวละครหลักให้ดีไซน์นิ่ง (ถ้าเรื่องมีตัวละคร) เขียน prompt ภาษาอังกฤษต่อจากแท็ก'}
${imgStep}
${vidStep}
4) ถ้ามีบล็อกสไตล์ ให้ขึ้นต้นว่า "STYLE:" (ระบบจะข้าม ไม่นับเป็นขั้นตอน) และใส่ข้อความ STYLE ไว้ท้าย prompt แต่ละอันเอง
5) ชื่อรูปในแท็ก (เช่น [รูป L3 หน้าร้านกับรถ]) ใช้ได้เฉพาะตัวอักษร ตัวเลข และช่องว่าง ห้ามมีเครื่องหมาย + / \\ : * ? " < > | & , และต้องสะกดเหมือนเดิมเป๊ะทุกที่ที่อ้างถึงใน [แนบ: …]

${STORY_RULES}

${SAFE_RULES}

ห้ามมีข้อความอื่นแทรกระหว่างกล่อง และห้ามอธิบายเพิ่ม ตอบเฉพาะกล่องโค้ดที่เป็นข้อความตัวอักษร ห้ามสร้างหรือแสดงรูปภาพในแชต`;
}

// ให้ AI จัดข้อความที่บอทอ่านไม่ออก ให้เป็นรูปแบบที่บอทอ่านได้ (ไม่แก้เนื้อหา แค่จัดโครงสร้าง + ติดแท็ก)
function buildConvertTH(text, refs) {
  return `ด้านล่างคือข้อความสำหรับทำคลิปใน Google Flow (อาจเป็น prompt สำเร็จรูป หรือเป็นแค่คำบรรยายฉาก/เรื่องเป็นภาษาไทย) บอทอ่านรูปแบบไม่ออก ช่วยจัดเป็น "แผนเดียว" ตามโครงสร้างนี้:
- ถ้าต้นฉบับเป็น prompt สำเร็จรูปอยู่แล้ว "ห้ามแก้เนื้อหา prompt, บทพากย์ หรือ STYLE" เปลี่ยนแค่โครงสร้าง · ถ้าเป็นแค่คำบรรยายฉาก ให้เขียนเป็น prompt ภาษาอังกฤษที่ละเอียดพอสำหรับ Flow (ตัวละคร ฉาก แสง การเคลื่อนไหว กล้อง สไตล์) โดยเก็บบทพากย์ภาษาไทยไว้ในเครื่องหมายคำพูดตามต้นฉบับ
- ทุก prompt = 1 กล่องโค้ด (\`\`\`) เรียงตามลำดับการทำงานจริง: รูปทั้งหมดก่อน แล้วค่อยวิดีโอ
- บรรทัดแรกในกล่องเป็นแท็ก: รูป = [รูป ชื่อรูป] เช่น [รูป Character Sheet ชื่อตัวละคร], [รูป K0] · วิดีโอแบบองค์ประกอบ = [วิดีโอ S1], [วิดีโอ S2] ... (1 ฉาก = 1 วิดีโอ) · วิดีโอแบบเฟรม = [วิดีโอ S1: K0 → K1] (ใช้เฉพาะเมื่อต้นฉบับสั่งเป็นเฟรม)
- บรรทัดที่สองถ้า prompt ต้องแนบภาพ ให้ใส่ [แนบ: ชื่อรูป1, ชื่อรูป2] — ชื่อต้องเป็นอย่างใดอย่างหนึ่งเท่านั้น: (ก) ตรงกับแท็ก [รูป …] ของกล่องในแผนนี้เป๊ะ (ข) ชื่อรูปจริงของผู้ใช้ในรายการด้านล่าง (ถ้ามี) · ถ้าต้นฉบับอ้างรูปที่ไม่มีทั้งสองแบบ ให้เปลี่ยนเป็นชื่อที่ตรงความหมายที่สุดในรายการ หรือเพิ่มกล่อง [รูป …] สร้างรูปนั้น
- ถ้ามีตัวละครหลักที่ไม่มีรูปจริง ให้ทำ [รูป Character Sheet ชื่อ] กล่องละ 1 คน (หลายคนก็แยกกล่องคนละใบ) ก่อน แล้ววิดีโอแต่ละคลิปแนบ Character Sheet เฉพาะคนที่อยู่ในฉากนั้น (ฉากที่มีสองคน แนบทั้งสองใบ)
- บล็อกที่ขึ้นต้นว่า STYLE: ล้วนๆ ให้ใส่ไว้ท้าย prompt แต่ละอันแทน อย่าแยกเป็นกล่องเอง
- สำคัญที่สุด: ตอบเป็น "ข้อความล้วน" ในกล่องโค้ดเท่านั้น ห้ามสร้าง วาด หรือแสดงรูปภาพ/สตอรีบอร์ดในแชต (ถ้ามีคำว่าแผ่นตัวละคร ภาพ หรือฉาก ให้เขียนเป็น prompt ตัวอักษร ไม่ใช่วาดรูปให้) บอทจะเอา prompt ไปวาดเอง
- สำคัญ: ตอบ "แผนเดียว" เท่านั้น ห้ามเสนอหลายทางเลือก ห้ามมีวิดีโอเลขเดียวกันซ้ำ ห้ามมีลิงก์ คำแนะนำ หรือข้อความอื่นนอกกล่องโค้ด${refsBlock(refs)}

ข้อความต้นฉบับ:
"""
${String(text).slice(0, 60000)}
"""`;
}

// คำสั่งถาวรสั้นๆ ให้ลูกค้าแปะใน Project / Custom instructions ของ AI ตัวเองครั้งเดียว แล้วพิมพ์ "ส่งออกให้ FlowBot" ตอนจะสร้างคลิป
function buildExportSnippetTH(opts = {}) {
  const body = buildInstructionTH({ ...opts, topic: '(ตามเรื่อง ตัวละคร ฉาก และบทที่เราทำไว้ในโปรเจ็กต์/แชตนี้ — ห้ามคิดเรื่องใหม่ ห้ามเปลี่ยนดีไซน์ตัวละคร)' });
  return `[คำสั่งถาวร — สำหรับส่งงานเข้าโปรแกรม FlowBot]
เมื่อฉันพิมพ์ว่า "ส่งออกให้ FlowBot" ให้ทำตามคำสั่งด้านล่างทันที โดยใช้เรื่อง ตัวละคร ฉาก และบทที่เราคุยและตกลงกันไว้ในโปรเจ็กต์/แชตนี้เป็นต้นฉบับ
ถ้าฉันไม่ได้พิมพ์คำนั้น ให้ทำงานตามปกติของโปรเจ็กต์นี้ ไม่ต้องใช้รูปแบบนี้

----- คำสั่งส่งออก -----
${body}`;
}

function buildLightenTH(raw) {
  return `ด้านล่างคือ prompt สำหรับ Google Flow ที่อาจมีคำเสี่ยงโดนปฏิเสธ ช่วยปรับให้เบาลงและปลอดภัยขึ้น โดย
- คงแท็กบรรทัดแรก ([รูป …], [วิดีโอ …], [แนบ: …]) และโครงสร้างเดิมทุกกล่องให้เหมือนเดิมเป๊ะ
- ปรับเฉพาะเนื้อหาที่รุนแรง/เสี่ยง ให้เล่าเป็นสัญลักษณ์นุ่มๆ (ห้ามเปลี่ยนสไตล์ภาพเดิม เช่น ภาพสมจริงก็ยังสมจริง)
- คงบทพากย์ไทย ความยาว และ STYLE เดิม
- ตอบเป็นกล่องโค้ดครบทุกกล่องตามลำดับเดิม ห้ามมีข้อความอื่น

${SAFE_RULES}

${toFenced(raw)}`;
}

function buildFixOneTH(block, why) {
  return `Google Flow ปฏิเสธ prompt ด้านล่างนี้${why ? ' (ข้อความจาก Flow: ' + why + ')' : ''} ช่วยเขียนใหม่ให้เบาลงและปลอดภัยขึ้น โดย
- คงบรรทัดแท็กด้านบน ([รูป …] / [วิดีโอ …] / [แนบ: …]) ไว้เหมือนเดิมเป๊ะ
- คงโครงสร้าง ความยาว บทพากย์ และ STYLE เดิม เปลี่ยนเฉพาะส่วนที่น่าจะโดนปฏิเสธ
- ตอบเป็นกล่องโค้ดเดียว ห้ามมีข้อความอื่น

${SAFE_RULES}

\`\`\`
${block}
\`\`\``;
}

// แทนที่ segment ลำดับที่ n ด้วยบล็อกใหม่ แล้วคืน prompts.txt ใหม่
function replaceSegment(raw, n, newBlock) {
  const blocks = splitBlocks(raw);
  if (n < 1 || n > blocks.length) return raw;
  blocks[n - 1] = String(newBlock).trim();
  return blocks.join('\n\n---\n\n');
}

// ================= English mode (lang='en') =================
let LANG = 'th';
const setLang = l => { LANG = l === 'en' ? 'en' : 'th'; };
const EN_REF_KIND = { person: 'person', product: 'product', place: 'place/set', outfit: 'outfit/clothing', other: 'reference image' };
function refsBlockEN(refs) {
  refs = normRefs(refs);
  if (!refs.length) return '';
  const has = k => refs.some(r => r.kind === k);
  const rows = refs.map(r => `- image name: "${r.name}" | type: ${EN_REF_KIND[r.kind] || 'reference image'}${r.note ? ' | description: ' + String(r.note).slice(0, 120) : ''}`);
  return `

Real photos the user has already uploaded to the bot (do NOT write prompts that recreate these; just reference them by name inside [attach: …]. Use ONLY the exact text in quotes after "image name:", e.g. [attach: ${refs[0].name}] — never add the type or a description after the name):
${rows.join('\n')}
How to use the real photos:
- Every image box and video box that shows a person/product/outfit/place from this list MUST include that name in [attach: …] every time (not just the first box).${has('person') ? `
- Person: use the photo instead of a Character Sheet for that person (never make a new Character Sheet for someone with a real photo). In the prompt write "the same person as in the attached photo — same face, hairstyle and skin tone" and do not describe the face again.` : ''}${has('product') ? `
- Product: in the prompt write "exactly the product in the attached photo — same shape, color, label and logo". Do not change shape, color or label, and do not add new text on the product.` : ''}${has('outfit') ? `
- Outfit: the character wears the outfit from the attached photo, identical in every box.` : ''}
- Unless the user asks for another style, make the images look realistic like the attached photos (not cartoon).
- If the story does not use an image in the list, do not attach it.`;
}
const STORY_RULES_EN = `Short-film quality rules (so it feels like a real drama):
- Pacing: first part sets up the situation and characters → middle part adds a problem or rising tension → last part gives a resolution or a memorable closing image. One main event per part; never cram several events into one part.
- The end of each part must be a state the next part can start from directly (same position, posture, mood, light). No jumps in time, place or clothing without a reason in the story.
- Characters must look identical in every box (face, hair, outfit, held items): in every prompt, repeat a short description of each character (age, hair, outfit). Never use just "he" or "she".
- Emotion is the heart: set a main emotion for each part (e.g. wary, startled, sad, relieved) and escalate it smoothly across parts, no unmotivated swings.
- Every video prompt must describe the performance visually: facial expression (brows, eyes, mouth), where the eyes look, body posture, breathing/hesitation changing with the emotion. Never write just "looks sad" — say how it shows. Characters never stand frozen.
- Voice: define each character's voice once (age, pitch, quality) and reuse that exact text in every part where the character speaks. Every line must say how it is delivered according to the emotion (e.g. shaky whisper, faster when startled, voice fading when sad, a pause) — written in English before the quoted line.
- Walking/movement direction (very important — video AI often makes characters walk backwards or float): whenever a character walks, runs or moves, the video prompt must state clearly (1) where the camera is relative to the character, e.g. "camera behind him, we see his back" / "camera at his side" / "camera in front of him"; (2) that the character always faces the direction of travel: "walks forward, facing the direction he is moving, never walking backwards"; (3) the direction relative to the camera, e.g. "walks away from the camera into the shop" or "walks toward the camera". Never let the camera move backwards while the character walks toward it unless the user asks. If a scene opens with a character entering a place, use a camera behind or beside them as they walk in (unless the user says otherwise), and the Scene image for that scene must stage the character facing the same direction.
- Alternate shot sizes (wide/medium/close) according to emotion; one slow camera move per part.
- Light, color tone and visual style stay constant for the whole story; change only when story time truly changes.
- Any narration or dialogue must sound natural, short, match the picture of that part, and never repeat what is already visible.`;
const SAFE_RULES_EN = `Content rules (important so Google Flow does not refuse):
- Visual style: follow what the user or the existing prompt specifies; never change the style of an existing prompt. If none is specified, pick ONE style that suits the story and use it in every box: people/drama/short film/product review = cinematic realistic · kids' stories = soft 3D cartoon (do not choose cartoon on your own just because no style was given).
- No blood, wounds, corpses, weapons, violence, self-harm, sexual content or drugs.
- Never put real people's or celebrities' names in a prompt; use neutral wording instead, e.g. "an Italian runner".
- Sensitive topics (epidemics, war, disasters): tell them with soft symbols such as empty streets or people in masks; never show victims.
- No text, watermarks or logos in the image.`;
function castBlockEN(cast) {
  cast = (cast || []).filter(c => c && (c.name || c.look || c.voice));
  if (!cast.length) return '';
  const rows = cast.map((c, i) => `- Character ${i + 1}: ${c.name || '(unnamed)'} | look: ${c.look || '(AI designs it, then keeps it identical in every box)'} | voice: ${c.voice || '(AI defines it, then keeps it identical in every box)'}`);
  return `

Characters defined by the user (use exactly as given; never change the look or voice):
${rows.join('\n')}
Rules for these characters:
- Make one [Image Character Sheet Name] box per character, using the given look (except characters that have a real photo in the photo list).
- Every prompt that shows this character must repeat the given look in full.
- Every spoken line must say who speaks, and include the defined "voice" text in English, identical each time that character speaks, followed by how it is delivered for that scene's emotion, and only then the quoted line.
- If several characters are in the same part, make clear which line belongs to whom, and the voices must differ as defined.`;
}
function scriptBlockEN(script) {
  script = String(script || '').trim();
  if (!script) return '';
  return `

Dialogue defined by the user (in speaking order, format "Name: line"):
${script}
Rules for the dialogue:
- Use these exact words. Do not edit, add, remove or reorder any of the user's sentences.
- Split the dialogue across the parts in order, at most about 20-24 words per part (a sentence that does not fit goes to the next part — never shorten a sentence).
- Place each part's lines to match that part's picture and emotion, naming the speaker and delivery per the voice rules.
- If the user gave no dialogue for a part, that part has none (tell it with picture and ambient sound); never invent lines.`;
}
function storyBlockEN(story) {
  story = (story || []).filter(x => x && (x.what || x.place || x.say || x.mood || x.shot));
  if (!story.length) return '';
  const rows = story.map((x, i) => {
    const say = x.say ? '\n   Dialogue for this scene (use these exact words):\n' + String(x.say).split(/\n/).filter(Boolean).map(l => '   ' + l).join('\n') : '\n   Dialogue: none (tell it with picture and ambient sound)';
    return `Scene ${i + 1}${x.role ? ' [' + x.role + ']' : ''}
   Where/when: ${x.place || '(AI chooses to suit the story)'}
   Who is in the scene: ${(x.who || []).length ? x.who.join(', ') : '(per the story)'}
   What happens: ${x.what || '(AI continues from the previous scene to suit the story)'}
   Continues from previous scene: ${i > 0 && x.link ? 'YES — same place, same set, continuous' : 'No (new independent image)'}
   Mood of the scene: ${x.mood || '(per the story)'}
   Shot/camera angle: ${x.shot || '(AI chooses to suit the mood)'}${say}`;
  });
  return `

Scene-by-scene story written by the user (${story.length} scenes = ${story.length} parts):
${rows.join('\n')}
Rules for this story:
- Follow it in order: scene i = [Image Scene i] = [Video S i]. Never swap, skip or merge scenes; never change the user's places and events.
- You may add visual detail (posture, expression, light, props, camera move) but never add events or characters the user did not write.
- For a scene marked "Continues from previous scene: YES": [Image Scene i] must have an attach line [attach: Scene (i-1), Character Sheet of the characters in that scene] and the prompt must start with "Recreate the attached scene exactly — same location, same set and props, same lighting and time of day, same art style. Change only:" followed by only what changes (shot size/camera angle, character pose and expression, character position). The video of that scene must start from the pose and position where the previous scene ended.
- A scene marked "No" is a new independent image; no Recreate.
- If the synopsis, gimmicks or topic above conflict with the user's scenes, the user's scenes win.
- Fields the user left blank: choose what suits the story and continues from the previous scene.
- A scene's dialogue goes only into that scene's video, word for word, per the character voice rules. If a scene has no dialogue, do not invent any.`;
}
function seriesBlockEN(s) {
  if (!s) return '';
  const recap = (s.recap || []).filter(e => e && e.summary).map(e => `- Episode ${e.n}: ${e.summary}`).join('\n');
  return `

This is the series "${s.name}", episode ${s.ep}${s.style ? '\nVisual style of the series (do not change): ' + s.style : ''}${s.world ? '\nMain world/location of the series: ' + s.world : ''}
${recap ? 'What already happened in earlier episodes (the new episode must continue consistently, no contradictions, no retelling):\n' + recap : 'This is the first episode of the series.'}
Series rules:
- Episode ${s.ep} continues from the events above; characters carry their feelings and situation over from the previous episode.
- Every character must keep exactly the same look and voice as in the character list; make this episode's Character Sheets from that same look text every episode.
- The last part of the episode should end on an image or event that leaves viewers wanting the next episode.`;
}
function buildInstructionEN({ topic, cast = [], script = '', story = [], series = null, film = false, parts = 4, ratio = '9:16', seconds = 10, videoMode = 'auto', refs = [], part = 1 } = {}) {
  const n = Math.max(1, Number(parts) || 4);
  const ks = Array.from({ length: n + 1 }, (_, i) => 'K' + i).join(', ');
  const ing = film || videoMode === 'ingredients';
  const refLine = refsBlockEN(refs) + castBlockEN(cast) + seriesBlockEN(series) + storyBlockEN(story) + ((story || []).some(x => x && x.say) ? '' : scriptBlockEN(script));
  const personRef = normRefs(refs).some(r => r.kind === 'person');
  const partLine = part > 1 ? `\nThis is "part ${part}" of the same story: story/characters/style must continue from the previous part. Do NOT make a new Character Sheet (the system remembers the old one; just reference the Character Sheet name in [attach: …]). Start the first image of this part from the latest event.\n` : '';
  const words = '(about 20-24 words per part, spoken in English)';
  const vid = ing
    ? `3) [Video S1], [Video S2], ... up to [Video S${n}] — "ingredients" mode: the second line of every box is [attach: Character Sheet, (the scene image of that part)]. The video prompt is plain English text starting with "SHOT: Vertical ${ratio}, ${seconds} seconds." Give ONE camera move and the character action. Put any spoken narration/dialogue in quotation marks ${words}. (There can be any number of images in step 2; it need not equal ${n + 1}.)`
    : `3) [Video S1: K0 → K1], [Video S2: K1 → K2], ... up to [Video S${n}: K${n - 1} → K${n}] — the video prompt is plain English text starting with "SHOT: Vertical ${ratio}, ${seconds} seconds. The shot starts exactly on the start frame and ends exactly on the end frame." Give ONE camera move and the character action. Put any spoken narration/dialogue in quotation marks ${words}.`;
  const imgStep = film ? `2) [Image Scene 1], [Image Scene 2], ... up to [Image Scene ${n}] (${n} images in total) — this is the "storyboard": the starting image of each scene in story order, 1 scene = 1 image = 1 video
   - Every image is a fresh image of that scene; do not Recreate the previous image. Place, time, light, shot size and camera angle may change freely with the story, but characters must keep identical face, hair and outfit, and the visual style must be the same in every scene.
   - The second line of every image is [attach: Character Sheet of the characters in that scene${personRef ? ' or the real photo name of that person' : ''}] (no attach if no character is in the scene), followed by an English prompt covering: place, time, light, characters in the picture (repeat their look), pose and expression, shot size, camera angle, key objects in the scene.` : `2) [Image K0], [Image K1], ... up to [Image K${n}] (${n + 1} images: ${ks}) — ${ing ? 'scene image/keyframe of each part' : 'continuous keyframes'}
   - Every image except the first gets a second line [attach: K(previous image), Character Sheet${personRef ? ' or the real photo name of that person' : ''}] followed by a prompt of the form "Recreate the attached image exactly — same set, same style. Change only: ..." (state only what changes).`;
  const vidStep = film ? `3) [Video S1], [Video S2], ... up to [Video S${n}] — "ingredients" mode: the second line of every box is [attach: Character Sheet of the characters in that scene, Scene i] (Scene i is the storyboard image of the same scene). The video prompt is plain English text starting with "SHOT: Vertical ${ratio}, ${seconds} seconds." Give ONE camera move, then describe the action in beats (3-5 beats) with facial expression and posture changing with the emotion. Put any dialogue in quotation marks ${words} following the voice rules. Each scene tells one event that completes within itself, and the next scene continues the story in order.` : vid;
  return `Help me write prompts for a vertical ${film ? 'short film' : 'clip'} told as a story in Google Flow using the "${ing ? 'ingredients' : 'keyframe'}" method (generate the images first, then make the videos ${ing ? 'by attaching the images as ingredients' : 'using the images as start/end frames'}).

Topic: ${topic || '(the user has not given one — come up with an interesting topic yourself)'}
Number of parts: ${n} parts (${seconds} seconds each) · aspect ratio ${ratio}${refLine}${partLine}
Answer in separate "code blocks" (\`\`\`), one block per step, in this order, and **the first line of every block must be a tag**:
${part > 1 ? '1) (skip the Character Sheet step — reuse the existing one)' : personRef ? '1) (a person who has a real photo in the list above uses that photo instead of a Character Sheet; do not create one). If there are other characters without a real photo, make [Image Character Sheet Name] for them.' : '1) [Image Character Sheet] — a fixed-design picture of the main character (if the story has characters). Write the English prompt after the tag.'}
${imgStep}
${vidStep}
4) If there is a style block, start it with "STYLE:" (the system skips it as a step) and put the STYLE text at the end of each prompt yourself.
5) Image names inside tags (e.g. [Image L3 Storefront and Car]) may use only letters, digits and spaces — never + / \\ : * ? " < > | & , — and must be spelled identically everywhere they are referenced in [attach: …].

${STORY_RULES_EN}

${SAFE_RULES_EN}

Do not put any other text between the boxes and do not add explanations. Answer only with code blocks of plain text; never create or show images in the chat.`;
}
function buildConvertEN(text, refs) {
  return `Below is text for making a clip in Google Flow (it may be a finished prompt, or just a description of scenes/story). The bot cannot read its format. Please arrange it into ONE plan with this structure:
- If the original is already a finished prompt, do NOT change the prompt content, narration or STYLE; only change the structure. If it is only a scene description, write a detailed English prompt good enough for Flow (character, set, light, motion, camera, style), keeping any spoken narration in quotation marks as in the original.
- Every prompt = 1 code block (\`\`\`) in real working order: all images first, then the videos.
- The first line in a block is a tag: image = [Image name], e.g. [Image Character Sheet Name], [Image K0] · ingredients video = [Video S1], [Video S2] ... (1 scene = 1 video) · frames video = [Video S1: K0 → K1] (only if the original asks for frames).
- The second line, if the prompt needs attached images, is [attach: name1, name2] — each name must be either (a) exactly equal to the [Image …] tag of a box in this plan, or (b) the real photo name of the user in the list below (if any). If the original refers to an image that is neither, change it to the closest-meaning name in the list, or add an [Image …] box that creates it.
- If there is a main character without a real photo, make [Image Character Sheet Name] boxes, one per character (separate boxes for several characters), first; each video then attaches the Character Sheets only of the characters in that scene (two characters in a scene = attach both).
- A block that starts only with STYLE: goes at the end of each prompt instead; do not make it its own box.
- Most important: answer with plain text in code blocks only. Never create, draw or show images/storyboards in the chat (if the text mentions a character sheet, picture or scene, write it as a text prompt, not a drawing). The bot will draw the prompts itself.
- Important: answer with ONE plan only. No alternatives, no duplicate video numbers, no links, tips or other text outside the code blocks.${refsBlockEN(refs)}

Original text:
"""
${String(text).slice(0, 60000)}
"""`;
}
function buildExportSnippetEN(opts = {}) {
  const body = buildInstructionEN({ ...opts, topic: '(per the story, characters, scenes and script we built in this project/chat — do not invent a new story, do not change the character design)' });
  return `[Standing instruction — for sending work into the FlowBot program]
When I type "Export for FlowBot", do what is described below immediately, using the story, characters, scenes and script we discussed and agreed in this project/chat as the source.
If I don't type that phrase, work as normal for this project and do not use this format.

----- Export instruction -----
${body}`;
}
function buildLightenEN(raw) {
  return `Below are prompts for Google Flow that may contain words likely to be refused. Please make them lighter and safer by:
- keeping the first-line tags ([Image …], [Video …], [attach: …]) and the structure of every box exactly the same
- changing only violent/risky content, retelling it with soft symbols (do not change the existing visual style — realistic stays realistic)
- keeping the narration, length and STYLE as they are
- answering with all boxes as code blocks in the original order, no other text

${SAFE_RULES_EN}

${toFenced(raw)}`;
}
function buildFixOneEN(block, why) {
  return `Google Flow refused the prompt below${why ? ' (message from Flow: ' + why + ')' : ''}. Please rewrite it to be lighter and safer by:
- keeping the tag lines at the top ([Image …] / [Video …] / [attach: …]) exactly the same
- keeping the structure, length, narration and STYLE; change only the parts likely to be refused
- answering with a single code block, no other text

${SAFE_RULES_EN}

\`\`\`
${block}
\`\`\``;
}

const refsBlock = refs => LANG === 'en' ? refsBlockEN(refs) : refsBlockTH(refs);
const buildInstruction = o => LANG === 'en' ? buildInstructionEN(o) : buildInstructionTH(o);
const buildConvert = (t, r) => LANG === 'en' ? buildConvertEN(t, r) : buildConvertTH(t, r);
const buildExportSnippet = o => LANG === 'en' ? buildExportSnippetEN(o) : buildExportSnippetTH(o);
const buildLighten = r => LANG === 'en' ? buildLightenEN(r) : buildLightenTH(r);
const buildFixOne = (b, w) => LANG === 'en' ? buildFixOneEN(b, w) : buildFixOneTH(b, w);

module.exports = { setLang, isEn: () => LANG === 'en',  refsBlock, normRefs, REF_KIND, parseTag, parseBlock, splitBlocks, parseSegments, inferPipeline, normalizePrompts, countSegs, planOf, creditPerVideo, estimateCredits, riskScan, buildInstruction, buildExportSnippet, buildConvert, buildLighten, buildFixOne, replaceSegment, toFenced };
