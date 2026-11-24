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
| C | Cycle camera: chase, far, hood, top-down, showcase |
| V | Showcase camera that circles the car |
| I | Show the car's spec sheet |
| K | Switch between the Sport tune (default) and the stock car |
| M | City map. Click anywhere on it to teleport there |
| R | Put the car back on the nearest road |
| T | Turn traffic on or off |
| P | Switch between the photoreal 3D city and the classic look |
| H | Show or hide the controls panel |

A gamepad also works: left stick steers, RT is gas, LT is brake, A/B is handbrake, Y changes camera, X resets, Back opens the map.

## Classic look: what it's made of

The classic look uses only free, open data:

- **Terrain:** real elevation from USGS 3DEP lidar (public domain), baked to a 10 m grid (`npm run fetch-terrain`, then `build-map`). It ranges from 219.7 m above sea level on W Underwood Pkwy to 295.8 m on Colline Vue Blvd. Ground, roads, buildings, trees, street furniture and all cars follow it. It was checked against Google's photogrammetry mesh: within about 1–2 m across 76 m of relief.
- **Bridges:** bare-earth lidar has no bridges, so OSM bridge ways (chained when split) get a straight deck from abutment to abutment, with parapets. You can drive over them and under them.
- **Ground:** real aerial photos at 0.5 m per pixel (USDA NAIP via USGS, public domain), streamed in 500 m tiles around the car and draped over the terrain.
- **Roofs and trees:** roof colors come from the photos. Trees are placed where the infrared band shows tree canopy, about 147k of them.
- **Buildings:** OpenStreetMap footprints with procedural facades: siding, brick and stucco with windows, garage and front doors facing the street, storefronts, office glass and warehouse docks. Roofs are gable or hip on houses, and flat with parapets and rooftop units on commercial buildings.
- **Street furniture:** traffic signals cycle and AI traffic obeys them. Also stop signs, painted crosswalks, sidewalks, streetlights, green street-name signs, and business-name signs from OSM shops, restaurants and offices.

The facade textures and roof shapes are generic patterns, not copies of real buildings. Nothing is derived from Google's 3D tiles, whose terms forbid it.

## Refresh the map data

```bash
npm run fetch-map -- --force   # downloads raw OSM data from Overpass into data-raw/
npm run fetch-aerial           # downloads NAIP aerial tiles to public/aerial/ (+ infrared copies in data-raw/)
npm run fetch-terrain          # downloads USGS 3DEP lidar elevation to data-raw/terrain.tif
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
| `src/sc430.js` | The player car, a 2002 Lexus SC 430 built from the official spec sheet: 4.515 m long, 1,742 kg. The 3UZ-FE V8 torque curve makes 300 hp and 325 lb-ft. Torque goes through a torque converter and 5-speed automatic (3.266 final drive, 245/40R18) with a rear-wheel-drive traction limit. Drag uses Cd 0.30, and there's a 155 mph limiter. Stock car: 0–60 in 5.96 s, quarter mile in 14.6 s, 60–0 braking in 124 ft, 35.4 ft turning circle. The **Sport tune** (the default; **K** toggles) has 450 hp, no limiter, stickier tires, quicker shifts and a 27.9 ft turning circle: 0–60 in 4.37 s, quarter mile in 12.5 s at 120 mph, 196 mph top speed, 1.18 g cornering. |
| `src/car.js` | AI car shapes and the contact-shadow texture. |
| `src/traffic.js` | AI cars on the real road graph. They drive on the right, follow one-ways, slow for turns, keep their distance from the car ahead and avoid you. |
| `src/hud.js` | Speedometer, street-name sign with route shields, the town you're in, a rotating minimap, and the full city map. |
| `src/spatial.js` | Grid indexes for road and building lookups. `RoadIndex.surfaceHeight()` is the hook for adding bridges and elevation later. |

## Ideas for next steps

- **Bridges and overpasses.** The world is flat for now, so I-94's overpasses cross at grade. OSM `bridge`/`layer` tags are already kept in the data (`road.b`).
- **Missions.** Checkpoint races or delivery runs between real places, such as Brookfield Square or the Brookfield East/Central high schools.

Map data © OpenStreetMap contributors, licensed under the ODbL. The in-game attribution must stay visible.
