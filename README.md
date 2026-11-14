# Reading Messi

Lionel Messi's matches, replayed from StatsBomb open event data: every pass, carry, dribble
and shot he made, drawn where it happened on a top-down pitch, with a freeze-frame of every
player's position at each shot. Format inspired by readthegame.co.

## Run it

    python3 -m http.server 8765     # from this folder
    open http://localhost:8765

## Rebuild the data

    python3 scripts/build_data.py

Downloads every Barcelona / PSG / Inter Miami / Argentina match in StatsBomb Open Data
(about 2 GB, cached in `.cache/`, safe to delete afterwards) and writes:

- `data/index.json`: one summary row per Messi match
- `data/matches/<id>.json`: Messi's events, all shots with freeze-frames, and the ball path

## Pages

- `index.html`: goal map, headline counts, seasons by club
- `archive.html`: every match, filterable
- `match.html?id=<id>#t=<seconds>`: the replay
- `about.html`: lessons that link into real matches, plus how everything is counted

Data © StatsBomb, used under their open data user agreement (attribution required, non-commercial).
