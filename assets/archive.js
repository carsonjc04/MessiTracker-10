(async () => {
  RM.chrome('archive.html');
  const $ = (id) => document.getElementById(id);
  let idx;
  try { idx = await RM.loadIndex(); } catch (e) { $('count').textContent = e.message; return; }

  const params = new URLSearchParams(location.search);
  const uniq = (f) => [...new Set(idx.map(f))];
  const fill = (sel, vals, label = (v) => v) => {
    sel.insertAdjacentHTML('beforeend', vals.map((v) => `<option value="${RM.esc(v)}">${RM.esc(label(v))}</option>`).join(''));
  };
  fill($('f-team'), ['Barcelona', 'Paris Saint-Germain', 'Inter Miami', 'Argentina'].filter((t) => idx.some((m) => m.team === t)));
  fill($('f-comp'), uniq((m) => m.comp).sort(), RM.compShort);
  fill($('f-season'), uniq((m) => m.season).sort().reverse(), RM.seasonLabel);
  $('f-team').value = params.get('team') || '';
  $('f-season').value = params.get('season') || '';
  $('f-comp').value = params.get('comp') || '';

  function render() {
    const team = $('f-team').value, comp = $('f-comp').value, season = $('f-season').value;
    const q = $('f-q').value.trim().toLowerCase(), scored = $('f-scored').checked, order = $('f-order').value;
    let list = idx.filter((m) => (!team || m.team === team) && (!comp || m.comp === comp) && (!season || m.season === season)
      && (!q || m.opp.toLowerCase().includes(q)) && (!scored || m.goals > 0));
    list = list.slice().sort(order === 'old' ? (a, b) => a.date.localeCompare(b.date)
      : order === 'goals' ? (a, b) => b.goals - a.goals || b.assists - a.assists || b.date.localeCompare(a.date)
      : (a, b) => b.date.localeCompare(a.date));
    const g = list.reduce((a, m) => a + m.goals, 0), as = list.reduce((a, m) => a + m.assists, 0);
    $('count').textContent = `${list.length} matches · ${g} goals · ${as} assists`;
    let lastMonth = '';
    $('rows').innerHTML = list.map((m) => {
      let head = '';
      const month = m.date.slice(0, 7);
      if (order !== 'goals' && month !== lastMonth) {
        lastMonth = month;
        head = `<tr class="month"><td colspan="6">${RM.fmtDate(m.date + '').split(' ').slice(1).join(' ')}</td></tr>`;
      }
      const r = RM.result(m);
      const ga = [m.goals ? `<b>${m.goals}G</b>` : '', m.assists ? `${m.assists}A` : ''].filter(Boolean).join(' ') || '<span class="muted">–</span>';
      const stage = m.stage && m.stage !== 'Regular Season' ? ` · ${m.stage}` : '';
      return `${head}<tr data-id="${m.id}" tabindex="0">
        <td class="num">${RM.fmtDate(m.date)}</td>
        <td>${RM.esc(RM.compShort(m.comp))}<span class="muted">${RM.esc(stage)}</span></td>
        <td>${m.isHome ? '' : '<span class="muted">at </span>'}${RM.esc(m.opp)}</td>
        <td class="r num"><span class="res ${r}">${r}</span> ${m.gf}–${m.ga}</td>
        <td class="r ga">${ga}</td>
        <td class="r num">${m.start ? '' : '<span class="muted" title="Came off the bench">sub </span>'}${m.mins}'</td></tr>`;
    }).join('');
  }
  const go = (tr) => tr?.dataset.id && (location.href = `match.html?id=${tr.dataset.id}`);
  $('rows').addEventListener('click', (e) => go(e.target.closest('tr')));
  $('rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e.target.closest('tr')); });
  $('filters').addEventListener('input', render);
  render();
})();
