"""Position tracks for every player in a match, built only from recorded data.

Three sources, best first:
  1. Shot freeze-frames: every captured player, identified, at the instant of a shot.
  2. The player's own events: where he passed, received, pressed, tackled...
  3. StatsBomb 360 frames (where released): every player in the camera's view at each
     event. These dots are anonymous, so each one is matched to the player we expect
     closest to it (greedy nearest match within MAX_MATCH yards).

Output per player: {'n': name, 'no': shirt, 'tm': 0 Messi's team / 1 opponent, 'gk': 0/1,
                    'iv': [[on, off], ...], 'tr': [dt, x, y, dt, x, y, ...]}
dt is tenths of a second since the previous sample (the first is since kick-off).
"""
import bisect
import math

MAX_MATCH = 15.0      # yards: furthest a 360 dot may be from a player's predicted spot
FRESH = 3.0           # seconds: an own-event sample this recent beats everything else


def _mmss(s):
    m, sec = s.split(':')
    return int(m) * 60 + int(sec)


def build_players(ev, frames, lineups, mteam, T, flip, off, pstart, end):
    info = {}
    for tl in lineups:
        tm = 0 if tl['team_name'] == mteam else 1
        for pl in tl['lineup']:
            pos = pl.get('positions') or []
            if not pos:
                continue
            iv = []
            for st in pos:
                fp = st.get('from_period') or 1
                a = _mmss(st['from']) + off.get(fp, 0) if st.get('from') else 0
                if st.get('to'):
                    tp = st.get('to_period') or fp
                    b = _mmss(st['to']) + off.get(tp, 0)
                else:
                    b = end
                iv.append([round(a, 1), round(b, 1)])
            iv.sort()
            merged = []
            for a, b in iv:
                if merged and a <= merged[-1][1] + 1:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            info[pl['player_id']] = {
                'n': pl.get('player_nickname') or pl['player_name'],
                'no': pl.get('jersey_number'), 'tm': tm,
                'gk': 1 if any(st['position'] == 'Goalkeeper' for st in pos) else 0,
                'iv': merged, 'team': tl['team_name'],
            }

    def on_pitch(pid, t):
        return any(a - 1 <= t <= b + 1 for a, b in info[pid]['iv'])

    exact = {pid: [] for pid in info}          # (t, x, y, src)
    by_id = {}
    for e in ev:
        by_id[e['id']] = e
        pid = e.get('player', {}).get('id')
        if pid in exact and e.get('location'):
            t = T(e)
            x, y = flip(e, e['location'])
            exact[pid].append((t, x, y, 0))
            if e['type']['name'] == 'Carry' and e.get('carry', {}).get('end_location'):
                ex, ey = flip(e, e['carry']['end_location'])
                exact[pid].append((round(t + max(0.3, e.get('duration') or 1), 1), ex, ey, 0))
        if e['type']['name'] == 'Shot':
            for f in e['shot'].get('freeze_frame', []):
                fid = f['player']['id']
                if fid in exact:
                    x, y = flip(e, f['location'])
                    exact[fid].append((T(e), x, y, 1))
    for pid in exact:
        exact[pid].sort()
    times = {pid: [s[0] for s in exact[pid]] for pid in exact}

    def interp(pid, t):
        """Position from exact samples, plus seconds to the nearest one."""
        arr, ts = exact[pid], times[pid]
        if not arr:
            return None, math.inf
        i = bisect.bisect_right(ts, t)
        if i == 0:
            return arr[0][1:3], ts[0] - t
        if i == len(arr):
            return arr[-1][1:3], t - ts[-1]
        a, b = arr[i - 1], arr[i]
        k = (t - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0
        return (a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k), min(t - a[0], b[0] - t)

    matched = {pid: [] for pid in info}
    if frames:
        last = {}
        rows = []
        for fr in frames:
            e = by_id.get(fr.get('event_uuid'))
            if e is None or not fr.get('freeze_frame'):
                continue
            rows.append((T(e), e, fr['freeze_frame']))
        rows.sort(key=lambda r: r[0])
        for t, e, ff in rows:
            actor = e.get('player', {}).get('id')
            ev_team = e['team']['name']
            groups = {}
            for d in ff:
                if d.get('actor'):
                    continue
                team = ev_team if d.get('teammate') else next(
                    (v['team'] for v in info.values() if v['team'] != ev_team), None)
                if team is None:
                    continue
                x, y = flip(e, d['location'])
                groups.setdefault(team, []).append((x, y, bool(d.get('keeper'))))
            for team, dots in groups.items():
                cands = [pid for pid, v in info.items()
                         if v['team'] == team and pid != actor and on_pitch(pid, t)]
                # keeper dots go straight to the goalkeeper
                gks = [pid for pid in cands if info[pid]['gk']]
                rest = []
                for x, y, kp in dots:
                    if kp and gks:
                        matched[gks[0]].append((t, x, y, 2)); last[gks[0]] = (t, x, y)
                    else:
                        rest.append((x, y))
                outfield = [pid for pid in cands if not info[pid]['gk']]
                preds = {}
                for pid in outfield:
                    p, stale = interp(pid, t)
                    if pid in last and (t - last[pid][0]) < stale and stale > FRESH:
                        p = last[pid][1:3]
                    if p is not None:
                        preds[pid] = p
                pairs = sorted((math.hypot(px - x, py - y), pid, j)
                               for pid, (px, py) in preds.items() for j, (x, y) in enumerate(rest))
                used_p, used_d = set(), set()
                for dist, pid, j in pairs:
                    if dist > MAX_MATCH:
                        break
                    if pid in used_p or j in used_d:
                        continue
                    used_p.add(pid); used_d.add(j)
                    x, y = rest[j]
                    matched[pid].append((t, x, y, 2)); last[pid] = (t, x, y)

    out = {}
    for pid, v in info.items():
        samples = sorted(exact[pid] + matched[pid])
        samples = [s for s in samples if on_pitch(pid, s[0])]
        # compact: [dt, x, y, ...] with dt in tenths of a second since the previous sample
        tr, prev, last10 = [], None, 0
        for t, x, y, src in samples:
            if prev and src == 2 and t - prev[0] < 0.6 and math.hypot(x - prev[1], y - prev[2]) < 1.5:
                continue
            t10 = round(t * 10)
            tr += [t10 - last10, round(x), round(y)]
            last10 = t10
            prev = (t, x, y)
        out[str(pid)] = {'n': v['n'], 'no': v['no'], 'tm': v['tm'], 'gk': v['gk'], 'iv': v['iv'], 'tr': tr}
    return out
