(async () => {
  RM.chrome('index.html');
  let idx;
  try { idx = await RM.loadIndex(); } catch (e) {
    document.getElementById('stats').innerHTML = `<p>${RM.esc(e.message)}</p>`; return;
  }

  const final = idx.find((m) => m.comp === 'FIFA World Cup' && m.season === '2022' && m.stage === 'Final');
  if (final) document.getElementById('final-link').href = `match.html?id=${final.id}`;

  // ---- goal map: attacking half, goal at the top ----
  const goals = idx.flatMap((m) => m.gl.map((g) => ({ x: g[0], y: g[1], body: g[2], type: g[3] })));
  const canvas = document.getElementById('goalmap');
  function drawGoalMap() {
    const M = 3; const W = 80 + 2 * M; const H = 62 + 2 * M;
    const { ctx, w } = RM.fitCanvas(canvas, W / H);
    const s = w / W;
    const P = (x, y) => [(M + y) * s, (M + 120 - x) * s];
    RM.drawPitch(ctx, P, s, { x0: 58, x1: 120 });
    const css = getComputedStyle(document.documentElement);
    const sol = css.getPropertyValue('--sol').trim();
    for (const g of goals) {
      const [px, py] = P(g.x, g.y);
      ctx.beginPath(); ctx.arc(px, py, Math.max(2, s * .55), 0, Math.PI * 2);
      if (g.type === 'Penalty') { ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2; ctx.stroke(); continue; }
      ctx.fillStyle = g.body === 'Left Foot' ? sol : g.body === 'Head' ? '#9fd4ff' : 'rgba(255,255,255,.9)';
      ctx.globalAlpha = .85; ctx.fill(); ctx.globalAlpha = 1;
    }
  }
  drawGoalMap();
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawGoalMap, 120); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawGoalMap);
  const heads = goals.filter((g) => g.body === 'Head').length;
  document.getElementById('goalmap-cap').textContent =
    `All ${goals.length} goals in the archive, at the spot each was struck from. Yellow: left foot. White: right foot. Blue: header (${heads}). Ringed: penalty.`;

  // ---- what we count ----
  const sum = (f) => idx.reduce((a, m) => a + f(m), 0);
  const G = goals.length, mins = sum((m) => m.mins), A = sum((m) => m.assists);
  const nonPen = goals.filter((g) => g.type !== 'Penalty');
  const outBoxNP = nonPen.filter((g) => !(g.x >= 102 && g.y >= 18 && g.y <= 62)).length;
  const left = goals.filter((g) => g.body === 'Left Foot').length;
  const dr = sum((m) => m.dribbles), drw = sum((m) => m.dribblesWon);
  const pens = sum((m) => m.pens), fk = sum((m) => m.fk);
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const cards = [
    [`${G}`, `in ${idx.length} matches`, 'Goals', `${(G / (mins / 90)).toFixed(2)} per 90 minutes across ${mins.toLocaleString()} minutes on the pitch.`, 'm-goals'],
    [`${pct(left, G)}%`, '', 'Left foot', `${left} of ${G} goals came off his left foot. ${goals.filter((g) => g.body === 'Right Foot').length} came off his right.`, 'm-foot'],
    [`${pct(outBoxNP, nonPen.length)}%`, '', 'From outside the box', `${outBoxNP} of his ${nonPen.length} non-penalty goals were struck from outside the penalty area.`, 'm-box'],
    [`${A}`, '', 'Assists', 'Passes the record marks as setting up a goal by a teammate.', 'm-assists'],
    [`${pct(drw, dr)}%`, `of ${dr.toLocaleString()}`, 'Dribbles completed', `${drw.toLocaleString()} times he took a defender on and came out with the ball.`, 'm-dribbles'],
    [`${pens + fk}`, '', 'Dead-ball goals', `${pens} penalties and ${fk} direct free kicks.`, 'm-setpiece'],
  ];
  document.getElementById('stats').innerHTML = cards.map(([big, sm, h, p, anchor]) => `
    <article class="stat"><div class="big num">${big}${sm ? ` <small>${sm}</small>` : ''}</div>
      <h3>${h}</h3><p>${p}</p><a href="about.html#${anchor}">How we counted this →</a></article>`).join('');

  // ---- seasons, grouped by club ----
  const order = ['Barcelona', 'Paris Saint-Germain', 'Inter Miami', 'Argentina'];
  const groups = new Map();
  for (const m of idx) {
    const key = `${m.team}|${m.season}`;
    if (!groups.has(key)) groups.set(key, { team: m.team, season: m.season, n: 0, g: 0, mins: 0, comps: new Set() });
    const g = groups.get(key); g.n++; g.g += m.goals; g.mins += m.mins; g.comps.add(RM.compShort(m.comp));
  }
  const all = [...groups.values()];
  const best = Math.max(...all.map((g) => (g.mins ? g.g / (g.mins / 90) : 0)));
  document.getElementById('eras').innerHTML = order.map((team) => {
    const list = all.filter((g) => g.team === team).sort((a, b) => a.season.localeCompare(b.season));
    if (!list.length) return '';
    const st = RM.teamStyle(team);
    return `<div class="era"><h3><i class="swatch" style="--c1:${st.c1};--c2:${st.c2}"></i>${RM.esc(team)}</h3>
      <div class="seasons">${list.map((g) => {
        const p90 = g.mins ? g.g / (g.mins / 90) : 0;
        return `<a class="season" href="archive.html?team=${encodeURIComponent(team)}&season=${encodeURIComponent(g.season)}">
          <b>${RM.seasonLabel(g.season)}</b>
          <span>${[...g.comps].join(' · ')}</span>
          <span class="num">${g.n} matches · ${g.g} goals</span>
          <span class="bar" title="${p90.toFixed(2)} goals per 90"><i style="width:${Math.round(100 * p90 / best)}%"></i></span>
        </a>`;
      }).join('')}</div></div>`;
  }).join('');
})();
