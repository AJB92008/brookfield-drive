# Brookfield Drive

A free-roam driving game set in **Brookfield, Wisconsin**. Every road is rebuilt from real OpenStreetMap data, along with the buildings, parks, ponds and rail lines.

## Run it

```bash
npm install
npm run dev        # then open http://localhost:5173
```

The baked map (`public/data/brookfield.json`) is already in the project folder, so the game makes no network calls while it runs.

## Photoreal mode (Google 3D city)

With a Cesium ion token, the game streams **Google Photorealistic 3D Tiles** of Brookfield through Cesium's free personal tier. Press **P** to switch between the real 3D city and the classic look built from OpenStreetMap.

- **What the OSM layer still does:** the OpenStreetMap data stays underneath as an invisible layer for physics, traffic, street names and the minimap.
- **How cars follow the ground:** they raycast the real 3D surface, so hills, ramps and overpasses all work.
- **Token setup:** the token lives in `.env.local` (`VITE_CESIUM_TOKEN=...`, ignored by git) for local dev, and in the `CESIUM_TOKEN` repo secret for GitHub Pages. Use a token limited to `assets:read`, asset 2275207, and the site's URL.
- **Attribution:** the Google logo and the live data credits must stay on screen (Map Tiles API policy).
- **Fallback:** without a token, or if the stream fails, the game falls back to the classic look.

## Play anywhere

- **GitHub Pages:** https://ajb92008.github.io/brookfield-drive/ includes photoreal mode. It's deployed by `.github/workflows/pages.yml` on every push to `main`.
- **Private claude.ai page (classic look only):** https://claude.ai/artifact/Hg7dYNXP3YSQG1uXwWwhsc

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
| P | Switch between the photoreal 3D city and the classic look |
| H | Show or hide the controls panel |

A gamepad also works: left stick steers, RT is gas, LT is brake, A/B is handbrake, Y changes camera, X resets, Back opens the map.

## Classic look: what it's made of

The classic look uses only free, open data:

- **Ground:** real aerial photos at 0.5 m per pixel (USDA NAIP via USGS, public domain), streamed in 500 m tiles around the car.
- **Roofs and trees:** roof colors come from the photos. Trees are placed where the infrared band shows tree canopy, about 147k of them.
- **Buildings:** OpenStreetMap footprints with procedural facades: siding, brick and stucco with windows, garage and front doors facing the street, storefronts, office glass and warehouse docks. Roofs are gable or hip on houses, and flat with parapets and rooftop units on commercial buildings.
- **Street furniture:** traffic signals cycle and AI traffic obeys them. Also stop signs, painted crosswalks, sidewalks, streetlights, green street-name signs, and business-name signs from OSM shops, restaurants and offices.

The facade textures and roof shapes are generic patterns, not copies of real buildings. Nothing is derived from Google's 3D tiles, whose terms forbid it.

## Refresh the map data

```bash
npm run fetch-map -- --force   # downloads raw OSM data from Overpass into data-raw/
npm run fetch-aerial           # downloads NAIP aerial tiles to public/aerial/ (+ infrared copies in data-raw/)
npm run build-map              # bakes everything into public/data/brookfield.json
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
- **Missions.** Checkpoint races or delivery runs between real places, such as Brookfield Square or the Brookfield East/Central high schools.

Map data © OpenStreetMap contributors, licensed under the ODbL. The in-game attribution must stay visible.
