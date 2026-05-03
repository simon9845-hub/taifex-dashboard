const { parse } = require('node-html-parser');
const fs = require('fs');
const path = require('path');
 
const URLS = {
  night: 'https://www.taifex.com.tw/cht/3/futContractsDateAh',
  day:   'https://www.taifex.com.tw/cht/3/futContractsDate',
};
 
const PRODUCTS = ['臺股期貨', '小型臺指期貨', '微型臺指期貨'];
const DIVISORS  = { '臺股期貨': 1, '小型臺指期貨': 4, '微型臺指期貨': 20 };
 
const DATA_FILE = path.join(__dirname, '..', 'docs', 'data.json');
 
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; GitHub-Actions-Bot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-TW,zh;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder('big5').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}
 
function parseTable(html) {
  const root = parse(html);
  const results = {};
  const rows = root.querySelectorAll('tr');
 
  let netColIndex = -1;
  for (const row of rows) {
    const cells = row.querySelectorAll('th, td');
    const texts = cells.map(c => c.text.trim().replace(/\s+/g, ''));
    const idx = texts.findIndex(t => t.includes('多空淨額口數'));
    if (idx !== -1) { netColIndex = idx; break; }
  }
 
  for (const product of PRODUCTS) {
    let found = false;
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;
 
      const hasProduct = cells.some(c => c.text.trim().includes(product));
      if (!hasProduct) continue;
 
      const hasSum = cells.some(c => {
        const t = c.text.trim();
        return t === '合計' || t === '小計';
      });
      if (!hasSum && found) continue;
 
      let val = null;
      if (netColIndex !== -1 && netColIndex < cells.length) {
        val = parseInt(cells[netColIndex].text.trim().replace(/,/g, ''), 10);
      } else {
        for (let i = cells.length - 1; i >= 0; i--) {
          const n = parseInt(cells[i].text.trim().replace(/,/g, ''), 10);
          if (!isNaN(n)) { val = n; break; }
        }
      }
 
      if (val !== null && !isNaN(val)) {
        results[product] = val;
        found = true;
        if (hasSum) break;
      }
    }
    if (!(product in results)) results[product] = null;
  }
 
  return results;
}
 
function calcTotal(data) {
  if (!data) return null;
  let sum = 0;
  for (const p of PRODUCTS) {
    if (data[p] === null) return null;
    sum += data[p] / DIVISORS[p];
  }
  return Math.round(sum * 100) / 100;
}
 
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { history: [] }; }
}
 
function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}
 
async function main() {
  const session = process.argv[2];
  if (!session) { console.error('用法: node fetch.js night|day|both'); process.exit(1); }
 
  const twDate = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).replace(/\//g, '-');
 
  const twTime = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
 
  const store = loadData();
 
  let today = store.history.find(r => r.date === twDate);
  if (!today) {
    today = { date: twDate, night: null, day: null, full: null, updatedAt: {} };
    store.history.unshift(today);
  }
 
  const sessions = session === 'both' ? ['night', 'day'] : [session];
  let anyDataWritten = false;
 
  for (const s of sessions) {
    const url = URLS[s === 'night' ? 'night' : 'day'];
    console.log(`\n[${s}] 擷取 ${url}`);
    try {
      const html = await fetchHtml(url);
      const raw  = parseTable(html);
      console.log('[解析結果]', raw);
 
      const allNull = PRODUCTS.every(p => raw[p] === null);
      if (allNull) {
        console.log(`[${s}] 所有商品皆為 null，今日可能為非交易日，略過不寫入`);
        continue;
      }
 
      const total = calcTotal(raw);
      console.log(`[合計] ${total}`);
 
      const key = s === 'night' ? 'night' : 'full';
      today[key] = { raw, total };
      today.updatedAt[key] = `${twDate} ${twTime}`;
      anyDataWritten = true;
 
      if (today.night?.total !== null && today.night?.total !== undefined &&
          today.full?.total !== null && today.full?.total !== undefined) {
        today.day = {
          total: Math.round((today.full.total - today.night.total) * 100) / 100,
        };
        today.updatedAt.day = `${twDate} ${twTime}`;
      }
    } catch (err) {
      console.error(`[錯誤] ${s}:`, err.message);
      process.exit(1);
    }
  }
 
  // 移除完全沒有任何資料的記錄
  store.history = store.history.filter(r => r.night !== null || r.full !== null);
 
  // 只保留最近 30 筆
  store.history = store.history.slice(0, 30);
 
  if (anyDataWritten) {
    store.lastUpdated = `${twDate} ${twTime}`;
    console.log('\n✅ data.json 已更新');
  } else {
    console.log('\n⚠️ 今日無交易資料，data.json 不更新');
  }
 
  saveData(store);
}
 
main();
