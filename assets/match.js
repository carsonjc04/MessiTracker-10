// Match replay. Data shape: see scripts/build_data.py.
// messi rows: [t, type, x, y, ex?, ey?, flag?]  (flag: pass 0 fail/1 ok/2 shot assist/3 goal assist;
//             carry 1; shot 3 = goal; dribble/duel 1 = won)
// ball rows:  [t, x, y, team]   (team 0 = Messi's team)
(async () => {
  RM.chrome('');
  const $ = (id) => document.getElementById(id);
  const MESSI = 5503;
  const id = new URLSearchParams(location.search).get('id');
  let D, idx;
  try {
    const r = await fetch(`data/matches/${encodeURIComponent(id)}.json`);
    if (!r.ok) throw new Error();
    D = await r.json();
  } catch {
    $('meta').innerHTML = 'That match isn\'t in the archive. <a href="archive.html">Pick one from every match →</a>';
    return;
  }
  idx = await RM.loadIndex().catch(() => []);

  // ---------- derived data ----------
  const PSTART = { 1: 0, 2: 2700, 3: 5400, 4: 6300, 5: 7200 };
  const PEND = { 1: 2700, 2: 5400, 3: 6300, 4: 7200 };
  const PNAME = { 1: '1st half', 2: '2nd half', 3: 'Extra time, 1st half', 4: 'Extra time, 2nd half', 5: 'Penalty shoot-out' };
  const periods = Object.entries(D.periods).map(([p, [a, b]]) => ({ p: +p, a, b })).sort((x, y) => x.p - y.p);
  const END = D.end;
  const ev = D.messi;
  const shots = D.shots.slice().sort((a, b) => a.t - b.t);
  // decode compact arrays: times are stored as tenths of a second since the previous sample
  const ball = [];
  for (let i = 0, t10 = 0; i < D.ball.length; i += 4) { t10 += D.ball[i]; ball.push([t10 / 10, D.ball[i + 1], D.ball[i + 2], D.ball[i + 3]]); }
  for (const p of Object.values(D.players || {})) {
    const out = [];
    for (let i = 0, t10 = 0; i < p.tr.length; i += 3) { t10 += p.tr[i]; out.push(t10 / 10, p.tr[i + 1], p.tr[i + 2], 0); }
    p.tr = out;
  }
  const name = (pid) => (pid == null ? 'Own goal' : D.names[pid] || 'Unknown');
  const OUTCOME = { 'Off T': 'off target', 'Wayward': 'wide', 'Saved Off T': 'saved', 'Saved to Post': 'saved, hit post', 'Post': 'hit the post' };
  const outcome = (o) => (OUTCOME[o] || o).toLowerCase();
  const isGoal = (s) => s.o === 'Goal' || s.o === 'Own Goal';
  const home = D.home, away = D.away;
  const offT = D.off ?? null;
  document.title = `${home} ${D.hs}–${D.as} ${away} · Reading Messi`;

  const stage = D.stage && D.stage !== 'Regular Season' ? ` · ${D.stage}` : '';
  $('meta').textContent = `${RM.compShort(D.comp)} ${RM.seasonLabel(D.season)}${stage} · ${RM.fmtDate(D.date)}${D.stadium ? ' · ' + D.stadium : ''}`;

  // ---------- state ----------
  const S = {
    t: Math.max(0, D.on - 1), playing: false, speed: 20, trail: 'recent',
    layers: { players: true, pass: true, carry: true, drib: true, other: false, shots: true, ball: true, heat: false },
    pinned: null, hold: 0,
  };
  const hashT = /(?:^|[#&])t=(\d+)/.exec(location.hash);
  if (hashT) S.t = Math.min(END, +hashT[1]);

  // ---------- helpers ----------
  const bsearch = (arr, t, key = (r) => r[0]) => { // last index with key <= t
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  function clock(t) {
    let per = periods[0];
    for (const p of periods) if (t >= p.a) per = p;
    if (per.p === 5) return { label: 'Pens', per };
    const sec = Math.max(0, t - per.a) + PSTART[per.p];
    const end = PEND[per.p];
    const mmss = (v) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
    if (sec >= end) return { label: `${end / 60}+${mmss(sec - end)}`, per };
    return { label: mmss(sec), per };
  }
  const minuteLabel = (s) => (s.pe === 5 ? 'pens' : `${s.m + 1}'`);
  const css = () => getComputedStyle(document.documentElement);
  const tok = {};
  const readTokens = () => { const c = css(); for (const k of ['sol', 'opp', 'ink', 'bg', 'muted', 'line', 'chalk']) tok[k] = c.getPropertyValue('--' + k).trim(); };
  readTokens();

  // ---------- scoreboard ----------
  function scoreAt(t) {
    let a = 0, b = 0, pa = 0, pb = 0;
    for (const s of shots) {
      if (s.t > t || !isGoal(s)) continue;
      if (s.pe === 5) { s.tm === 0 ? pa++ : pb++; } else { s.tm === 0 ? a++ : b++; }
    }
    return D.isHome ? { h: a, a: b, ph: pa, pa: pb } : { h: b, a: a, ph: pb, pa: pa };
  }
  const hasSO = periods.some((p) => p.p === 5);
  function renderScore() {
    const sc = scoreAt(S.t);
    const side = (t) => { const st = RM.teamStyle(t); return `<span class="side"><i class="swatch" style="--c1:${st.c1};--c2:${st.c2}"></i>${RM.esc(t)}</span>`; };
    const so = hasSO && S.t >= periods.find((p) => p.p === 5).a ? `<span class="so">Pens ${sc.ph}–${sc.pa}</span>` : '';
    $('scoreboard').innerHTML = `${side(home)}<span class="score">${sc.h}–${sc.a}</span>${side(away)}${so}`;
  }

  // ---------- pitch geometry ----------
  const pitch = $('pitch');
  const MG = 4; const PW = 120 + 2 * MG, PH = 80 + 2 * MG;
  let G = null;
  function layout() { const f = RM.fitCanvas(pitch, PW / PH); G = { ...f, s: f.w / PW }; tl.layout(); draw(); }
  const P = (x, y) => [(MG + x) * G.s, (MG + y) * G.s];

  // where Messi is at time t: interpolate from the end of one event to the start of the next
  function messiPos(t) {
    const i = bsearch(ev, t);
    if (i < 0) return null;
    const a = ev[i];
    const aEnd = a[4] != null && (a[1] === 'C' || a[1] === 'D') ? [a[4], a[5]] : [a[2], a[3]];
    const since = t - a[0];
    const b = ev[i + 1];
    if (b && b[0] - a[0] <= 12 && b[0] > a[0]) {
      const k = Math.min(1, since / (b[0] - a[0]));
      return { x: aEnd[0] + (b[2] - aEnd[0]) * k, y: aEnd[1] + (b[3] - aEnd[1]) * k, since: 0, i };
    }
    if (a[1] === 'C' && since < 3) { // carry: move along it
      const k = since / 3; return { x: a[2] + (a[4] - a[2]) * k, y: a[3] + (a[5] - a[3]) * k, since: 0, i };
    }
    return { x: aEnd[0], y: aEnd[1], since, i };
  }
  function ballPos(t) {
    const i = bsearch(ball, t);
    if (i < 0) return null;
    const a = ball[i], b = ball[i + 1];
    if (b && b[0] - a[0] <= 5 && b[0] > a[0]) {
      const k = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
    return [a[1], a[2]];
  }
  const onPitch = (t) => t >= D.on && (offT == null || t < offT);

  // ---------- every player ----------
  // tr is flat [t, x, y, src, ...]; returns {x, y, stale} where stale = seconds to the nearest sample.
  const PL = Object.entries(D.players || {}).map(([pid, v]) => ({ pid: +pid, ...v }));
  const MESSI_P = PL.find((p) => p.pid === MESSI);
  function trackPos(tr, t) {
    const n = tr.length / 4;
    if (!n) return null;
    let lo = 0, hi = n - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tr[mid * 4] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i < 0) return { x: tr[1], y: tr[2], stale: tr[0] - t };
    if (i === n - 1) return { x: tr[i * 4 + 1], y: tr[i * 4 + 2], stale: t - tr[i * 4] };
    const a = i * 4, b = a + 4, span = tr[b] - tr[a];
    const k = span > 0 ? (t - tr[a]) / span : 0;
    return { x: tr[a + 1] + (tr[b + 1] - tr[a + 1]) * k, y: tr[a + 2] + (tr[b + 2] - tr[a + 2]) * k, stale: Math.min(t - tr[a], tr[b] - t) };
  }
  const playerOn = (p, t) => p.iv.some(([a, b]) => t >= a && t <= b);
  // Faint when the record hasn't placed him for a while.
  const STALE = 4; // seconds: beyond this a marker is drawn as an outline (an estimate)
  const staleAlpha = (s) => (s <= 2 ? 1 : s >= 20 ? .3 : 1 - .7 * ((s - 2) / 18));
  let drawn = []; // last frame's player positions, for hover labels

  function arrow(ctx, x0, y0, x1, y1, size) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath(); ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - size * Math.cos(a - .45), y1 - size * Math.sin(a - .45));
    ctx.lineTo(x1 - size * Math.cos(a + .45), y1 - size * Math.sin(a + .45));
    ctx.closePath(); ctx.fill();
  }

  // Active freeze frame: pinned shot, or one we just reached while playing.
  function activeShot() {
    if (S.pinned) return S.pinned;
    const i = bsearch(shots, S.t, (s) => s.t);
    if (i >= 0 && S.t - shots[i].t <= (isGoal(shots[i]) ? 7 : 3)) return shots[i];
    return null;
  }

  function draw() {
    if (!G) return;
    const { ctx, w, h, s } = G;
    ctx.clearRect(0, 0, w, h);
    RM.drawPitch(ctx, P, s);
    const t = S.t, L = S.layers;
    const from = S.trail === 'all' ? -1 : t - 120;

    // touch map
    if (L.heat) {
      const nx = 12, ny = 8, grid = new Array(nx * ny).fill(0);
      let max = 1;
      for (const r of ev) { if (r[0] > t) break; const gx = Math.min(nx - 1, Math.floor(r[2] / 10)), gy = Math.min(ny - 1, Math.floor(r[3] / 10)); max = Math.max(max, ++grid[gy * nx + gx]); }
      ctx.fillStyle = tok.sol;
      for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
        const v = grid[gy * nx + gx]; if (!v) continue;
        ctx.globalAlpha = .12 + .55 * (v / max);
        const [a, b] = P(gx * 10, gy * 10); ctx.fillRect(a + 1, b + 1, 10 * s - 2, 10 * s - 2);
      }
      ctx.globalAlpha = 1;
    }

    // shots
    if (L.shots) {
      for (const sh of shots) {
        if (sh.t > t || !sh.l || sh.pe === 5) continue;
        const [x, y] = P(sh.l[0], sh.l[1]);
        const col = sh.tm === 1 ? tok.opp : sh.p === MESSI ? tok.sol : '#ffffff';
        const k = Math.max(3.5, s * .6);
        ctx.strokeStyle = col; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - k, y - k); ctx.lineTo(x + k, y + k); ctx.moveTo(x + k, y - k); ctx.lineTo(x - k, y + k); ctx.stroke();
        ctx.lineCap = 'butt';
        if (isGoal(sh)) { ctx.beginPath(); ctx.arc(x, y, k + 4, 0, Math.PI * 2); ctx.lineWidth = 1.8; ctx.stroke(); }
      }
    }

    // Messi's trail
    const start = Math.max(0, bsearch(ev, from) + 1), endI = bsearch(ev, t);
    for (let i = start; i <= endI; i++) {
      const r = ev[i], type = r[1];
      const age = t - r[0];
      const alpha = S.trail === 'all' ? .75 : Math.max(.15, 1 - age / 120);
      ctx.globalAlpha = alpha;
      const [x, y] = P(r[2], r[3]);
      if (type === 'P' && L.pass && r[4] != null) {
        const [ex, ey] = P(r[4], r[5]);
        const ok = r[6] >= 1;
        ctx.strokeStyle = ok ? tok.sol : 'rgba(255,255,255,.6)'; ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = r[6] === 3 ? 3.5 : r[6] === 2 ? 2.5 : 1.6;
        ctx.setLineDash(ok ? [] : [4, 4]);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
        arrow(ctx, x, y, ex, ey, 4 + ctx.lineWidth * 1.5);
      } else if (type === 'C' && L.carry && r[4] != null) {
        const [ex, ey] = P(r[4], r[5]);
        ctx.strokeStyle = tok.sol; ctx.lineWidth = 2; ctx.setLineDash([1.5, 4]); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'butt';
      } else if (type === 'S' && L.shots) {
        if (r[4] != null) {
          const [ex, ey] = P(r[4], r[5]);
          ctx.strokeStyle = r[6] === 3 ? tok.sol : 'rgba(255,255,255,.8)'; ctx.lineWidth = r[6] === 3 ? 3 : 1.6;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
        }
      } else if (type === 'D' && L.drib) {
        const d = s * .9;
        ctx.beginPath(); ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath();
        if (r[6] === 1) { ctx.fillStyle = tok.sol; ctx.fill(); } else { ctx.strokeStyle = tok.sol; ctx.lineWidth = 1.6; ctx.stroke(); }
      } else if (L.other && type !== 'P' && type !== 'C' && type !== 'S' && type !== 'D') {
        ctx.fillStyle = tok.sol; ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, s * .3), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // shot moment: assist pass and shot line (players below are at their freeze-frame spots)
    const fs = activeShot();
    if (fs && fs.l) {
      if (fs.a && fs.a.l && fs.a.e) {
        const [ax, ay] = P(fs.a.l[0], fs.a.l[1]), [bx, by] = P(fs.a.e[0], fs.a.e[1]);
        ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      }
      if (fs.e) {
        const [x, y] = P(fs.l[0], fs.l[1]), [ex, ey] = P(fs.e[0], fs.e[1]);
        ctx.strokeStyle = isGoal(fs) ? tok.sol : '#ffffff'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      }
    }

    // every player on the pitch; Messi drawn last, on top
    drawn = [];
    const disc = (x, y, r, fill, stroke, lw, label, ink) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke();
      if (label != null && r >= 6) {
        ctx.fillStyle = ink; ctx.font = `800 ${Math.round(r * 1.15)}px "Big Shoulders Display", Impact, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(label), x, y + r * .08);
      }
    };
    if (L.players) {
      for (const p of PL) {
        if (p.pid === MESSI || !playerOn(p, t)) continue;
        const q = trackPos(p.tr, t); if (!q) continue;
        const [x, y] = P(q.x, q.y);
        const r = Math.max(6, s * 1.15);
        const col = p.tm === 0 ? '#ffffff' : tok.opp;
        if (q.stale <= STALE) {
          if (p.tm === 0) disc(x, y, r, col, p.gk ? '#111' : 'rgba(0,0,0,.5)', p.gk ? 2.5 : 1, p.no, '#14201a');
          else disc(x, y, r, col, p.gk ? '#fff' : 'rgba(0,0,0,.45)', p.gk ? 2.5 : 1, p.no, '#ffffff');
        } else {
          ctx.globalAlpha = q.stale > 20 ? .6 : .85;
          disc(x, y, r - 1, 'rgba(0,0,0,.18)', col, p.gk ? 3 : 2, p.no, col);
          ctx.globalAlpha = 1;
        }
        drawn.push({ x, y, r, p, stale: q.stale });
      }
    }

    // ball
    if (L.ball) {
      const b = ballPos(t);
      if (b) {
        const [x, y] = P(b[0], b[1]);
        ctx.beginPath(); ctx.arc(x, y, Math.max(3, s * .5), 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    // Messi
    if (onPitch(t)) {
      let m = MESSI_P ? trackPos(MESSI_P.tr, t) : null;
      if (!m) { const mp = messiPos(t); if (mp) m = { x: mp.x, y: mp.y, stale: mp.since }; }
      if (m) {
        const [x, y] = P(m.x, m.y);
        const r = Math.max(9, s * 1.55);
        ctx.globalAlpha = Math.max(.55, staleAlpha(m.stale));
        ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 201, 40, .28)'; ctx.fill();
        disc(x, y, r, tok.sol, '#111', 2.5, MESSI_P?.no ?? 10, '#111');
        ctx.globalAlpha = 1;
        drawn.push({ x, y, r, p: MESSI_P || { n: 'Lionel Messi', no: '' }, stale: m.stale });
      }
    }
    renderHud(fs);
  }

  // ---------- text HUD ----------
  const DESC = {
    P: (r) => {
      const yd = Math.round(Math.hypot(r[4] - r[2], r[5] - r[3]));
      return r[6] === 3 ? `assists a goal with a ${yd}-yard pass` : r[6] === 2 ? `sets up a shot with a ${yd}-yard pass` : r[6] === 1 ? `plays a ${yd}-yard pass` : `plays a ${yd}-yard pass that doesn't find a teammate`;
    },
    C: (r) => `carries the ball ${Math.max(1, Math.round(Math.hypot(r[4] - r[2], r[5] - r[3])))} yards`,
    S: (r) => (r[6] === 3 ? 'scores' : 'shoots'),
    D: (r) => (r[6] === 1 ? 'dribbles past his man' : 'tries to dribble past his man and loses the ball'),
    R: () => 'receives the ball', B: () => 'wins the ball back', F: () => 'is fouled', U: (r) => (r[6] === 1 ? 'wins a duel' : 'loses a duel'),
    X: () => 'is dispossessed', M: () => 'miscontrols the ball', I: () => 'intercepts a pass', Q: () => 'presses an opponent',
    L: () => 'clears the ball', K: () => 'blocks a shot', O: () => 'commits a foul', Z: () => 'is dribbled past', H: () => 'contests a 50/50',
    W: () => 'shields the ball', E: () => 'makes an error', G: () => 'acts as goalkeeper',
  };
  let lastBanner = '', lastMoment = '';
  function renderHud(fs) {
    const c = clock(S.t);
    $('clock').textContent = c.label;
    $('period').textContent = PNAME[c.per.p] || '';
    const st = $('messi-state');
    if (onPitch(S.t)) { st.textContent = 'Messi on the pitch'; st.className = 'messi-state'; }
    else if (S.t < D.on) { st.textContent = `Messi on the bench, on at ${clock(D.on).label}`; st.className = 'messi-state off'; }
    else { st.textContent = `Messi off, ${clock(offT).label}`; st.className = 'messi-state off'; }
    renderScore();
    // banner for freeze frames
    let b = '';
    if (fs) {
      const what = isGoal(fs) ? 'GOAL' : outcome(fs.o).toUpperCase();
      const parts = [minuteLabel(fs), name(fs.p)];
      if (fs.ty && fs.ty !== 'Open Play') parts.push(fs.ty.toLowerCase());
      if (fs.b) parts.push(fs.b.toLowerCase());
      if (fs.a && isGoal(fs)) parts.push(`assist ${name(fs.a.p)}`);
      b = `<b>${RM.esc(what)}</b>${RM.esc(parts.join(' · '))}`;
    }
    if (b !== lastBanner) { $('banner').innerHTML = b; $('banner').hidden = !b; lastBanner = b; }
    // the moment
    const i = bsearch(ev, S.t);
    let m = '';
    if (i >= 0 && S.t - ev[i][0] < 30) m = `<span class="t">${clock(ev[i][0]).label}</span>Messi ${DESC[ev[i][1]]?.(ev[i]) || 'is involved'}.`;
    else if (onPitch(S.t)) m = '<span class="muted">Messi hasn\'t touched the ball in the last 30 seconds.</span>';
    if (m !== lastMoment) { $('moment').innerHTML = m; lastMoment = m; }
    document.querySelectorAll('#shots button').forEach((btn) => btn.setAttribute('aria-current', fs && +btn.dataset.t === fs.t ? 'true' : 'false'));
  }

  // ---------- timeline ----------
  const tlc = $('timeline');
  const tl = {
    layout() { const dpr = Math.min(devicePixelRatio || 1, 2.5); this.w = tlc.clientWidth; this.h = 46; tlc.width = this.w * dpr; tlc.height = this.h * dpr; this.ctx = tlc.getContext('2d'); this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); },
    X(t) { return 4 + (t / END) * (this.w - 8); },
    T(px) { return Math.max(0, Math.min(END, ((px - 4) / (this.w - 8)) * END)); },
    draw() {
      const { ctx, w, h } = this; if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const y0 = 18, bh = 14;
      for (const p of periods) { ctx.fillStyle = tok.line; ctx.fillRect(this.X(p.a), y0, Math.max(1, this.X(p.b) - this.X(p.a) - 2), bh); }
      // Messi on pitch
      ctx.fillStyle = tok.sol; ctx.globalAlpha = .35;
      ctx.fillRect(this.X(D.on), y0 + bh - 4, this.X(offT ?? END) - this.X(D.on), 4); ctx.globalAlpha = 1;
      // touches
      ctx.fillStyle = tok.ink; ctx.globalAlpha = .28;
      for (const r of ev) ctx.fillRect(Math.round(this.X(r[0])), y0 + 2, 1, bh - 7);
      ctx.globalAlpha = 1;
      // goals
      for (const s of shots) {
        if (!isGoal(s)) continue;
        const x = this.X(s.t);
        ctx.beginPath(); ctx.arc(x, 9, s.pe === 5 ? 3 : 5.5, 0, Math.PI * 2);
        if (s.tm === 0) { ctx.fillStyle = s.p === MESSI ? tok.sol : tok.ink; ctx.fill(); }
        else { ctx.strokeStyle = tok.opp; ctx.lineWidth = 2; ctx.stroke(); }
      }
      // playhead
      const x = this.X(S.t);
      ctx.fillStyle = tok.ink; ctx.fillRect(x - 1, 2, 2, h - 4);
    },
  };
  let dragging = false;
  const seekFromEvent = (e) => { const r = tlc.getBoundingClientRect(); S.t = tl.T(e.clientX - r.left); S.pinned = null; S.hold = 0; draw(); tl.draw(); };
  tlc.addEventListener('pointerdown', (e) => { dragging = true; tlc.setPointerCapture(e.pointerId); seekFromEvent(e); });
  tlc.addEventListener('pointermove', (e) => dragging && seekFromEvent(e));
  tlc.addEventListener('pointerup', () => { dragging = false; });

  // ---------- playback ----------
  let lastTs = 0;
  function frame(ts) {
    if (!S.playing) return;
    const dt = Math.min(.1, (ts - (lastTs || ts)) / 1000); lastTs = ts;
    if (S.hold > 0) { S.hold -= dt; }
    else {
      const prev = S.t;
      S.t = Math.min(END, S.t + dt * S.speed);
      // pause briefly on each goal so the freeze frame can be read
      const g = shots.find((s) => isGoal(s) && s.t > prev && s.t <= S.t);
      if (g) { S.t = g.t; S.hold = 2.8; }
      if (S.t >= END) setPlaying(false);
    }
    draw(); tl.draw(); tip.hidden = true;
    requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    S.playing = on; S.pinned = null;
    $('play').textContent = on ? '❚❚ Pause' : '▶ Play';
    if (on) { if (S.t >= END) S.t = 0; lastTs = 0; requestAnimationFrame(frame); }
  }
  $('play').addEventListener('click', () => setPlaying(!S.playing));
  const step = (dir) => {
    setPlaying(false);
    if (dir > 0) { const i = bsearch(ev, S.t); const n = ev.slice(i + 1).find((r) => r[0] > S.t); if (n) S.t = n[0]; }
    else { const i = bsearch(ev, S.t - 1); if (i >= 0) S.t = ev[i][0]; }
    draw(); tl.draw();
  };
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); setPlaying(!S.playing); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });
  function seg(el, key, onChange) {
    const sync = () => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === String(S[key]))));
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S[key] = key === 'speed' ? +b.dataset.v : b.dataset.v; sync(); onChange?.(); });
    sync();
  }
  seg($('speed'), 'speed');
  seg($('trail'), 'trail', draw);
  $('copy').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?id=${D.id}#t=${Math.floor(S.t)}`;
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); $('copy').textContent = 'Link copied'; }
    catch { $('copy').textContent = 'Link is in the address bar'; }
    setTimeout(() => { $('copy').textContent = 'Copy a link to this moment'; }, 1800);
  });

  // ---------- layers ----------
  const count = (f) => ev.filter(f).length;
  const LAYERS = [
    ['players', 'All players', PL.length || null],
    ['pass', 'His passes', count((r) => r[1] === 'P')],
    ['carry', 'Carries', count((r) => r[1] === 'C')],
    ['drib', 'Dribbles', count((r) => r[1] === 'D')],
    ['other', 'His other touches', count((r) => !'PCDS'.includes(r[1]))],
    ['shots', 'All shots', shots.filter((s) => s.pe !== 5).length],
    ['ball', 'Ball', null],
    ['heat', 'Where he played', null],
  ];
  $('layers').innerHTML = LAYERS.map(([k, l, n]) => `<label for="ly-${k}"><input type="checkbox" id="ly-${k}" data-k="${k}"${S.layers[k] ? ' checked' : ''}>${l}${n != null ? ` <span class="n">${n}</span>` : ''}</label>`).join('');
  $('layers').addEventListener('change', (e) => { S.layers[e.target.dataset.k] = e.target.checked; draw(); });

  // ---------- stats ----------
  const inPlay = shots.filter((s) => s.pe !== 5);
  const mg = inPlay.filter((s) => s.p === MESSI && s.o === 'Goal').length;
  const ms = inPlay.filter((s) => s.p === MESSI).length;
  const passes = ev.filter((r) => r[1] === 'P'), pDone = passes.filter((r) => r[6] >= 1).length;
  const kp = passes.filter((r) => r[6] >= 2).length, ast = passes.filter((r) => r[6] === 3).length;
  const dr = ev.filter((r) => r[1] === 'D'), drw = dr.filter((r) => r[6] === 1).length;
  const playEnd = Math.max(...periods.filter((p) => p.p <= 4).map((p) => p.b));
  const mins = Math.round(((offT ?? playEnd) - D.on) / 60);
  const stat = (dt, dd, sm = '') => `<div><dt>${dt}</dt><dd>${dd}${sm ? `<small>${sm}</small>` : ''}</dd></div>`;
  $('mstats').innerHTML = [
    stat('Goals', mg), stat('Assists', ast), stat('Shots', ms),
    stat('Passes completed', pDone, `/ ${passes.length}`), stat('Chances created', kp),
    stat('Dribbles completed', drw, `/ ${dr.length}`), stat('Events recorded', ev.length), stat('Minutes', mins),
  ].join('');
  if (idx.length) {
    const tm = idx.reduce((a, m) => a + m.mins, 0) / 90;
    const avgT = idx.reduce((a, m) => a + m.touches, 0) / tm, avgS = idx.reduce((a, m) => a + m.shots, 0) / tm;
    const p90 = (v) => (mins ? (v / mins) * 90 : 0);
    $('isthatalot').textContent = `Is that a lot? Per 90 minutes here: ${p90(ev.length).toFixed(0)} events and ${p90(ms).toFixed(1)} shots. His average across the archive: ${avgT.toFixed(0)} events and ${avgS.toFixed(1)} shots.`;
  }

  // ---------- shot list ----------
  const listed = shots.filter((s) => isGoal(s) || s.p === MESSI);
  $('shots').innerHTML = listed.length ? listed.map((s) => {
    const dot = s.p === MESSI ? 'messi' : s.tm === 0 ? '' : 'opp';
    const tag = isGoal(s) ? (s.ty === 'Penalty' ? 'goal · pen' : s.ty === 'Own Goal' ? 'own goal' : 'goal') : outcome(s.o);
    return `<li><button type="button" data-t="${s.t}" class="${isGoal(s) ? 'goal' : ''}"><span class="m">${minuteLabel(s)}</span><i class="dot ${dot}"></i><span class="who">${RM.esc(name(s.p))}</span><span class="tag ${isGoal(s) ? 'goal' : ''}">${RM.esc(tag)}</span></button></li>`;
  }).join('') : '<li class="muted">No goals and no Messi shots in this match.</li>';
  $('shots').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const s = shots.find((x) => x.t === +b.dataset.t && (isGoal(x) || x.p === MESSI));
    setPlaying(false); S.t = s.t; S.pinned = s; draw(); tl.draw();
    pitch.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  });

  // ---------- other matches ----------
  const pos = idx.findIndex((m) => m.id === D.id);
  const link = (m, label) => (m ? `<a href="match.html?id=${m.id}">${label}: ${RM.esc(m.opp)}, ${RM.fmtDate(m.date)}</a>` : '');
  $('others').innerHTML = [link(idx[pos - 1], '← Previous'), link(idx[pos + 1], 'Next →'),
    `<a href="archive.html?team=${encodeURIComponent(D.team)}&season=${encodeURIComponent(D.season)}">All of ${RM.esc(D.team)} ${RM.seasonLabel(D.season)}</a>`].filter(Boolean).join('');

  // ---------- player labels on hover / tap ----------
  const tip = $('tip');
  function showTip(e) {
    const r = pitch.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = Infinity;
    for (const d of drawn) { const dist = Math.hypot(d.x - mx, d.y - my); if (dist < d.r + 6 && dist < bd) { bd = dist; best = d; } }
    if (!best) { tip.hidden = true; return; }
    const how = best.stale <= 2 ? 'placed by the record' : `estimated · last placed ${Math.round(best.stale)}s away`;
    tip.innerHTML = `${best.p.no != null ? best.p.no + ' · ' : ''}${RM.esc(best.p.n)}<small>${how}</small>`;
    tip.style.left = best.x + 'px'; tip.style.top = best.y + 'px'; tip.hidden = false;
  }
  pitch.addEventListener('pointermove', showTip);
  pitch.addEventListener('pointerdown', showTip);
  pitch.addEventListener('pointerleave', () => { tip.hidden = true; });

  $('possrc').innerHTML = !PL.length ? ''
    : D.has360
      ? '<b>Player positions: StatsBomb 360.</b> At every event, each player in the camera\'s view was recorded. Between frames, markers slide in straight lines. Hover a player for his name.'
      : '<b>Player positions: estimated.</b> No camera data exists for this match. Each player sits where his own last action happened and slides toward his next. At every shot, all positions are exact. Hover a player for his name.';

  // ---------- go ----------
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 100); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTokens(); draw(); tl.draw(); });
  layout(); tl.draw();
  document.fonts?.ready.then(() => draw());
})();
