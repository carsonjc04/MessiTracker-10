"""Build compact per-match JSON for every Messi match in StatsBomb open data.

Data: StatsBomb Open Data (https://github.com/statsbomb/open-data), CC BY-NC-SA-like
user agreement — attribution required.  Run:  python3 scripts/build_data.py
"""
import bisect, json, os, sys, urllib.request
from players import build_players
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data')
CACHE = os.path.join(ROOT, '.cache')
MESSI = 5503
TEAMS = {'Barcelona', 'Argentina', 'Paris Saint-Germain', 'Inter Miami'}
COMPS = {11, 16, 43, 7, 44, 223}
MIN_YEAR = 2004

def get(path):
    local = os.path.join(CACHE, path.replace('/', '_'))
    if not os.path.exists(local):
        os.makedirs(CACHE, exist_ok=True)
        with urllib.request.urlopen(BASE + path, timeout=120) as r:
            data = r.read()
        with open(local + '.tmp', 'wb') as f: f.write(data)
        os.replace(local + '.tmp', local)
    with open(local, 'rb') as f:
        return json.loads(f.read())

r1 = lambda v: round(v, 1)

TYPE = {'Pass': 'P', 'Carry': 'C', 'Shot': 'S', 'Dribble': 'D', 'Ball Receipt*': 'R',
        'Ball Recovery': 'B', 'Foul Won': 'F', 'Duel': 'U', 'Dispossessed': 'X',
        'Miscontrol': 'M', 'Interception': 'I', 'Pressure': 'Q', 'Clearance': 'L',
        'Block': 'K', 'Foul Committed': 'O', 'Goal Keeper': 'G', 'Dribbled Past': 'Z',
        '50/50': 'H', 'Shield': 'W', 'Error': 'E', 'Own Goal For': 'Y', 'Own Goal Against': 'A'}

def process(m, comp):
    mid = m['match_id']
    out_path = os.path.join(OUT, 'matches', f'{mid}.json')
    ev = get(f'events/{mid}.json')
    if not any(e.get('player', {}).get('id') == MESSI for e in ev):
        return None
    home = m['home_team']['home_team_name']; away = m['away_team']['away_team_name']
    mteam = next(e['team']['name'] for e in ev if e.get('player', {}).get('id') == MESSI)
    # replay clock: periods laid end to end
    pmax = {}
    pstart = {1: 0, 2: 45 * 60, 3: 90 * 60, 4: 105 * 60, 5: 120 * 60}
    def clk(e):  # match-clock seconds, sub-second precision from the event timestamp
        h, mi, se = e['timestamp'].split(':')
        return pstart.get(e['period'], 0) + int(h) * 3600 + int(mi) * 60 + float(se)
    for e in ev:
        pmax[e['period']] = max(pmax.get(e['period'], 0), clk(e))
    off, acc = {}, 0
    for p in sorted(pmax):
        off[p] = acc - pstart.get(p, 0)
        acc = pmax[p] + off[p] + 1
    def T(e): return round(clk(e) + off[e['period']], 1)
    def flip(e, loc):
        if loc is None: return None
        x, y = loc[0], loc[1]
        if e['team']['name'] != mteam: x, y = 120 - x, 80 - y
        return [r1(x), r1(y)]

    # lineups / minutes
    on, offm, started = None, None, False
    for e in ev:
        if e['type']['name'] == 'Starting XI' and e['team']['name'] == mteam:
            if any(p['player']['id'] == MESSI for p in e['tactics']['lineup']):
                started, on = True, 0
        if e['type']['name'] == 'Substitution' and e['team']['name'] == mteam:
            if e['substitution']['replacement']['id'] == MESSI: on = T(e)
            if e.get('player', {}).get('id') == MESSI: offm = T(e)
        if e['type']['name'] == 'Bad Behaviour' and e.get('player', {}).get('id') == MESSI:
            if e.get('bad_behaviour', {}).get('card', {}).get('name') in ('Red Card', 'Second Yellow'): offm = T(e)
        if e['type']['name'] == 'Foul Committed' and e.get('player', {}).get('id') == MESSI:
            if e.get('foul_committed', {}).get('card', {}).get('name') in ('Red Card', 'Second Yellow'): offm = T(e)
    end = acc - 1
    play_end = max(v for p, v in ((p, pmax[p] + off[p]) for p in pmax) if p <= 4)
    if on is None: on = next(T(e) for e in ev if e.get('player', {}).get('id') == MESSI)

    nick = {}
    try:
        for tl in get(f'lineups/{mid}.json'):
            for pl in tl['lineup']:
                nick[pl['player_id']] = pl.get('player_nickname') or pl['player_name']
    except Exception:
        pass
    names = {}
    def pname(p):
        names[p['id']] = nick.get(p['id']) or p['name']; return p['id']

    ball, messi, shots = [], [], []
    passmap = {}
    for e in ev:
        if 'location' in e and e['type']['name'] not in ('Pressure',):
            loc = flip(e, e['location'])
            ball.append([T(e), loc[0], loc[1], 0 if e['team']['name'] == mteam else 1])
        if e['type']['name'] == 'Pass':
            passmap[e['id']] = e
    for e in ev:
        tn = e['type']['name']
        pid = e.get('player', {}).get('id')
        if tn == 'Shot':
            s = e['shot']
            ff = []
            for f in s.get('freeze_frame', []):
                ff.append([*flip(e, f['location']), 1 if f['teammate'] else 0,
                           1 if f['position']['name'] == 'Goalkeeper' else 0, pname(f['player'])])
            ast = None
            if s.get('key_pass_id') and s['key_pass_id'] in passmap:
                kp = passmap[s['key_pass_id']]
                ast = {'p': pname(kp['player']), 'l': flip(kp, kp['location']), 'e': flip(kp, kp['pass']['end_location'])}
            shots.append({'t': T(e), 'm': e['minute'], 's': e['second'], 'pe': e['period'],
                          'tm': 0 if e['team']['name'] == mteam else 1, 'p': pname(e['player']),
                          'l': flip(e, e['location']), 'e': flip(e, s['end_location'][:2]),
                          'z': r1(s['end_location'][2]) if len(s['end_location']) > 2 else None,
                          'o': s['outcome']['name'], 'b': s['body_part']['name'], 'ty': s['type']['name'],
                          'tech': s.get('technique', {}).get('name'), 'ff': ff, 'a': ast,
                          'pp': e.get('play_pattern', {}).get('name')})
        if tn == 'Own Goal For':
            shots.append({'t': T(e), 'm': e['minute'], 's': e['second'], 'pe': e['period'],
                          'tm': 0 if e['team']['name'] == mteam else 1, 'p': None, 'l': flip(e, e.get('location')),
                          'e': None, 'o': 'Own Goal', 'b': None, 'ty': 'Own Goal', 'ff': [], 'a': None})
        if pid == MESSI and tn in TYPE and 'location' in e:
            l = flip(e, e['location']); en = None; fl = 0
            if tn == 'Pass':
                p = e['pass']; en = flip(e, p['end_location'])
                fl = 1 if 'outcome' not in p else 0
                if p.get('goal_assist'): fl = 3
                elif p.get('shot_assist'): fl = 2
            elif tn == 'Carry': en = flip(e, e['carry']['end_location']); fl = 1
            elif tn == 'Shot':
                en = flip(e, e['shot']['end_location'][:2]); fl = 3 if e['shot']['outcome']['name'] == 'Goal' else 0
            elif tn == 'Dribble': fl = 1 if e['dribble']['outcome']['name'] == 'Complete' else 0
            elif tn == 'Duel': fl = 1 if e.get('duel', {}).get('outcome', {}).get('name', '').startswith(('Won', 'Success')) else 0
            row = [T(e), TYPE[tn], l[0], l[1]]
            if tn in ('Pass', 'Carry', 'Shot', 'Dribble', 'Duel'): row += [en[0] if en else None, en[1] if en else None, fl]
            messi.append(row)
    ball.sort(key=lambda r: r[0])
    # dedupe ball: drop points closer than 0.3 s to the previous one
    db, last_t = [], None
    for b in ball:
        if last_t is None or b[0] - last_t >= 0.3:
            db.append(b); last_t = b[0]
    # compact: flat [dt, x, y, team, ...], dt in tenths of a second since the previous point
    flat, last10 = [], 0
    for t, x, y, tm in db:
        t10 = round(t * 10)
        flat += [t10 - last10, round(x), round(y), tm]
        last10 = t10
    db = flat
    try:
        frames = get(f'three-sixty/{mid}.json') if m.get('match_status_360') == 'available' else None
    except Exception:
        frames = None
    players = build_players(ev, frames, get(f'lineups/{mid}.json'), mteam, T, flip, off, pstart, end)
    for sh in shots: sh.pop('ff', None)

    is_home = mteam == home
    data = {
        'id': mid, 'date': m['match_date'], 'ko': m.get('kick_off'),
        'comp': comp['competition_name'], 'season': comp['season_name'],
        'stage': m.get('competition_stage', {}).get('name'),
        'stadium': (m.get('stadium') or {}).get('name'),
        'home': home, 'away': away, 'hs': m['home_score'], 'as': m['away_score'],
        'team': mteam, 'opp': away if is_home else home, 'isHome': is_home,
        'on': on, 'off': offm, 'start': started, 'end': end,
        'periods': {str(p): [pstart.get(p, 0) + off[p], pmax[p] + off[p]] for p in pmax},
        'names': names, 'messi': messi, 'shots': shots, 'ball': db,
        'players': players, 'has360': frames is not None,
    }
    with open(out_path, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    mg = [s for s in shots if s['p'] == MESSI and s['o'] == 'Goal' and s['pe'] <= 4]
    return {
        'id': mid, 'date': m['match_date'], 'comp': comp['competition_name'], 'season': comp['season_name'],
        'stage': data['stage'], 'team': mteam, 'opp': data['opp'], 'isHome': is_home,
        'gf': m['home_score'] if is_home else m['away_score'], 'ga': m['away_score'] if is_home else m['home_score'],
        'start': started, 'mins': round(((offm if offm is not None else play_end) - on) / 60),
        'goals': len(mg), 'assists': sum(1 for r in messi if r[1] == 'P' and len(r) > 6 and r[6] == 3),
        'shots': sum(1 for s in shots if s['p'] == MESSI and s['pe'] <= 4),
        'pens': sum(1 for s in mg if s['ty'] == 'Penalty'),
        'fk': sum(1 for s in mg if s['ty'] == 'Free Kick'),
        'gl': [[s['l'][0], s['l'][1], s['b'], s['ty']] for s in mg],
        'dribbles': sum(1 for r in messi if r[1] == 'D'),
        'dribblesWon': sum(1 for r in messi if r[1] == 'D' and r[6] == 1),
        'passes': sum(1 for r in messi if r[1] == 'P'),
        'passesDone': sum(1 for r in messi if r[1] == 'P' and len(r) > 6 and r[6] >= 1),
        'touches': len(messi), 'has360': frames is not None,
    }

def main():
    comps = get('competitions.json')
    jobs = []
    for c in comps:
        if c['competition_id'] not in COMPS: continue
        for m in get(f"matches/{c['competition_id']}/{c['season_id']}.json"):
            if int(m['match_date'][:4]) < MIN_YEAR: continue
            if m['home_team']['home_team_name'] in TEAMS or m['away_team']['away_team_name'] in TEAMS:
                jobs.append((m, c))
    print(len(jobs), 'candidate matches', file=sys.stderr)
    idx, done = [], 0
    with ThreadPoolExecutor(12) as ex:
        for r in ex.map(lambda a: process(*a), jobs):
            done += 1
            if done % 50 == 0: print(done, file=sys.stderr)
            if r: idx.append(r)
    idx.sort(key=lambda r: r['date'])
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(idx, f, separators=(',', ':'), ensure_ascii=False)
    print(len(idx), 'Messi matches written', file=sys.stderr)

if __name__ == '__main__':
    main()
