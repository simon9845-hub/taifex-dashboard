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

// ── 取得 HTML ──────────────────────────────────────────────────────────────
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
  // 期交所回傳 Big5，Node 18+ fetch 有時會誤判，用 TextDecoder 強制解碼
  try {
    return new TextDecoder('big5').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// ── 解析表格 ───────────────────────────────────────────────────────────────
function parseTable(html) {
  const root = parse(html);
  const results = {};

  // 找所有 <tr>，從中找出含目標商品名稱的列
  const rows = root.querySelectorAll('tr');

  // 先找標頭列，確定「多空淨額口數」的欄位 index
  let netColIndex = -1;
  for (const row of rows) {
    const cells = row.querySelectorAll('th, td');
    const texts = cells.map(c => c.text.trim().replace(/\s+/g, ''));
    const idx = texts.findIndex(t => t.includes('多空淨額口數'));
    if (idx !== -1) { netColIndex = idx; break; }
  }

  // 找各商品對應的「自營商+投信+外資合計」列
  // 期交所格式：每個商品有多列（自營商/投信/外資/合計），取「合計」列
  for (const product of PRODUCTS) {
    let found = false;
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;
      const texts = cells.map(c => c.text.trim().replace(/[\s,]/g, ''));

      // 確認此列含有商品名
      const hasProduct = cells.some(c => c.text.trim().includes(product));
      if (!hasProduct) continue;

      // 尋找「合計」身份欄
      const hasSum = cells.some(c => {
        const t = c.text.trim();
        return t === '合計' || t === '小計';
      });
      if (!hasSum && found) continue; // 已找到合計則跳過後續列

      // 取「多空淨額口數」欄
      let val = null;
      if (netColIndex !== -1 && netColIndex < cells.length) {
        val = parseInt(cells[netColIndex].text.trim().replace(/,/g, ''), 10);
      } else {
        // fallback：取最後幾個有數字的欄位中的第一個負正數
        for (let i = cells.length - 1; i >= 0; i--) {
          const n = parseInt(cells[i].text.trim().replace(/,/g, ''), 10);
          if (!isNaN(n)) { val = n; break; }
        }
      }

      if (val !== null && !isNaN(val)) {
        results[product] = val;
        found = true;
        if (hasSum) break; // 找到合計列就不再找
      }
    }
    if (!(product in results)) results[product] = null;
  }

  return results;
}

// ── 計算合計 ───────────────────────────────────────────────────────────────
function calcTotal(data) {
  if (!data) return null;
  let sum = 0;
  for (const p of PRODUCTS) {
    if (data[p] === null) return null;
    sum += data[p] / DIVISORS[p];
  }
  return Math.round(sum * 100) / 100;
}

// ── 讀寫 data.json ─────────────────────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { history: [] }; }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  const session = process.argv[2]; // 'night' | 'day' | 'both'
  if (!session) { console.error('用法: node fetch.js night|day|both'); process.exit(1); }

  const twDate = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).replace(/\//g, '-');

  const twTime = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());

  const store = loadData();

  // 找或建立今日記錄
  let today = store.history.find(r => r.date === twDate);
  if (!today) {
    today = { date: twDate, night: null, day: null, full: null, updatedAt: {} };
    store.history.unshift(today);
  }

  const sessions = session === 'both' ? ['night', 'day'] : [session];

  for (const s of sessions) {
    const url = URLS[s === 'night' ? 'night' : 'day'];
    console.log(`\n[${s}] 擷取 ${url}`);
    try {
      const html = await fetchHtml(url);
      const raw  = parseTable(html);
      console.log('[解析結果]', raw);

      const total = calcTotal(raw);
      console.log(`[合計] ${total}`);

      const key = s === 'night' ? 'night' : 'full';
      today[key] = { raw, total };
      today.updatedAt[key] = `${twDate} ${twTime}`;

      // 如果夜盤與全日都有，計算日盤
      if (today.night?.total !== undefined && today.night?.total !== null &&
          today.full?.total !== undefined && today.full?.total !== null) {
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

  // 只保留最近 30 筆
  store.history = store.history.slice(0, 30);
  store.lastUpdated = `${twDate} ${twTime}`;

  saveData(store);
  console.log('\n✅ data.json 已更新');
}

main();
