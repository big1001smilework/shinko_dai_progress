/*
 * shinko_dai_progress（iPhone・iPad版）
 * PC版と同じデータファイルを、Dropboxのアプリ専用フォルダで共有して使う。
 * 通信先は Dropbox だけ（index.html の Content-Security-Policy で制限）。
 * 画面に出す文字はすべて textContent で入れる（HTMLとして解釈しない）。
 */
'use strict';

// ================= 設定 =================
const CONFIG = {
  appKey: '1g32m4or4u9ycyf',
  redirectUri: 'https://big1001smilework.github.io/shinko_dai_progress/',
  dataPath: '/shinko_dai_progress_data.json',
  maxBytes: 10 * 1024 * 1024,
  maxItems: 1000
};
const LS_REFRESH = 'sdp_refresh_token';
const SS_VERIFIER = 'sdp_pkce_verifier';
const SS_STATE = 'sdp_oauth_state';

// ================= 決まりごと（PC版の Rules.cs と同じ） =================
const R = {
  names: ['制作依頼受付', '担当営業打合せ', 'クライアント打合せ', '素材依頼', '素材入手',
    '初稿着手', '初稿完成', '初稿送付', '初稿CB', '2稿送付',
    '2稿CB', '校正予約', '校正入稿', '最終稿送付', '校了'],
  FIRST_SEND: 7, FIRST_CB: 8, FINAL_SEND: 13, DONE: 14,
  week: '日月火水木金土',

  nfkc(s) { return String(s == null ? '' : s).normalize('NFKC'); },
  kotei(k) {
    const s = R.nfkc(k);
    if (s.includes('ベーシック') || s.includes('ーシック')) return 'basic';
    if (s.includes('プレミアム') || s.includes('レミアム')) return 'premium';
    return 'other';
  },
  allowsCommission(k) { return R.kotei(k) !== 'basic'; },

  // "2026-12-09T00:00:00" → 日付（ローカル時刻の0時）
  parseDate(v) {
    if (!v || typeof v !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  },
  toDateStr(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
  },
  toInput(d) { return d ? R.toDateStr(d).slice(0, 10) : ''; },
  fromInput(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return null;
    const y = Number(m[1]);
    if (y < 2000 || y > 2100) return null;
    return new Date(y, Number(m[2]) - 1, Number(m[3]));
  },
  addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; },
  monday(d) { return R.addDays(d, -((d.getDay() + 6) % 7)); },
  autoDeadline(release, kotei) {
    if (!release) return null;
    const t = R.kotei(kotei);
    if (t === 'premium') return R.addDays(R.monday(release), -3);
    if (t === 'basic') return R.monday(release);
    return null;
  },
  autoRule(kotei) {
    const t = R.kotei(kotei);
    if (t === 'premium') return '自動計算：発売日の前週の金曜日';
    if (t === 'basic') return '自動計算：発売日の週の月曜日';
    return 'この工程は入稿締切を手入力します';
  },
  deadline(m) { return R.parseDate(m.DeadlineManual) || R.autoDeadline(R.parseDate(m.ReleaseDate), m.Kotei); },
  deleteDate(m) { const r = R.parseDate(m.ReleaseDate); return r ? R.addDays(r, 3) : null; },
  jp(d) { return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; },
  jpw(d) { return `${R.jp(d)}（${R.week[d.getDay()]}）`; },
  md(d) { return `${d.getMonth() + 1}/${d.getDate()}`; },
  mdw(d) { return `${d.getMonth() + 1}/${d.getDate()}(${R.week[d.getDay()]})`; },
  isComplete(m) { return Array.isArray(m.Done) && m.Done.includes(R.DONE); },

  // 見積あり：打診→先方受諾→見積取得→制作依頼→経理送付→納品→（先行）先行支払依頼→OZ起票依頼→（先行）先行支払処理済
  // 見積なし：打診→先方受諾→制作依頼→納品→（先行）先行支払依頼→OZ起票依頼→（先行）先行支払処理済
  // キー mit・kei・oz・sen は以前と同じ（完了状態を引き継ぐ）
  commissionStages(c) {
    const adv = c.Pay !== 1;
    const list = [['dashin', '打診'], ['jutaku', '先方受諾']];
    if (c.HasEstimate) list.push(['mit', '見積取得']);
    list.push(['irai', '制作依頼']);
    if (c.HasEstimate) list.push(['kei', '経理送付']);
    list.push(['nohin', '納品']);
    if (adv) list.push(['senirai', '先行支払依頼']);
    list.push(['oz', 'OZ起票依頼']);
    if (adv) list.push(['sen', '先行支払処理済']);
    return list;
  },

  // 目安日付（初稿送付＝発売日の19日前、校了＝6日前）。入稿締切が自動計算のときだけ自動で出す
  TARGET_FIRST: 19, TARGET_CLOSE: 6,
  hasTarget(i) { return i === R.FIRST_SEND || i === R.DONE; },
  targetField(i) { return i === R.FIRST_SEND ? 'TargetFirstDraft' : 'TargetClosing'; },
  autoTarget(m, i) {
    const rel = R.parseDate(m.ReleaseDate);
    if (!rel || R.parseDate(m.DeadlineManual) || !R.autoDeadline(rel, m.Kotei)) return null;
    if (i === R.FIRST_SEND) return R.addDays(rel, -R.TARGET_FIRST);
    if (i === R.DONE) return R.addDays(rel, -R.TARGET_CLOSE);
    return null;
  },
  target(m, i) {
    if (!R.hasTarget(i)) return null;
    return R.parseDate(m[R.targetField(i)]) || R.autoTarget(m, i);
  },
  // 初稿送付の注意：0＝なし、1＝目安の2日前〜当日で未完了、2＝目安を過ぎても未完了（目安がない・完成済みは0）
  ALERT_DAYS: 2,
  today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); },
  daysBetween(a, b) { return Math.round((b.getTime() - a.getTime()) / 86400000); },
  firstDraftAlert(m, today) {
    if (R.isComplete(m) || (Array.isArray(m.Done) && m.Done.includes(R.FIRST_SEND))) return 0;
    const t = R.target(m, R.FIRST_SEND);
    if (!t) return 0;
    const d = R.daysBetween(today, t);
    if (d < 0) return 2;
    return d <= R.ALERT_DAYS ? 1 : 0;
  },
  firstDraftAlertText(m, today) {
    const t = R.target(m, R.FIRST_SEND);
    if (!t) return '';
    const d = R.daysBetween(today, t);
    const head = '初稿送付 目安' + R.mmdd(t);
    return d > 0 ? `${head}まで あと${d}日` : d === 0 ? `${head} 今日` : `${head}から ${-d}日超過`;
  },
  mmdd(d) { const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}/${p(d.getDate())}`; },

  // 区分の完了・未完了を切り替える（14を戻すと15も戻る、15は14のあと）
  toggle(m, i) {
    if (!Array.isArray(m.Done)) m.Done = [];
    const has = m.Done.includes(i);
    if (has) {
      m.Done = m.Done.filter((x) => x !== i && !(i === R.FINAL_SEND && x === R.DONE));
      return true;
    }
    if (i === R.DONE && !m.Done.includes(R.FINAL_SEND)) return false;
    m.Done.push(i);
    return true;
  },

  safeUrl(u) {
    if (typeof u !== 'string' || u.length === 0 || u.length > 2000) return null;
    try {
      const x = new URL(u);
      return (x.protocol === 'https:' || x.protocol === 'http:') && x.hostname ? x.href : null;
    } catch (e) { return null; }
  },

  // 受け取ったデータの形を確かめる
  validate(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.Items)) throw new Error('データの形式が正しくありません。');
    if (data.Items.length > CONFIG.maxItems) throw new Error('原稿の件数が多すぎます。');
    for (const m of data.Items) {
      if (!m || typeof m !== 'object' || typeof m.Id !== 'string') throw new Error('データの形式が正しくありません。');
      if (!Array.isArray(m.Done)) m.Done = [];
      if (!m.Memos || typeof m.Memos !== 'object' || Array.isArray(m.Memos)) m.Memos = {};
      if (!Array.isArray(m.Commissions)) m.Commissions = [];
      for (const c of m.Commissions) {
        if (!Array.isArray(c.Done)) c.Done = [];
        if (!c.Memos || typeof c.Memos !== 'object' || Array.isArray(c.Memos)) c.Memos = {};
      }
    }
    return data;
  }
};

// node での試験用（ブラウザでは使わない）
if (typeof module !== 'undefined') { module.exports = { R, CONFIG }; }

// ================= ここから下はブラウザだけ =================
if (typeof window !== 'undefined') {
  (function () {
    const S = {
      access: null, accessExp: 0,
      data: null, rev: null, loadedAt: 0,
      filter: 'active', search: '',
      openId: null, selId: null,
      sync: 'idle', syncMsg: '', lastSync: null,
      busy: false
    };
    const app = document.getElementById('app');

    // ---------- 画面部品 ----------
    function h(tag, props, ...kids) {
      const el = document.createElement(tag);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (v == null || v === false) continue;
          if (k === 'class') el.className = v;
          else if (k === 'text') el.textContent = v;
          else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
          else if (k === 'style') el.style.cssText = v;
          else el.setAttribute(k, v === true ? '' : String(v));
        }
      }
      for (const k of kids.flat()) {
        if (k == null || k === false) continue;
        el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
      }
      return el;
    }
    let toastTimer = null;
    function toast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    }

    // ---------- Dropbox への接続（PKCE、秘密の鍵は使わない） ----------
    function b64url(bytes) {
      let s = '';
      bytes.forEach((b) => { s += String.fromCharCode(b); });
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function randomStr(n) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
      const r = crypto.getRandomValues(new Uint8Array(n));
      return Array.from(r, (x) => chars[x % chars.length]).join('');
    }
    async function connect() {
      const verifier = randomStr(64);
      const state = randomStr(32);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      sessionStorage.setItem(SS_VERIFIER, verifier);
      sessionStorage.setItem(SS_STATE, state);
      const q = new URLSearchParams({
        client_id: CONFIG.appKey,
        response_type: 'code',
        code_challenge: b64url(new Uint8Array(digest)),
        code_challenge_method: 'S256',
        redirect_uri: CONFIG.redirectUri,
        token_access_type: 'offline',
        state: state
      });
      location.assign('https://www.dropbox.com/oauth2/authorize?' + q.toString());
    }
    async function tokenRequest(params) {
      const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(j.error_description || j.error || ('HTTP ' + res.status)); e.status = res.status; e.code = j.error; throw e; }
      return j;
    }
    async function finishLogin(code, state) {
      const saved = sessionStorage.getItem(SS_STATE);
      const verifier = sessionStorage.getItem(SS_VERIFIER);
      sessionStorage.removeItem(SS_STATE);
      sessionStorage.removeItem(SS_VERIFIER);
      history.replaceState(null, '', CONFIG.redirectUri);
      if (!saved || saved !== state || !verifier) throw new Error('接続の確認に失敗しました。もう一度「Dropboxにつなぐ」を押してください。');
      const j = await tokenRequest({ grant_type: 'authorization_code', code, client_id: CONFIG.appKey, code_verifier: verifier, redirect_uri: CONFIG.redirectUri });
      if (!j.refresh_token) throw new Error('Dropboxから必要な情報が届きませんでした。');
      localStorage.setItem(LS_REFRESH, j.refresh_token);
      S.access = j.access_token;
      S.accessExp = Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000;
    }
    async function accessToken() {
      if (S.access && Date.now() < S.accessExp) return S.access;
      const rt = localStorage.getItem(LS_REFRESH);
      if (!rt) throw Object.assign(new Error('Dropboxにつながっていません。'), { needLogin: true });
      try {
        const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt, client_id: CONFIG.appKey });
        S.access = j.access_token;
        S.accessExp = Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000;
        return S.access;
      } catch (e) {
        if (e.status === 400 || e.status === 401) {
          localStorage.removeItem(LS_REFRESH);
          throw Object.assign(new Error('Dropboxとの接続が切れました。もう一度つないでください。'), { needLogin: true });
        }
        throw e;
      }
    }
    async function dbx(url, opts, retry) {
      const token = await accessToken();
      const o = Object.assign({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' }, opts);
      o.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
      const res = await fetch(url, o);
      if (res.status === 401 && !retry) { S.access = null; return dbx(url, opts, true); }
      return res;
    }
    async function disconnect() {
      try { await dbx('https://api.dropboxapi.com/2/auth/token/revoke', { headers: {} }); } catch (e) { /* 切断できなくても手元の情報は消す */ }
      localStorage.removeItem(LS_REFRESH);
      S.access = null; S.data = null; S.rev = null;
      renderConnect();
    }

    // ---------- データの読み書き ----------
    async function fetchLatest() {
      const meta = await dbx('https://api.dropboxapi.com/2/files/get_metadata', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: CONFIG.dataPath })
      });
      if (meta.status === 409) throw new Error('Dropboxにデータがまだありません。\nPC版の「設定」で、保存場所をDropboxのアプリ用フォルダ（Apps または アプリ → shinko_dai_progress）にしてください。');
      if (!meta.ok) throw new Error('データの情報を取れませんでした（' + meta.status + '）。');
      const mj = await meta.json();
      if (mj.size > CONFIG.maxBytes) throw new Error('データファイルが大きすぎます。');
      const res = await dbx('https://content.dropboxapi.com/2/files/download', {
        headers: { 'Dropbox-API-Arg': JSON.stringify({ path: 'rev:' + mj.rev }) }
      });
      if (!res.ok) throw new Error('データを読み込めませんでした（' + res.status + '）。');
      const text = await res.text();
      if (text.length > CONFIG.maxBytes) throw new Error('データファイルが大きすぎます。');
      let data;
      try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error('データの形式が正しくありません。'); }
      return { data: R.validate(data), rev: mj.rev };
    }
    async function load(quiet) {
      setSync('busy', '読み込み中…');
      try {
        const r = await fetchLatest();
        S.data = r.data; S.rev = r.rev; S.loadedAt = Date.now();
        setSync('ok', '');
        render();
      } catch (e) {
        if (e.needLogin) { renderConnect(e.message); return; }
        setSync('err', e.message);
        if (!S.data) renderError(e.message); else if (!quiet) toast(e.message);
      }
    }

    // 1つの原稿に変更を加えて保存する。ほかの端末と同時に書いたときは、最新を読み直してやり直す
    async function change(id, fn, okMsg) {
      if (S.busy) { toast('保存中です。少し待ってください。'); return; }
      S.busy = true;
      // 先に画面へ反映（見た目の待ち時間をなくす）
      const local = S.data && S.data.Items.find((x) => x.Id === id);
      if (local) { fn(local); render(); }
      setSync('busy', '保存中…');
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const latest = await fetchLatest();
          const m = latest.data.Items.find((x) => x.Id === id);
          if (!m) throw new Error('この原稿はPCで削除されたようです。');
          if (fn(m) === false) throw new Error('この操作はできません。');
          m.UpdatedAt = new Date().toISOString();
          const body = new Blob([JSON.stringify(latest.data, null, 2)], { type: 'application/octet-stream' });
          const res = await dbx('https://content.dropboxapi.com/2/files/upload', {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ path: CONFIG.dataPath, mode: { '.tag': 'update', update: latest.rev }, autorename: false, mute: true, strict_conflict: true })
            },
            body
          });
          if (res.status === 409) continue; // ほかの端末が先に保存した → 読み直してやり直す
          if (!res.ok) throw new Error('保存できませんでした（' + res.status + '）。');
          const meta = await res.json();
          S.data = latest.data; S.rev = meta.rev; S.loadedAt = Date.now();
          setSync('ok', '');
          if (okMsg) toast(okMsg);
          return;
        }
        throw new Error('ほかの端末と同時に保存が重なりました。もう一度試してください。');
      } catch (e) {
        if (e.needLogin) { renderConnect(e.message); return; }
        setSync('err', e.message);
        toast(e.message);
        await load(true); // 画面を最新の状態に戻す
      } finally {
        S.busy = false;
        render();
      }
    }

    function setSync(state, msg) {
      S.sync = state; S.syncMsg = msg;
      if (state === 'ok') S.lastSync = new Date();
      const el = document.getElementById('syncline');
      if (el) fillSync(el);
    }
    function fillSync(el) {
      el.className = 'sync' + (S.sync === 'busy' ? ' is-busy' : S.sync === 'err' ? ' is-err' : '');
      el.textContent = '';
      el.appendChild(h('span', { class: 'dot' }));
      let t;
      if (S.sync === 'busy') t = S.syncMsg;
      else if (S.sync === 'err') t = 'エラー：' + S.syncMsg.split('\n')[0];
      else if (S.lastSync) t = `Dropboxと同期済み（${S.lastSync.getHours()}:${String(S.lastSync.getMinutes()).padStart(2, '0')}）`;
      else t = 'Dropbox';
      el.appendChild(document.createTextNode(t));
    }

    // ---------- 画面：接続・エラー ----------
    function renderConnect(err) {
      app.textContent = '';
      app.appendChild(h('div', { class: 'connect' },
        h('h1', { text: '進行一覧' }),
        h('p', { text: 'PCと同じ一覧を見るために、Dropboxにつなぎます。最初の1回だけです。' }),
        h('div', { class: 'box' },
          h('b', { text: 'このアプリが使う範囲' }),
          h('span', { text: 'Dropboxの「Apps（アプリ）」フォルダの中にある、このアプリ専用のフォルダ1つだけ。ほかのファイルは見えません。' }),
          h('span', { text: '通信するのはDropboxだけ。パスワードはこのページに入力しません（Dropboxの画面でログインします）。' })),
        err ? h('div', { class: 'err', text: err }) : null,
        h('button', { class: 'btn-dbx', onclick: () => connect().catch((e) => toast(e.message)) }, 'Dropboxにつなぐ'),
        h('p', { class: 'hint', text: 'つないだ状態はこの端末のSafariだけに残ります。しばらく開かないと消えることがあり、そのときはもう一度つないでください。' })));
    }
    function renderError(msg) {
      app.textContent = '';
      app.appendChild(h('div', { class: 'connect' },
        h('h1', { text: '進行一覧' }),
        h('div', { class: 'err', text: msg }),
        h('button', { class: 'btn btn-primary', onclick: () => load() }, 'もう一度読み込む'),
        h('button', { class: 'btn btn-danger', onclick: confirmDisconnect }, 'Dropboxとの接続を切る')));
    }
    function confirmDisconnect() {
      if (confirm('Dropboxとの接続を切りますか？（データは消えません。この端末からつながらなくなるだけです）')) disconnect();
    }

    // ---------- 画面：一覧 ----------
    function visibleItems() {
      const q = S.search.trim().toLowerCase();
      let items = S.data.Items.slice();
      if (S.filter === 'active') items = items.filter((m) => !R.isComplete(m));
      if (S.filter === 'done') items = items.filter((m) => R.isComplete(m));
      if (q) items = items.filter((m) => [m.PropertyName, m.PjCode, m.RequestId, m.Company].some((v) => String(v || '').toLowerCase().includes(q)));
      const t = (d) => (d ? d.getTime() : Number.MAX_SAFE_INTEGER);
      items.sort((a, b) => (t(R.deadline(a)) - t(R.deadline(b))) || (t(R.parseDate(a.ReleaseDate)) - t(R.parseDate(b.ReleaseDate))));
      return items;
    }

    function render() {
      if (!S.data) return;
      const keepScroll = window.scrollY;
      app.textContent = '';
      const all = S.data.Items;
      const active = all.filter((m) => !R.isComplete(m)).length;

      const syncLine = h('div', { id: 'syncline' });
      fillSync(syncLine);
      const seg = (k, label) => h('button', { class: S.filter === k ? 'on' : '', onclick: () => { S.filter = k; render(); } }, label);
      const search = h('input', { class: 'search', type: 'search', placeholder: '物件名・PJコード・依頼IDで検索', value: S.search, enterkeyhint: 'search' });
      search.addEventListener('input', () => { S.search = search.value; renderLists(); });

      app.appendChild(h('header', { class: 'top' },
        h('div', { class: 'top-row' },
          h('h1', { text: '進行一覧' }),
          h('div', { style: 'display:flex;gap:6px;flex:none' },
            h('button', { class: 'btn', onclick: () => load() }, '更新'),
            h('button', { class: 'btn', onclick: confirmDisconnect, 'aria-label': '設定' }, '切断'))),
        syncLine,
        h('div', { class: 'hint', text: `進行中 ${active}件 ／ 完成 ${all.length - active}件` }),
        h('div', { class: 'seg' }, seg('active', '進行中'), seg('done', '完成'), seg('all', 'すべて')),
        search));

      app.appendChild(h('main', { id: 'lists' }));
      renderLists();
      window.scrollTo(0, keepScroll);
    }

    function renderLists() {
      const box = document.getElementById('lists');
      if (!box) return;
      box.textContent = '';
      const items = visibleItems();

      // iPhone：開閉するカード
      const list = h('div', { class: 'list narrow-only' });
      if (items.length === 0) list.appendChild(h('div', { class: 'empty', text: S.data.Items.length ? '表示する原稿がありません。' : 'まだ原稿がありません。原稿はPCで追加します。' }));
      for (const m of items) list.appendChild(card(m, S.openId === m.Id, false));
      list.appendChild(h('div', { class: 'foot', text: '原稿の追加・情報の編集・二次委託の変更はPCで行います。完成した原稿は発売日から3日でPCが削除します。' }));
      box.appendChild(list);

      // iPad：左に一覧、右に詳細
      if (!items.some((m) => m.Id === S.selId)) S.selId = items.length ? items[0].Id : null;
      const side = h('nav', { class: 'side' });
      for (const m of items) {
        const dl = R.deadline(m), rel = R.parseDate(m.ReleaseDate);
        const done = R.isComplete(m);
        const al = R.firstDraftAlert(m, R.today());
        side.appendChild(h('button', { class: 'row' + (m.Id === S.selId ? ' sel' : '') + (done ? ' done' : ''), onclick: () => { S.selId = m.Id; renderLists(); } },
          h('span', { class: 'rn', text: (m.PropertyName || '（物件名なし）') + (done ? '　✓ 完成' : '') }),
          h('span', { class: 'rs', text: `${rel ? R.mdw(rel) + '発売' : ''}　締切 ${dl ? R.mdw(dl) : '要入力'}　${m.Done.length}/15` }),
          al ? h('span', { class: 'chip chip-alert' + (al === 2 ? ' over' : ''), text: '⚠ ' + R.firstDraftAlertText(m, R.today()) }) : null));
      }
      const sel = items.find((m) => m.Id === S.selId);
      const pane = h('section', { class: 'pane' }, sel ? card(sel, true, true) : h('div', { class: 'empty', text: '表示する原稿がありません。' }));
      box.appendChild(h('div', { class: 'split' }, side, pane));
    }

    function card(m, open, wide) {
      const done = R.isComplete(m);
      const rel = R.parseDate(m.ReleaseDate);
      const dl = R.deadline(m);
      const next = R.names.findIndex((n, i) => !m.Done.includes(i));
      const allows = R.allowsCommission(m.Kotei);
      const alert = R.firstDraftAlert(m, R.today());

      const chips = h('div', { class: 'chips' },
        h('span', { class: 'chip chip-rel', text: (rel ? (wide ? '発売日 ' + R.jpw(rel) : R.mdw(rel) + ' 発売') : '発売日なし') }),
        h('span', { class: 'chip chip-dl' + (dl ? '' : ' need'), text: dl ? (wide ? '入稿締切 ' + R.jpw(dl) : '締切 ' + R.mdw(dl)) : '締切 要入力' }),
        m.Kubun ? h('span', { class: 'chip chip-kubun', text: m.Kubun }) : null,
        alert ? h('span', { class: 'chip chip-alert' + (alert === 2 ? ' over' : ''), text: '⚠ ' + R.firstDraftAlertText(m, R.today()) }) : null,
        done ? h('span', { class: 'chip chip-done', text: '✓ 完成' }) : null,
        done && allows && m.Commissions.some((c) => c.Pay === 1) ? h('span', { class: 'chip chip-doji', text: '二次委託同時支払あり' }) : null);

      const head = wide
        ? h('div', { class: 'head' }, chips, h('div', { class: 'name-row' }, h('span', { class: 'name', text: m.PropertyName || '（物件名なし）' })))
        : h('button', { class: 'head', 'aria-expanded': String(open), onclick: () => { S.openId = open ? null : m.Id; renderLists(); } },
          chips,
          h('div', { class: 'name-row' }, h('span', { class: 'name', text: m.PropertyName || '（物件名なし）' }), h('span', { class: 'chev', text: open ? '▲' : '▼' })),
          h('div', { class: 'bar-row' },
            h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(m.Done.length / 15 * 100)}%` })),
            h('span', { class: 'bar-txt', text: `${m.Done.length}/15　次：${next < 0 ? '—' : R.names[next]}` })));

      const el = h('article', { class: 'card' + (done ? ' done' : '') }, head);
      if (!open) return el;

      const detail = h('div', { class: 'detail' });
      const dd = R.deleteDate(m);
      // 原稿の情報（押すとコピー）
      const info = h('div', { class: 'cps' });
      [['物件名', m.PropertyName], ['会社名', m.Company], ['PJコード', m.PjCode], ['制作依頼ID', m.RequestId],
       ['営業名', m.Sales], ['工程', m.Kotei], ['企画', m.Plan]].forEach(([label, v]) => {
        if (!v) return;
        info.appendChild(h('button', { class: 'cp', onclick: () => copyText(v) }, h('span', { class: 'cl', text: label }), h('span', { class: 'cv', text: v })));
      });
      detail.appendChild(info);
      if (done && dd) detail.appendChild(h('div', { class: 'info', text: `${R.md(dd)}にPCが削除します` }));

      // リンク
      const links = h('div', { class: 'links' });
      [['公式HP', m.OfficialUrl], ['プレビュー', m.PreviewUrl], ['その他', m.OtherUrl]].forEach(([label, u]) => {
        const safe = R.safeUrl(u);
        if (safe) links.appendChild(h('a', { class: 'link', href: safe, target: '_blank', rel: 'noopener noreferrer' }, label));
      });
      if (links.childNodes.length) detail.appendChild(links);

      // 15区分
      const grid = h('div', { class: 'grid' });
      R.names.forEach((n, i) => {
        const on = m.Done.includes(i);
        const lock = i === R.DONE && !m.Done.includes(R.FINAL_SEND);
        let sub = '';
        if (i === R.FIRST_SEND && R.parseDate(m.FirstDraftSent)) sub = R.md(R.parseDate(m.FirstDraftSent)) + ' 送付';
        if (i === R.FIRST_CB && R.parseDate(m.FirstCbDue)) sub = '締切 ' + R.md(R.parseDate(m.FirstCbDue));
        const memo = m.Memos[String(i)];
        const tg = !on && R.hasTarget(i) ? R.target(m, i) : null;
        const al = i === R.FIRST_SEND ? alert : 0;
        const btn = h('button', { class: 'st' + (on ? ' on' : '') + (lock ? ' lock' : '') + (al ? ' alert' : '') + (al === 2 ? ' over' : ''), 'aria-pressed': String(on) },
          h('span', { class: 'no', text: String(i + 1) }), h('span', { class: 'nm', text: n }), h('span', { class: 'sb', text: sub }),
          tg ? h('span', { class: 'tg', text: R.mmdd(tg) }) : null,
          memo ? h('span', { class: 'md' }) : null);
        pressable(btn,
          () => {
            if (lock) { toast('「14 最終稿送付」が完了すると押せます'); return; }
            if (i === R.FIRST_SEND) { sheetFirstDraft(m); return; }
            change(m.Id, (x) => R.toggle(x, i));
          },
          () => sheetMemo(m, 's' + i));
        grid.appendChild(btn);
      });
      detail.appendChild(grid);

      // 二次委託
      if (allows) {
        m.Commissions.forEach((c, ci) => {
          detail.appendChild(h('div', { class: 'niji-t', text: `二次委託${ci + 1}：${c.Content || ''}　${c.HasEstimate ? '見積あり' : '見積なし'}・${c.Pay === 1 ? '同時支払' : '先行支払'}` }));
          const g = h('div', { class: 'grid' });
          R.commissionStages(c).forEach(([key, name]) => {
            const on = c.Done.includes(key);
            const b = h('button', { class: 'st ex' + (on ? ' on' : ''), 'aria-pressed': String(on) },
              h('span', { class: 'no', text: '委託' + (ci + 1) }), h('span', { class: 'nm', text: name }), h('span', { class: 'sb', text: '' }),
              c.Memos[key] ? h('span', { class: 'md' }) : null);
            pressable(b,
              () => change(m.Id, (x) => {
                const cx = (x.Commissions || []).find((y) => y.Id === c.Id);
                if (!cx) return false;
                if (!Array.isArray(cx.Done)) cx.Done = [];
                cx.Done = cx.Done.includes(key) ? cx.Done.filter((k) => k !== key) : cx.Done.concat([key]);
                return true;
              }),
              () => sheetMemo(m, 'c' + c.Id + ':' + key));
            g.appendChild(b);
          });
          detail.appendChild(g);
        });
        if (done && m.Commissions.some((c) => R.commissionStages(c).some(([k]) => !c.Done.includes(k))))
          detail.appendChild(h('div', { class: 'warn', text: '二次委託の区分に未完了があります' }));
      }

      // メモの一覧
      const memoLines = [];
      R.names.forEach((n, i) => { const t = m.Memos[String(i)]; if (t) memoLines.push(`${i + 1} ${n}：${t}`); });
      if (allows) m.Commissions.forEach((c, ci) => R.commissionStages(c).forEach(([k, n]) => { if (c.Memos[k]) memoLines.push(`二次委託${ci + 1} ${n}：${c.Memos[k]}`); }));
      if (m.ClosingMemo) memoLines.push('校了メモ：' + m.ClosingMemo);
      if (memoLines.length) detail.appendChild(h('div', { class: 'memos' }, h('b', { text: 'メモ' }), memoLines.map((t) => h('span', { text: t }))));

      detail.appendChild(h('div', { class: 'actions' },
        h('button', { class: 'a-rel', onclick: () => sheetRelease(m) }, '発売日を変更'),
        h('button', { class: 'a-dl', onclick: () => sheetDeadline(m) }, '締切を変更'),
        h('button', { class: 'a-tg', onclick: () => sheetTarget(m) }, '目安日付'),
        h('button', { onclick: () => sheetMemo(m, null) }, 'メモを書く')));
      detail.appendChild(h('div', { class: 'hint', text: '区分を押すと完了／未完了。長押しでその区分のメモ。原稿の情報は押すとコピー。赤い日付は目安。' }));
      el.appendChild(detail);
      return el;
    }

    // 押す＝切り替え、長押し＝メモ
    function pressable(el, onTap, onLong) {
      let timer = null, long = false;
      const start = () => { long = false; timer = setTimeout(() => { long = true; onLong(); }, 550); };
      const cancel = () => { clearTimeout(timer); timer = null; };
      el.addEventListener('pointerdown', start);
      el.addEventListener('pointerup', cancel);
      el.addEventListener('pointerleave', cancel);
      el.addEventListener('pointercancel', cancel);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      el.addEventListener('click', (e) => { e.preventDefault(); if (long) { long = false; return; } onTap(); });
    }

    // ---------- 下から出る画面 ----------
    function sheet(title, sub, body, buttons) {
      const ov = h('div', { class: 'ov' });
      const close = () => ov.remove();
      ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
      const btns = h('div', { class: 'btns' }, buttons.map(([label, cls, fn]) => h('button', { class: 'btn ' + (cls || ''), onclick: () => fn(close) }, label)));
      ov.appendChild(h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'grab' }), h('h2', { text: title }), sub ? h('div', { class: 'sub', text: sub }) : null, body, btns));
      document.body.appendChild(ov);
      return close;
    }

    function stageLabel(m, key) {
      if (key.startsWith('s')) { const i = Number(key.slice(1)); return `${i + 1} ${R.names[i]}`; }
      const [cid, k] = key.slice(1).split(':');
      const ci = m.Commissions.findIndex((c) => c.Id === cid);
      const c = m.Commissions[ci];
      const st = c ? R.commissionStages(c).find(([x]) => x === k) : null;
      return `二次委託${ci + 1} ${st ? st[1] : ''}`;
    }
    function getMemo(m, key) {
      if (key === 'closing') return m.ClosingMemo || '';
      if (key.startsWith('s')) return m.Memos[key.slice(1)] || '';
      const [cid, k] = key.slice(1).split(':');
      const c = m.Commissions.find((x) => x.Id === cid);
      return c && c.Memos[k] ? c.Memos[k] : '';
    }
    function setMemo(x, key, v) {
      v = String(v || '').trim().slice(0, key === 'closing' ? 2000 : 1000);
      if (key === 'closing') { x.ClosingMemo = v; return true; }
      if (key.startsWith('s')) {
        if (!x.Memos || typeof x.Memos !== 'object') x.Memos = {};
        if (v) x.Memos[key.slice(1)] = v; else delete x.Memos[key.slice(1)];
        return true;
      }
      const [cid, k] = key.slice(1).split(':');
      const c = (x.Commissions || []).find((y) => y.Id === cid);
      if (!c) return false;
      if (!c.Memos || typeof c.Memos !== 'object') c.Memos = {};
      if (v) c.Memos[k] = v; else delete c.Memos[k];
      return true;
    }

    // メモ（key が null なら、どの区分か選ぶところから）
    function sheetMemo(m, key) {
      const opts = R.names.map((n, i) => ['s' + i, `${i + 1} ${n}`]);
      if (R.allowsCommission(m.Kotei)) m.Commissions.forEach((c, ci) => R.commissionStages(c).forEach(([k, n]) => opts.push(['c' + c.Id + ':' + k, `二次委託${ci + 1} ${n}`])));
      opts.push(['closing', '校了メモ']);
      let cur = key || 's0';
      const sel = h('select', {}, opts.map(([v, t]) => { const o = h('option', { value: v, text: t }); if (v === cur) o.selected = true; return o; }));
      const ta = h('textarea', { maxlength: '2000' });
      ta.value = getMemo(m, cur);
      sel.addEventListener('change', () => { cur = sel.value; ta.value = getMemo(m, cur); });
      const body = h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        key ? null : h('label', {}, '区分', sel),
        h('label', {}, 'メモ', ta));
      sheet(key ? stageLabel(m, key) + ' のメモ' : 'メモを書く', m.PropertyName, body, [
        ['メモを消す', 'btn-danger', (close) => { close(); change(m.Id, (x) => setMemo(x, cur, ''), 'メモを消しました'); }],
        ['閉じる', '', (close) => close()],
        ['保存', 'btn-primary', (close) => { const v = ta.value; close(); change(m.Id, (x) => setMemo(x, cur, v), 'メモを保存しました'); }]
      ]);
      if (key) setTimeout(() => ta.focus(), 50);
    }

    function dateInput(d) { const i = h('input', { type: 'date' }); i.value = R.toInput(d); return i; }

    function sheetRelease(m) {
      const inp = dateInput(R.parseDate(m.ReleaseDate));
      sheet('発売日を変更（延期など）', m.PropertyName,
        h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('label', {}, '発売日', inp),
          h('div', { class: 'hint', text: '自動計算の入稿締切と、完成後に削除される日も変わります。' })),
        [['閉じる', '', (c) => c()],
         ['変更する', 'btn-primary', (c) => {
           const d = R.fromInput(inp.value);
           if (!d) { toast('日付を選んでください'); return; }
           c(); change(m.Id, (x) => { x.ReleaseDate = R.toDateStr(d); return true; }, '発売日を変更しました');
         }]]);
    }

    function sheetDeadline(m) {
      const auto = R.autoDeadline(R.parseDate(m.ReleaseDate), m.Kotei);
      const inp = dateInput(R.deadline(m));
      const buttons = [];
      if (m.DeadlineManual && auto) buttons.push(['自動計算に戻す', '', (c) => { c(); change(m.Id, (x) => { x.DeadlineManual = null; return true; }, '自動計算に戻しました'); }]);
      buttons.push(['閉じる', '', (c) => c()]);
      buttons.push(['保存', 'btn-primary', (c) => {
        const d = R.fromInput(inp.value);
        c();
        change(m.Id, (x) => {
          const a = R.autoDeadline(R.parseDate(x.ReleaseDate), x.Kotei);
          x.DeadlineManual = d && !(a && R.toDateStr(a) === R.toDateStr(d)) ? R.toDateStr(d) : null;
          return true;
        }, '入稿締切を保存しました');
      }]);
      sheet('入稿締切を手入力', m.PropertyName,
        h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('label', {}, '入稿締切', inp),
          h('div', { class: 'hint', text: auto ? `${R.autoRule(m.Kotei)}（${R.jpw(auto)}）` : `この工程（${m.Kotei || '未入力'}）は手入力です` })),
        buttons);
    }

    function sheetFirstDraft(m) {
      const done = m.Done.includes(R.FIRST_SEND);
      const sent = dateInput(R.parseDate(m.FirstDraftSent) || (done ? null : new Date()));
      const cb = dateInput(R.parseDate(m.FirstCbDue));
      const apply = (x) => {
        const a = R.fromInput(sent.value), b = R.fromInput(cb.value);
        x.FirstDraftSent = a ? R.toDateStr(a) : null;
        x.FirstCbDue = b ? R.toDateStr(b) : null;
      };
      sheet('8 初稿送付', m.PropertyName,
        h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, h('label', {}, '送付日', sent), h('label', {}, '初稿CB締切日', cb),
          h('div', { class: 'hint', text: '「初稿送付」に送付日、「初稿CB」に締切日を月日で表示します。' })),
        [['閉じる', '', (c) => c()],
         ['日付だけ保存', '', (c) => { c(); change(m.Id, (x) => { apply(x); return true; }, '日付を保存しました'); }],
         [done ? '未完了に戻す' : '送付済みにする', 'btn-primary', (c) => { c(); change(m.Id, (x) => { apply(x); return R.toggle(x, R.FIRST_SEND); }); }]]);
    }

    // 目安日付（初稿送付・校了）
    function sheetTarget(m) {
      const rows = [R.FIRST_SEND, R.DONE].map((i) => {
        const inp = dateInput(R.target(m, i));
        const auto = R.autoTarget(m, i);
        const hint = auto ? `自動：発売日の${i === R.FIRST_SEND ? R.TARGET_FIRST : R.TARGET_CLOSE}日前（${R.jpw(auto)}）` : '入稿締切が手入力のため、目安日付も手入力です';
        return { i, inp, auto, el: h('label', {}, `${i + 1} ${R.names[i]}`, inp, h('span', { class: 'hint', text: hint })) };
      });
      sheet('目安日付', m.PropertyName,
        h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, rows.map((r) => r.el),
          h('div', { class: 'hint', text: '空欄にして保存すると、自動の目安に戻ります（自動がない原稿では消えます）。' })),
        [['閉じる', '', (c) => c()],
         ['保存', 'btn-primary', (c) => {
           const vals = rows.map((r) => ({ i: r.i, d: R.fromInput(r.inp.value) }));
           c();
           change(m.Id, (x) => {
             vals.forEach(({ i, d }) => {
               const a = R.autoTarget(x, i);
               x[R.targetField(i)] = d && !(a && R.toDateStr(a) === R.toDateStr(d)) ? R.toDateStr(d) : null;
             });
             return true;
           }, '目安日付を保存しました');
         }]]);
    }

    // 押した文字をコピー
    async function copyText(v) {
      try {
        await navigator.clipboard.writeText(v);
        toast('コピーしました：' + (v.length > 24 ? v.slice(0, 24) + '…' : v));
      } catch (e) {
        try {
          const ta = h('textarea', {});
          ta.value = v;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          toast(ok ? 'コピーしました' : 'コピーできませんでした');
        } catch (e2) { toast('コピーできませんでした'); }
      }
    }

    // ---------- 起動 ----------
    async function start() {
      const p = new URLSearchParams(location.search);
      try {
        if (p.get('error')) {
          history.replaceState(null, '', CONFIG.redirectUri);
          renderConnect('Dropboxへの接続をやめました。');
          return;
        }
        if (p.get('code')) {
          await finishLogin(p.get('code'), p.get('state'));
        }
        if (!localStorage.getItem(LS_REFRESH)) { renderConnect(); return; }
        await load();
      } catch (e) {
        renderConnect(e.message);
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.data && !S.busy && Date.now() - S.loadedAt > 20000) load(true);
    });
    start();
  })();
}
