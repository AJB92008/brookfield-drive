# Brookfield Drive

A free-roam driving game set in **Brookfield, Wisconsin**. Every road is rebuilt from real OpenStreetMap data, along with the buildings, parks, ponds and rail lines.

## Run it

```bash
npm install
npm run dev        # then open http://localhost:5173
```

The baked map (`public/data/brookfield.json`) is already in the project folder, so the game makes no network calls while it runs.

## Play anywhere

The game is hosted as a private claude.ai page: https://claude.ai/artifact/Hg7dYNXP3YSQG1uXwWwhsc

To update the hosted copy after changing the code, run `npm run build:artifact`. That packs the game into `artifact/index.html` plus `artifact/data/brookfield.json`. Then republish that folder (ask Claude to do it).

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Gas |
| S / ↓ | Brake, then reverse |
| A D / ← → | Steer |
| Space | Handbrake (drift) |
| C | Cycle camera: chase, far, hood, top-down |
| M | City map. Click anywhere on it to teleport there |
| R | Put the car back on the nearest road |
| T | Turn traffic on or off |
| H | Show or hide the controls panel |

A gamepad also works: left stick steers, RT is gas, LT is brake, A/B is handbrake, Y changes camera, X resets, Back opens the map.

## Refresh the map data

```bash
npm run fetch-map -- --force   # downloads raw OSM data from Overpass into data-raw/
npm run build-map              # bakes it into public/data/brookfield.json
```

- **Fetch step:** `scripts/fetch-osm.mjs` tries several Overpass mirrors with retries, because the public servers are often overloaded.
- **Area covered:** the bounding box of the City of Brookfield (OSM relation 251870) plus about 300 m of margin. It's set in `scripts/bbox.mjs`.
- **Change the place:** to drive somewhere else, change the box in `scripts/bbox.mjs` and the spawn logic in `scripts/build-map.mjs`.

## How it's built

| File | Role |
| --- | --- |
| `scripts/build-map.mjs` | Projects lat/lon to local meters (x = east, z = south). Works out road widths from lanes and road class, building heights from tags or footprint size, and ground areas. Stitches multipolygon rings and picks the spawn point (W Bluemound Rd at Moorland Rd). |
| `src/world.js` | Builds road ribbons with mitered joins and junction discs, painted lane lines (double yellow, dashed lanes, edge lines, gaps at intersections), extruded buildings with hip roofs on houses, parks and water, rail lines, and about 90k instanced trees. Static geometry is merged into 500 m tiles so off-screen tiles get culled. |
| `src/car.js` | Arcade car physics. Grip decays sideways, so the handbrake drifts. The car collides with buildings, trees and traffic. |
| `src/traffic.js` | AI cars on the real road graph. They drive on the right, follow one-ways, slow for turns, keep their distance from the car ahead and avoid you. |
| `src/hud.js` | Speedometer, street-name sign with route shields, the town you're in, a rotating minimap, and the full city map. |
| `src/spatial.js` | Grid indexes for road and building lookups. `RoadIndex.surfaceHeight()` is the hook for adding bridges and elevation later. |

## Ideas for next steps

- **Bridges and overpasses.** The world is flat for now, so I-94's overpasses cross at grade. OSM `bridge`/`layer` tags are already kept in the data (`road.b`).
- **Traffic lights and stop signs.** OSM `highway=traffic_signals` nodes would need to be fetched.
- **Missions.** Checkpoint races or delivery runs between real places, such as Brookfield Square or the Brookfield East/Central high schools.

Map data © OpenStreetMap contributors, licensed under the ODbL. The in-game attribution must stay visible.
