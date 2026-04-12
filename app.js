'use strict';

/* ============================================================
   CDR_Stock — app.js
   ============================================================ */

// ─── Config ──────────────────────────────────────────────────
const CFG = {
  RSS_PROXY:      'https://api.rss2json.com/v1/api.json?rss_url=',
  TV_SEARCH:      'https://symbol-search.tradingview.com/symbol_search/v3/',
  CORS:           'https://corsproxy.io/?url=',
  CACHE_MS:       5 * 60 * 1000,
  REFRESH_MS:     5 * 60 * 1000,
  MARKET_REFRESH: 3 * 60 * 1000,   // 3분마다 갱신
  NEWS_LIMIT:     35,
  SEARCH_DELAY:   360,
};

// ─── 시장현황 항목 정의 ───────────────────────────────────────
// type: 'tv'  → TradingView single-quote 위젯 (지수·환율·VIX)
// type: 'fng' → alternative.me 공포탐욕지수
// type: 'er'  → open.er-api.com 환율 (fallback)
const MARKET_ITEMS = [
  // type:'api' → Stooq 무료 API (KRX/CBOE 임베드 제한 우회)
  { id: 'kospi',  label: 'KOSPI',           type: 'api', stooq: '%5eks11' },
  { id: 'kosdaq', label: 'KOSDAQ',          type: 'api', stooq: '%5ekq11' },
  // type:'tv'  → TradingView 단일 시세 위젯 (미국 지수·환율)
  { id: 'sp500',  label: 'S&P 500',         type: 'tv',  tvSym: 'FOREXCOM:SPXUSD' },
  { id: 'nasdaq', label: 'NASDAQ',          type: 'tv',  tvSym: 'FOREXCOM:NSXUSD' },
  { id: 'usdkrw', label: '원 / 달러',       type: 'tv',  tvSym: 'FX_IDC:USDKRW' },
  { id: 'jpykrw', label: '원 / 엔 (100엔)', type: 'tv',  tvSym: 'FX_IDC:JPYKRW' },
  { id: 'vix',    label: 'VIX',             type: 'api', stooq: '%5evix' },
  { id: 'fng',    label: '공포탐욕지수',    type: 'fng' },
];

// ─── 뉴스 소스 ───────────────────────────────────────────────
const NEWS_SOURCES = {
  hankyung:    { name: '한국경제',    url: 'https://www.hankyung.com/feed/economy' },
  marketwatch: { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  cnbc:        { name: 'CNBC',        url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html' },
};

// ─── 코인 검색 거래소 설정 ────────────────────────────────────
const COIN_CFG = {
  'coin-gl': { exchange: 'BINANCE',      defaultSuffix: 'USDT', tz: 'UTC' },
  'coin-kr': { exchange: 'UPBIT,BITHUMB', defaultSuffix: 'KRW',  tz: 'Asia/Seoul' },
};

// ─── 잘못된 심볼 정리 ────────────────────────────────────────
function cleanCharts(arr) {
  return arr.filter(c => {
    const sym = (c.symbol || '').replace(/^[A-Z]+:/i, '');
    return /^[A-Z0-9.\-]+$/i.test(sym);
  });
}

// ─── localStorage ─────────────────────────────────────────────
function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// 정리 후 즉시 저장 (이전 세션의 오염된 심볼 제거)
const _cleaned = {
  kr:      cleanCharts(load('kr-charts')),
  us:      cleanCharts(load('us-charts')),
  'coin-gl': cleanCharts(load('coin-gl-charts')),
  'coin-kr': cleanCharts(load('coin-kr-charts')),
};
Object.keys(_cleaned).forEach(k => save(`${k}-charts`, _cleaned[k]));

// ─── State ───────────────────────────────────────────────────
const S = {
  news: { kr: { src: 'hankyung' }, us: { src: 'marketwatch' } },
  cache: {},
  charts: { ..._cleaned },
  searchTimer: null,
};

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initMainTabs();
  initSubTabs();
  initNewsSources();
  initNewsRefresh();
  initChartSearch(['kr', 'us', 'coin-gl', 'coin-kr']);
  initClearBtn('clear-charts-btn', ['kr', 'us']);
  initClearBtn('clear-coin-btn',   ['coin-gl', 'coin-kr']);
  initMarket();

  fetchNews('kr', S.news.kr.src);
  fetchNews('us', S.news.us.src);
  setInterval(() => fetchNews('kr', S.news.kr.src), CFG.REFRESH_MS);
  setInterval(() => fetchNews('us', S.news.us.src), CFG.REFRESH_MS);

  restoreCharts();
});

// ─── Clock ───────────────────────────────────────────────────
function initClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const tick = () => el.textContent = new Date().toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  tick(); setInterval(tick, 1000);
}

// ─── Tab management ───────────────────────────────────────────
function initMainTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${btn.dataset.tab}-tab`).classList.add('active');
    });
  });
}

function initSubTabs() {
  ['news-tab', 'chart-tab', 'coin-tab'].forEach(id => {
    const sec = document.getElementById(id);
    if (!sec) return;
    sec.querySelectorAll('.sub-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sec.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
        sec.querySelectorAll('.sub-tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.subtab)?.classList.add('active');
      });
    });
  });
}

// ─── News ─────────────────────────────────────────────────────
function initNewsSources() {
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const region = btn.dataset.region, src = btn.dataset.source;
      document.querySelectorAll(`.source-btn[data-region="${region}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.news[region].src = src;
      fetchNews(region, src, true);
    });
  });
}

function initNewsRefresh() {
  document.getElementById('news-refresh-btn')?.addEventListener('click', function () {
    this.classList.add('spinning');
    const region = document.getElementById('kr-news')?.classList.contains('active') ? 'kr' : 'us';
    fetchNews(region, S.news[region].src, true).finally(() => this.classList.remove('spinning'));
  });
}

async function fetchNews(region, src, force = false) {
  const key = `${region}_${src}`;
  const listEl = document.getElementById(`${region}-news-list`);
  const srcCfg = NEWS_SOURCES[src];
  if (!listEl || !srcCfg) return;

  if (!force) {
    const c = S.cache[key];
    if (c && Date.now() - c.ts < CFG.CACHE_MS) { renderNews(listEl, c.items); return; }
  }

  listEl.innerHTML = `<div class="news-loading"><div class="spinner"></div><span>뉴스 불러오는 중...</span></div>`;

  try {
    const res  = await fetch(`${CFG.RSS_PROXY}${encodeURIComponent(srcCfg.url)}`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || '피드 오류');
    if (!data.items?.length) throw new Error('항목 없음');
    const items = data.items.slice(0, CFG.NEWS_LIMIT);
    S.cache[key] = { ts: Date.now(), items };
    renderNews(listEl, items);
  } catch (err) {
    listEl.innerHTML = `<div class="news-error"><div>⚠ 뉴스를 불러오지 못했습니다</div><small>${esc(err.message)}</small><button class="retry-btn" onclick="fetchNews('${region}','${src}',true)">다시 시도</button></div>`;
  }
}

function renderNews(listEl, items) {
  listEl.innerHTML = '';
  items.forEach(item => {
    const a = document.createElement('a');
    a.className = 'news-item';
    a.href = item.link || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.innerHTML = `<span class="news-title">${esc(item.title || '제목 없음')}</span>
      <span class="news-meta"><span class="news-time">${relTime(item.pubDate)}</span></span>`;
    listEl.appendChild(a);
  });
}

function relTime(dateStr) {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
    if (m < 1) return '방금 전'; if (m < 60) return `${m}분 전`;
    if (h < 24) return `${h}시간 전`; if (d < 7) return `${d}일 전`;
    return new Date(dateStr).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// ─── Market Overview ──────────────────────────────────────────
function initMarket() {
  buildMarketCards();
  fetchFearGreed();
  fetchAllAPIMarket();
  setInterval(fetchFearGreed,   CFG.MARKET_REFRESH);
  setInterval(fetchAllAPIMarket, CFG.MARKET_REFRESH);

  document.getElementById('market-refresh-btn')?.addEventListener('click', function () {
    this.classList.add('spinning');
    Promise.all([fetchFearGreed(), fetchAllAPIMarket()])
      .finally(() => setTimeout(() => this.classList.remove('spinning'), 800));
    const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const el = document.getElementById('market-updated');
    if (el) el.textContent = now + ' 갱신';
  });
}

// ─── Stooq API: KOSPI·KOSDAQ·VIX ─────────────────────────────
// 시도 순서: ① Stooq 직접 → ② allorigins 프록시 → ③ localStorage 캐시
async function fetchAPIMarketItem(item) {
  const valEl = document.getElementById(`mv-${item.id}`);
  const chgEl = document.getElementById(`mc2-${item.id}`);
  const card  = document.getElementById(`mc-${item.id}`);
  if (!valEl || !chgEl || !card) return;

  const stooqUrl = `https://stooq.com/q/l/?s=${item.stooq}&f=sd2t2ohlcv&e=json`;

  // Stooq JSON 파싱 (직접 또는 프록시 응답 공통)
  function parseSym(data) {
    const sym = data?.symbols?.[0];
    if (!sym) return null;
    const c = parseFloat(sym.c);
    const o = parseFloat(sym.o);
    if (isNaN(c) || c === 0) return null;       // N/D 또는 0이면 무효
    return { close: c, open: isNaN(o) ? c : o, date: sym.d };
  }

  let parsed = null;

  // ① Stooq 직접 접속 (CORS 허용 시 가장 빠름)
  if (!parsed) {
    try {
      const res  = await fetch(stooqUrl, { signal: AbortSignal.timeout(7000) });
      const data = await res.json();
      parsed = parseSym(data);
    } catch { /* CORS 차단 등 — 다음 방법 시도 */ }
  }

  // ② allorigins.win 프록시
  if (!parsed) {
    try {
      const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(stooqUrl)}`;
      const res   = await fetch(proxy, { signal: AbortSignal.timeout(10000) });
      const data  = await res.json();
      parsed = parseSym(data);
    } catch { /* 프록시도 실패 */ }
  }

  // 데이터 획득 성공 → 화면 표시 + 캐시 저장
  if (parsed) {
    const { close, open, date } = parsed;
    const change = close - open;
    const pct    = open ? (change / open) * 100 : 0;
    const sign   = change >= 0 ? '+' : '';

    // localStorage에 마지막 성공 데이터 저장
    save(`mkt-${item.id}`, { close, open, change, pct, date });

    card.classList.remove('positive', 'negative');
    card.classList.add(change >= 0 ? 'positive' : 'negative');
    valEl.innerHTML = `<span>${close.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</span>`;
    chgEl.innerHTML = `<span class="chg-amt">${sign}${change.toFixed(2)}</span>
      <span class="chg-pct">(${sign}${pct.toFixed(2)}%)</span>`;

    const upEl = document.getElementById('market-updated');
    if (upEl) upEl.textContent = new Date().toLocaleTimeString('ko-KR',
      { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return;
  }

  // ③ 캐시에서 마지막 종가 표시 (장 마감·주말)
  const cached = load(`mkt-${item.id}`);
  if (cached && cached.close) {
    const { close, change, pct, date } = cached;
    const sign = change >= 0 ? '+' : '';
    card.classList.remove('positive', 'negative');
    card.classList.add(change >= 0 ? 'positive' : 'negative');
    valEl.innerHTML = `<span>${close.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</span>`;
    chgEl.innerHTML = `<span class="chg-amt">${sign}${change.toFixed(2)}</span>
      <span class="chg-pct">(${sign}${pct.toFixed(2)}%)</span>
      <span class="cached-label">${date ? date + ' 종가' : '마지막 종가'}</span>`;
    return;
  }

  // 캐시도 없음 (최초 실행 + 네트워크 실패)
  valEl.innerHTML = `<span style="color:var(--text-3)">—</span>`;
  chgEl.innerHTML = `<span style="color:var(--text-3);font-size:11px">데이터 없음</span>`;
}

function fetchAllAPIMarket() {
  return Promise.all(
    MARKET_ITEMS.filter(i => i.type === 'api').map(item => fetchAPIMarketItem(item))
  );
}

function buildMarketCards() {
  const grid = document.getElementById('market-grid');
  if (!grid) return;
  grid.innerHTML = '';

  MARKET_ITEMS.forEach(item => {
    const card = document.createElement('div');
    card.className = 'market-card';
    card.id = `mc-${item.id}`;

    if (item.type === 'tv') {
      // TradingView single-quote 위젯 카드 (미국 지수·환율)
      card.classList.add('tv-quote-card');
      card.innerHTML = `<div class="market-card-label">${item.label}</div>
        <div class="tv-sq-wrap" id="tv-sq-${item.id}"></div>`;
      grid.appendChild(card);
      setTimeout(() => injectTVQuote(item), 0);
    } else if (item.type === 'api' || item.type === 'fng') {
      // Stooq API 카드 (KOSPI·KOSDAQ·VIX) + 공포탐욕지수 카드
      card.innerHTML = `
        <div class="market-card-label">${item.label}</div>
        <div class="market-card-value" id="mv-${item.id}"><div class="market-skeleton skel-value"></div></div>
        <div class="market-card-change" id="mc2-${item.id}"><div class="market-skeleton skel-change"></div></div>`;
      grid.appendChild(card);
    }
  });

  // 업데이트 시각 초기 표시
  const el = document.getElementById('market-updated');
  if (el) el.textContent = 'TV 위젯 실시간 · 데이터 로딩 중';
}

function injectTVQuote(item) {
  const wrap = document.getElementById(`tv-sq-${item.id}`);
  if (!wrap) return;

  // file:// 환경에서 script-inject 방식은 TV가 자신을 DOM에서 못 찾는 문제 발생.
  // 직접 iframe URL로 삽입하면 어디서 열어도 안정적으로 동작함.
  const cfg = encodeURIComponent(JSON.stringify({
    symbol:        item.tvSym,
    width:         '100%',
    colorTheme:    'dark',
    isTransparent: true,
    locale:        'ko',
  }));
  const src = `https://s.tradingview.com/embed-widget/single-quote/?locale=ko#${cfg}`;

  const iframe = document.createElement('iframe');
  iframe.src             = src;
  iframe.style.width     = '100%';
  iframe.style.height    = '90px';
  iframe.style.border    = 'none';
  iframe.style.overflow  = 'hidden';
  iframe.allowtransparency = 'true';
  iframe.scrolling       = 'no';
  iframe.frameBorder     = '0';

  wrap.appendChild(iframe);
}

async function fetchFearGreed() {
  try {
    const res  = await fetch('https://api.alternative.me/fng/', { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const fng  = data.data?.[0];
    if (!fng) throw new Error('no data');

    const score  = parseInt(fng.value, 10);
    const rating = fng.value_classification;

    const card  = document.getElementById('mc-fng');
    const valEl = document.getElementById('mv-fng');
    const chgEl = document.getElementById('mc2-fng');
    if (!card || !valEl || !chgEl) return;

    const color = score < 25 ? '#ff4d4d'
                : score < 45 ? '#ff8c00'
                : score < 55 ? '#f5a623'
                : score < 75 ? '#00c896' : '#00c896';
    const cls   = score < 25 ? 'fng-extreme-fear'
                : score < 45 ? 'fng-fear'
                : score < 55 ? 'fng-neutral'
                : score < 75 ? 'fng-greed' : 'fng-extreme-greed';

    card.className = `market-card ${cls}`;
    valEl.innerHTML = `<span class="fng-score" style="color:${color}">${score}</span>`;
    chgEl.innerHTML = `<span class="fng-rating" style="color:${color}">${esc(rating)}</span>`;

    const el = document.getElementById('market-updated');
    if (el) el.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    const valEl = document.getElementById('mv-fng');
    const chgEl = document.getElementById('mc2-fng');
    if (valEl) valEl.textContent = '—';
    if (chgEl) chgEl.textContent = 'F&G 로드 실패';
  }
}

// ─── Chart + Coin Search ──────────────────────────────────────
function initChartSearch(regions) {
  regions.forEach(region => {
    const input  = document.getElementById(`${region}-search`);
    const btn    = document.getElementById(`${region}-search-btn`);
    const dropEl = document.getElementById(`${region}-search-results`);
    if (!input || !btn || !dropEl) return;

    input.addEventListener('input', () => {
      clearTimeout(S.searchTimer);
      const q = input.value.trim();
      if (!q) { dropEl.innerHTML = ''; return; }
      S.searchTimer = setTimeout(() => searchSymbol(region, q), CFG.SEARCH_DELAY);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        clearTimeout(S.searchTimer);
        const q = input.value.trim(); if (!q) return;
        const first = dropEl.querySelector('.search-result-item[data-symbol]');
        if (first) { first.click(); return; }
        // 한국 주식 탭에서 한글 직접 입력 차단
        if (region === 'kr' && /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(q)) {
          toast('종목코드(숫자)로 검색하세요 · 예: 005930', 'error');
          searchSymbol(region, q); // 검색 결과는 보여줌
          return;
        }
        addChart(region, buildSymbol(region, q), q.toUpperCase());
        input.value = ''; dropEl.innerHTML = '';
      }
      if (e.key === 'Escape') dropEl.innerHTML = '';
    });
    btn.addEventListener('click', () => { const q = input.value.trim(); if (q) searchSymbol(region, q); });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-bar'))
      document.querySelectorAll('.search-dropdown').forEach(d => d.innerHTML = '');
  });
}

const EXCHANGE_MAP = {
  'kr':      'KRX',
  'us':      'NASDAQ,NYSE,AMEX',
  'coin-gl': 'BINANCE,COINBASE,BYBIT',
  'coin-kr': 'UPBIT,BITHUMB',
};
const TYPE_MAP = {
  'kr': 'stock', 'us': 'stock', 'coin-gl': 'crypto', 'coin-kr': 'crypto',
};

async function searchSymbol(region, query) {
  const dropEl   = document.getElementById(`${region}-search-results`);
  const exchange = EXCHANGE_MAP[region] || 'NASDAQ';
  const type     = TYPE_MAP[region]     || 'stock';

  dropEl.innerHTML = `<div class="search-result-list"><div class="search-msg">검색 중...</div></div>`;

  try {
    const fullUrl = `${CFG.TV_SEARCH}?text=${encodeURIComponent(query)}&exchange=${exchange}&type=${type}&domain=production`;
    let data;
    // 검색 프록시: 직접 → codetabs → allorigins 순서로 시도
    const proxies = [
      fullUrl,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(fullUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(fullUrl)}`,
    ];
    for (const p of proxies) {
      try {
        const res = await fetch(p, { signal: AbortSignal.timeout(7000) });
        data = await res.json();
        if (Array.isArray(data)) break;
      } catch {}
    }

    if (!Array.isArray(data) || !data.length) {
      dropEl.innerHTML = `<div class="search-result-list"><div class="search-msg">결과 없음 — Enter로 직접 추가</div></div>`;
      return;
    }

    const list = document.createElement('div');
    list.className = 'search-result-list';
    data.slice(0, 10).forEach(item => {
      const fullSym = `${item.exchange}:${item.symbol}`;
      const name    = item.description || item.full_name || item.symbol;
      const display = `${name}(${item.symbol})`;
      const div = document.createElement('div');
      div.className = 'search-result-item';
      div.dataset.symbol = fullSym;
      div.innerHTML = `<span class="result-name">${esc(display)}</span><span class="result-exchange">${esc(item.exchange || '')}</span>`;
      div.addEventListener('click', () => {
        addChart(region, fullSym, display);
        dropEl.innerHTML = '';
        const inp = document.getElementById(`${region}-search`);
        if (inp) inp.value = '';
      });
      list.appendChild(div);
    });
    dropEl.innerHTML = ''; dropEl.appendChild(list);

  } catch {
    // 한국 주식 탭에서 한글 검색 실패 시 → 코드 입력 안내만 표시
    if (region === 'kr' && /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query)) {
      dropEl.innerHTML = `<div class="search-result-list">
        <div class="search-msg">검색 연결 실패 — <b>숫자 종목코드</b>로 입력하세요<br>
        <span style="color:var(--text-3);font-size:11px">삼성전자→005930 · SK하이닉스→000660 · 카카오→035720</span></div>
      </div>`;
      return;
    }
    const sym = buildSymbol(region, query);
    dropEl.innerHTML = `<div class="search-result-list"><div class="search-result-item" data-symbol="${esc(sym)}" id="direct-${region}">
      <span class="result-name">${esc(query.toUpperCase())} — 직접 추가</span>
      <span class="result-exchange">${exchange.split(',')[0]}</span></div></div>`;
    document.getElementById(`direct-${region}`)?.addEventListener('click', () => {
      addChart(region, sym, query.toUpperCase()); dropEl.innerHTML = '';
      const inp = document.getElementById(`${region}-search`); if (inp) inp.value = '';
    });
  }
}

function buildSymbol(region, raw) {
  const q = raw.toUpperCase().trim();
  if (q.includes(':')) return q;
  if (region === 'kr')      return `KRX:${q}`;
  if (region === 'us')      return `NASDAQ:${q}`;
  if (region === 'coin-gl') return `BINANCE:${q}USDT`;
  if (region === 'coin-kr') return `UPBIT:${q}KRW`;
  return q;
}

// ─── 한국 주식 차트: Lightweight Charts + 네이버금융 API ───────
async function renderKRChart(entry) {
  const grid = document.getElementById('kr-charts-grid');
  if (!grid) return;
  updateEmptyState('kr');

  // 종목코드 추출: KRX:005930 → 005930
  const ticker = entry.symbol.replace(/^[A-Z]+:/i, '').trim();

  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = `card_${entry.id}`;
  card.innerHTML = `
    <div class="chart-header">
      <div class="chart-info">
        <span class="chart-name">${esc(entry.name)}</span>
        <span class="chart-symbol">${esc(entry.symbol)}</span>
        <span class="chart-interval-tag">일봉</span>
      </div>
      <button class="delete-btn" title="차트 삭제">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
        </svg>
      </button>
    </div>
    <div class="chart-widget-wrap kr-lw-chart" id="${entry.id}"></div>`;

  card.querySelector('.delete-btn').addEventListener('click',
    () => removeChart('kr', entry.symbol, entry.id));
  grid.appendChild(card);

  const container = document.getElementById(entry.id);

  // 한글 심볼 감지 (검색 대신 한글 직접 입력한 경우)
  if (!/^\d+$/.test(ticker)) {
    container.innerHTML = `
      <div class="chart-error">
        ⚠ 숫자 종목코드로 검색해 주세요<br>
        <small>삼성전자 → <b>005930</b> · SK하이닉스 → <b>000660</b></small><br>
        <small style="color:var(--text-3);margin-top:4px;display:block">검색창에 숫자 코드 입력 후 결과 클릭</small>
      </div>`;
    return;
  }

  // ── 데이터 fetch: 네이버금융 fchart → Stooq (.KS/.KQ) 순서로 시도 ──
  let ohlc = null;

  // 1순위: 네이버금융 fchart XML API (codetabs 프록시)
  const naverUrl = `https://fchart.stock.naver.com/sise.nhn?symbol=${ticker}&timeframe=day&count=300&requestType=0`;
  for (const p of [
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(naverUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(naverUrl)}`,
    naverUrl,
  ]) {
    try {
      const res  = await fetch(p, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      // 네이버 fchart: <item data="20260411|72100|73000|71500|72500|12345678"/>
      const matches = [...text.matchAll(/data="(\d{8})\|(\d+)\|(\d+)\|(\d+)\|(\d+)/g)];
      if (matches.length >= 5) {
        ohlc = matches.map(m => ({
          time:  `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`,
          open: +m[2], high: +m[3], low: +m[4], close: +m[5],
        })).sort((a, b) => a.time < b.time ? -1 : 1);
        break;
      }
    } catch {}
  }

  // 2순위: Stooq CSV (.KS / .KQ)
  if (!ohlc) {
    outer: for (const suffix of ['.KS', '.KQ']) {
      const stooqUrl = `https://stooq.com/q/d/l/?s=${ticker}${suffix}&i=d`;
      for (const p of [
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(stooqUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(stooqUrl)}`,
        stooqUrl,
      ]) {
        try {
          const res  = await fetch(p, { signal: AbortSignal.timeout(9000) });
          const text = await res.text();
          const lines = text.trim().split('\n');
          if (lines.length < 3 || text.includes('No data') || text.startsWith('<')) continue;
          const hdr  = lines[0].toLowerCase().split(',');
          const iD   = hdr.indexOf('date'), iO = hdr.indexOf('open'),
                iH   = hdr.indexOf('high'), iL = hdr.indexOf('low'), iC = hdr.indexOf('close');
          const rows = lines.slice(1).map(l => {
            const c = l.split(',');
            return { time: c[iD], open: +c[iO], high: +c[iH], low: +c[iL], close: +c[iC] };
          }).filter(d => d.time && !isNaN(d.close) && d.close > 0)
            .sort((a, b) => a.time < b.time ? -1 : 1).slice(-250);
          if (rows.length >= 5) { ohlc = rows; break outer; }
        } catch {}
      }
    }
  }

  if (!ohlc || !ohlc.length) {
    container.innerHTML = `
      <div class="chart-error">
        ⚠ 데이터 로드 실패 (${esc(ticker)})<br>
        <small style="color:var(--text-3)">네트워크 확인 후 재시도하세요</small><br>
        <a href="https://finance.naver.com/item/main.naver?code=${esc(ticker)}"
           target="_blank" style="color:var(--green);font-size:12px;margin-top:8px;display:inline-block">
          네이버 금융에서 보기 ↗</a>
      </div>`;
    return;
  }

  // Lightweight Charts 렌더링 (v4.2.0 고정)
  try {
    const chart = LightweightCharts.createChart(container, {
      width:  container.clientWidth || 500,
      height: 320,
      layout: { background: { color: '#18181f' }, textColor: '#9898b0' },
      grid:   { vertLines: { color: '#2a2a36' }, horzLines: { color: '#2a2a36' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#2a2a36' },
      timeScale: { borderColor: '#2a2a36', timeVisible: true },
      handleScroll: true, handleScale: true,
    });

    // v4: addCandlestickSeries / v5+: addSeries(CandlestickSeries)
    const seriesOpts = {
      upColor: '#00c896', downColor: '#ff4d4d',
      borderUpColor: '#00c896', borderDownColor: '#ff4d4d',
      wickUpColor: '#00c896', wickDownColor: '#ff4d4d',
    };
    const series = typeof chart.addCandlestickSeries === 'function'
      ? chart.addCandlestickSeries(seriesOpts)
      : chart.addSeries(LightweightCharts.CandlestickSeries, seriesOpts);

    series.setData(ohlc);
    chart.timeScale().fitContent();

    new ResizeObserver(entries => {
      if (entries[0]) chart.applyOptions({ width: entries[0].contentRect.width });
    }).observe(container);
  } catch (e) {
    container.innerHTML = `
      <div class="chart-error">⚠ 차트 렌더링 실패<br>
      <small style="color:var(--text-3)">${esc(String(e))}</small><br>
      <a href="https://finance.naver.com/item/main.naver?code=${esc(ticker)}"
         target="_blank" style="color:var(--green);font-size:12px;margin-top:8px;display:inline-block">
        네이버 금융에서 보기 ↗</a></div>`;
  }
}

// ─── Chart: add / render / remove ─────────────────────────────
async function addChart(region, symbol, name) {
  const arr = S.charts[region];
  if (!arr) return;
  if (arr.find(c => c.symbol === symbol)) { toast(`${symbol} 은(는) 이미 추가되어 있습니다`); return; }

  const entry = { symbol, name: name || symbol, id: `tv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` };
  arr.push(entry);
  saveCharts(region);
  await renderChart(region, entry);
  toast(`${name} 차트 추가`, 'success');
}

async function renderChart(region, entry) {
  // 한국 주식은 로그인 불필요한 Lightweight Charts + Stooq 방식으로 처리
  if (region === 'kr') { await renderKRChart(entry); return; }

  await ensureTradingView();
  if (!window.TradingView) { toast('TradingView를 불러올 수 없습니다', 'error'); return; }

  const gridId = `${region}-charts-grid`;
  const grid = document.getElementById(gridId);
  if (!grid) return;
  updateEmptyState(region);

  const isCoin = region.startsWith('coin-');
  const tz     = isCoin ? (COIN_CFG[region]?.tz || 'UTC')
               : region === 'kr' ? 'Asia/Seoul' : 'America/New_York';
  const locale = region === 'kr' ? 'ko' : 'en';

  const card = document.createElement('div');
  card.className = 'chart-card'; card.id = `card_${entry.id}`;
  card.innerHTML = `
    <div class="chart-header">
      <div class="chart-info">
        <span class="chart-name">${esc(entry.name)}</span>
        <span class="chart-symbol">${esc(entry.symbol)}</span>
        <span class="chart-interval-tag">1분</span>
      </div>
      <button class="delete-btn" title="차트 삭제">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
        </svg>
      </button>
    </div>
    <div class="chart-widget-wrap" id="${entry.id}"></div>`;

  card.querySelector('.delete-btn').addEventListener('click', () => removeChart(region, entry.symbol, entry.id));
  grid.appendChild(card);

  try {
    new TradingView.widget({
      autosize: true, symbol: entry.symbol, interval: '1',
      timezone: tz, theme: 'dark', style: '1', locale,
      toolbar_bg: '#18181f', enable_publishing: false,
      allow_symbol_change: false, save_image: false,
      hide_side_toolbar: false,
      studies: ['Volume@tv-basicstudies'],
      container_id: entry.id,
    });
  } catch {
    document.getElementById(entry.id).innerHTML = `<div class="chart-error">⚠ 차트 로드 실패: ${esc(entry.symbol)}</div>`;
  }
}

function removeChart(region, symbol, id) {
  const arr = S.charts[region];
  if (arr) { const i = arr.findIndex(c => c.symbol === symbol); if (i > -1) arr.splice(i, 1); }
  saveCharts(region);
  document.getElementById(`card_${id}`)?.remove();
  updateEmptyState(region);
  toast('차트 삭제됨');
}

function saveCharts(region) {
  save(`${region}-charts`, S.charts[region] || []);
}

async function restoreCharts() {
  for (const region of ['kr', 'us', 'coin-gl', 'coin-kr']) {
    for (const entry of (S.charts[region] || [])) {
      await renderChart(region, entry);
    }
    updateEmptyState(region);
  }
}

function updateEmptyState(region) {
  const grid = document.getElementById(`${region}-charts-grid`);
  if (!grid) return;
  grid.querySelector('.empty-state')?.remove();
  if (!(S.charts[region]?.length)) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    const label = region.startsWith('coin') ? '코인' : '종목';
    div.innerHTML = `<div class="empty-icon">📊</div>
      <div class="empty-title">추가된 ${label}이 없습니다</div>
      <div class="empty-desc">위 검색창에서 검색하여 차트를 추가하세요</div>`;
    grid.appendChild(div);
  }
}

// ─── Clear button ─────────────────────────────────────────────
function initClearBtn(btnId, regions) {
  document.getElementById(btnId)?.addEventListener('click', () => {
    if (!confirm('저장된 차트를 모두 삭제할까요?')) return;
    regions.forEach(r => {
      S.charts[r] = []; save(`${r}-charts`, []);
      const grid = document.getElementById(`${r}-charts-grid`);
      if (grid) grid.innerHTML = '';
      updateEmptyState(r);
    });
    toast('차트 초기화 완료', 'success');
  });
}

// ─── TradingView loader ────────────────────────────────────────
function ensureTradingView() {
  return new Promise(resolve => {
    if (window.TradingView) { resolve(); return; }
    let tries = 0;
    const check = setInterval(() => {
      tries++;
      if (window.TradingView || tries > 50) { clearInterval(check); resolve(); }
    }, 100);
  });
}

// ─── Utility ─────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = String(str); return d.innerHTML;
}

let _toastTimer = null;
function toast(msg, type = '') {
  const el = document.getElementById('toast'); if (!el) return;
  clearTimeout(_toastTimer);
  el.textContent = msg;
  el.className = `toast show${type ? ' ' + type : ''}`;
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
