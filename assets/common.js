// Shared helpers for Reading Messi. Coordinates are StatsBomb yards: 120 x 80,
// origin top-left, Messi's team always attacking left -> right.
const RM = (() => {
  const TEAM = {
    'Barcelona':           { c1: '#a50044', c2: '#004d98', short: 'BAR' },
    'Paris Saint-Germain': { c1: '#004170', c2: '#da291c', short: 'PSG' },
    'Inter Miami':         { c1: '#f7b5cd', c2: '#231f20', short: 'MIA' },
    'Argentina':           { c1: '#75aadb', c2: '#ffffff', short: 'ARG' },
  };
  const teamStyle = (t) => TEAM[t] || { c1: '#8a958e', c2: '#3c4741', short: (t || '').slice(0, 3).toUpperCase() };
  const teamChip = (t) => {
    const s = teamStyle(t);
    return `<span class="team"><i class="swatch" style="--c1:${s.c1};--c2:${s.c2}"></i>${esc(t)}</span>`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (d) => { const [y, m, dd] = d.split('-'); return `${+dd} ${MONTHS[+m - 1]} ${y}`; };
  const COMP_SHORT = { 'La Liga': 'La Liga', 'Ligue 1': 'Ligue 1', 'Champions League': 'UCL', 'FIFA World Cup': 'World Cup', 'Copa America': 'Copa América', 'Major League Soccer': 'MLS' };
  const compShort = (c) => COMP_SHORT[c] || c;
  const result = (m) => (m.gf > m.ga ? 'W' : m.gf < m.ga ? 'L' : 'D');
  // Season label everyone recognises: "2011/2012" -> "2011–12", "2022" stays.
  const seasonLabel = (s) => (s.includes('/') ? `${s.slice(0, 4)}–${s.slice(7, 9)}` : s);

  let indexPromise;
  const loadIndex = () => (indexPromise ||= fetch('data/index.json').then((r) => {
    if (!r.ok) throw new Error('data/index.json is missing. Run: python3 scripts/build_data.py');
    return r.json();
  }));

  // ---------- pitch ----------
  // P(x,y) -> [px,py] maps pitch yards to canvas pixels; s = pixels per yard.
  function drawPitch(ctx, P, s, opts = {}) {
    const { x0 = 0, x1 = 120, stripes = true } = opts;
    const css = getComputedStyle(document.documentElement);
    const grass = css.getPropertyValue('--pitch').trim();
    const grass2 = css.getPropertyValue('--pitch-2').trim();
    const chalk = css.getPropertyValue('--chalk').trim();
    const poly = (pts, close) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      if (close) ctx.closePath();
    };
    const rect = (ax, ay, bx, by) => poly([[ax, ay], [bx, ay], [bx, by], [ax, by]], true);
    const arc = (cx, cy, r, a0, a1, n = 48) => {
      const pts = [];
      for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      return pts;
    };
    // grass + mowing stripes (12 bands, like a real pitch)
    rect(x0 - 4, -4, x1 + 4, 84); ctx.fillStyle = grass; ctx.fill();
    if (stripes) {
      for (let i = 0; i < 12; i += 2) {
        const a = i * 10, b = a + 10;
        if (b < x0 || a > x1) continue;
        rect(Math.max(a, x0), 0, Math.min(b, x1), 80); ctx.fillStyle = grass2; ctx.fill();
      }
    }
    ctx.strokeStyle = chalk; ctx.lineWidth = Math.max(1, s * 0.35); ctx.lineJoin = 'round';
    rect(0, 0, 120, 80); ctx.stroke();
    poly([[60, 0], [60, 80]]); ctx.stroke();
    poly(arc(60, 40, 10, 0, Math.PI * 2, 72), true); ctx.stroke();
    for (const side of [0, 1]) {
      const X = (v) => (side ? 120 - v : v);
      rect(X(0), 18, X(18), 62); ctx.stroke();
      rect(X(0), 30, X(6), 50); ctx.stroke();
      rect(X(0), 36, X(-2), 44); ctx.stroke();
      const d = Math.acos(6 / 10); // arc outside the box
      poly(side ? arc(108, 40, 10, Math.PI - d, Math.PI + d) : arc(12, 40, 10, -d, d)); ctx.stroke();
      const [sx, sy] = P(X(12), 40); ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.5, s * .45), 0, Math.PI * 2); ctx.fillStyle = chalk; ctx.fill();
    }
    const [cx, cy] = P(60, 40); ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, s * .45), 0, Math.PI * 2); ctx.fill();
  }

  // Size a canvas to its CSS box at device pixel ratio; returns {ctx,w,h}.
  function fitCanvas(canvas, aspect) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = canvas.clientWidth; const h = Math.round(w / aspect);
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function header(active) {
    const items = [['index.html', 'Home'], ['archive.html', 'Every match'], ['about.html', 'What you can see here']];
    return `<div class="wrap"><a class="brand" href="index.html"><i class="ball"></i>Reading Messi</a>
      <nav class="site-nav" aria-label="Main">${items.map(([h, l]) => `<a href="${h}"${h === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav></div>`;
  }
  function footer() {
    return `<div class="wrap">
      <p>Event data: <a href="https://github.com/statsbomb/open-data" target="_blank" rel="noopener">StatsBomb Open Data</a>, used under the StatsBomb public data user agreement. Every mark on every pitch comes from a recorded StatsBomb event.</p>
      <p>A fan project. Not affiliated with Lionel Messi, any club, league or federation. No club crests or logos appear here; teams are shown by colour and name.</p>
    </div>`;
  }
  function chrome(active) {
    const h = document.querySelector('header.site-head'); if (h) h.innerHTML = header(active);
    const f = document.querySelector('footer'); if (f) f.innerHTML = footer();
  }

  return { TEAM, teamStyle, teamChip, esc, fmtDate, compShort, result, seasonLabel, loadIndex, drawPitch, fitCanvas, chrome };
})();
