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

## Traffic and police

About 150 AI vehicles drive around you on the real road graph. Busy roads like Bluemound, Moorland and I-94 get the most traffic; side streets get a little.

- **Speed limits:** every driver aims for the posted limit of the road it's on. Limits come from OSM where tagged (all major roads), else from the nearest tagged stretch of the same street, else Wisconsin defaults (25 mph in residential areas). The HUD shows the limit where you are.
- **Drivers:** car-following uses the Intelligent Driver Model. A quarter of drivers are cautious (a bit under the limit, long gaps), most are normal (at the limit) and about 1 in 7 is aggressive (10–18% over, tailgating, rolling stops).
- **Intersections:** cars stop at red lights and turn right on red after a full stop. They stop at stop signs: all-way stops go first come, first served, and two-way stops wait for a gap. They yield to bigger roads and to the right on equal roads, and left turns yield to oncoming traffic. Ramps merge onto I-94 by finding a gap.
  - Each car reserves its path through a junction before entering, and paths that come within a car width of each other are never in it together. Divided-road intersections made of several nodes are treated as one intersection.
  - Nobody enters an intersection they can't get out of.
- **Lanes:** cars change lanes to pass slower traffic (MOBIL), keep right, and move over early for turns and lane drops. They take smooth curves through every junction and signal before turning or changing lanes.
- **Vehicles:** sedans, SUVs, pickups, minivans, box trucks, city buses and semis with trailers that track behind the cab. Each has its own size, mass and acceleration. Brake lights, turn signals and hazard lights work.
- **You:** cars predict your path and brake or swerve if you cut them off, and they yield to you at junctions. Hit one and momentum is exchanged by mass: it slides and spins, puts its hazards on, then pulls back onto the road. Crashed cars can knock into other cars.
- **Police:** a few patrol cars drive around. Go 15+ mph over the limit near one, crash into someone near one, or hit one, and they come after you with lights flashing. They route through the streets toward you, chase you down up close, and other drivers pull over to let them by. Stay more than about 320 m from every cruiser for 10 s to escape. Stop with one right next to you and you're busted.
- **Testing:** the traffic was tuned with a headless simulation that measures collisions between AI cars, stuck cars, red lights and stop signs run, and speeds against the limit.

## Classic look: what it's made of

The classic look uses only free, open data:

- **Terrain:** real elevation from USGS 3DEP lidar (public domain), baked to a 10 m grid (`npm run fetch-terrain`, then `build-map`). It ranges from 219.7 m above sea level on W Underwood Pkwy to 295.8 m on Colline Vue Blvd. Ground, roads, buildings, trees, street furniture and all cars follow it. It was checked against Google's photogrammetry mesh: within about 1–2 m across 76 m of relief.
- **Bridges:** bare-earth lidar has no bridges, so OSM bridge ways (chained when split) get a straight deck from abutment to abutment, with parapets. You can drive over them and under them.
- **Ground:** flat cartoon colors matching the rest of the classic look: lawns, tree shade, fields, bare soil, concrete, parking-lot asphalt and water. The layout comes from real aerial photos (USDA NAIP via USGS, public domain). Each ~1 m pixel is classified from the photo plus its infrared band and OSM water and parking areas, then cleaned into simple shapes. Tiles stream in 500 m squares around the car. A shader keeps the shape edges crisp up close.
- **Roads on hills:** roads are level across their width at the lidar height of their centerline. The ground mesh uses exactly the terrain grid points. The game cuts road beds into it just deep enough that it never shows through a road, and drops an earth bank where the ground falls away beside a road. `npm run audit-ground` checks every road in the city (3 million sample points). The car drives on the same surface you see, and gravity pulls it along slopes.
- **Roofs and trees:** roof colors come from the aerial photos. Trees are placed where the infrared band shows tree canopy, about 147k of them.
- **Buildings:** OpenStreetMap footprints with procedural facades: siding, brick and stucco with windows, garage and front doors facing the street, storefronts, office glass and warehouse docks. Roofs are gable or hip on houses, and flat with parapets and rooftop units on commercial buildings.
- **Street furniture:** traffic signals cycle and AI traffic obeys them. Also stop signs, painted crosswalks, sidewalks, streetlights, green street-name signs, and business-name signs from OSM shops, restaurants and offices.

The facade textures and roof shapes are generic patterns, not copies of real buildings. Nothing is derived from Google's 3D tiles, whose terms forbid it.

## Refresh the map data

```bash
npm run fetch-map -- --force   # downloads raw OSM data from Overpass into data-raw/
npm run fetch-aerial           # downloads NAIP aerial photo + infrared tiles to data-raw/ (inputs only, not shipped)
npm run fetch-terrain          # downloads USGS 3DEP lidar elevation to data-raw/terrain.tif
npm run build-map              # bakes public/data/ (map + terrain) and the stylized ground tiles in public/ground/
npm run audit-ground           # checks that the ground never pokes through a road anywhere
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
| `src/car.js` | The contact-shadow texture. |
| `src/vehicles.js` | AI vehicle types: models, sizes, masses and acceleration, plus the lamp shader for brake lights, turn signals and police lights. |
| `src/speedlimits.js` | Posted speed limit for every road. |
| `src/police.js` | When police chase you, escapes, busts, and the pursuit banner. |
| `src/terrain.js` | Loads the elevation grid. `T()` is the drawn ground and `Troad()` the original lidar surface that roads follow. `carveRoadBeds()` lowers the ground under roads just enough. |
| `src/aerial.js` | Streams the stylized ground tiles as meshes on the exact terrain grid, with the crisp-edge shader. |
| `scripts/stylize-ground.mjs` | Classifies the aerial photos into the ground palette (run by `build-map`; `--skip-ground` skips it). |
| `src/traffic.js` | AI traffic on the real road graph: IDM driving, junction reservations and right-of-way rules, MOBIL lane changes, junction curves, crashes, and police routing and chasing. |
| `src/hud.js` | Speedometer, street-name sign with route shields, the town you're in, a rotating minimap, and the full city map. |
| `src/spatial.js` | Grid indexes for road and building lookups. `RoadIndex.surfaceHeight()` gives the drivable height: road surface, bridge deck or ground. |

## Ideas for next steps

- **Missions.** Checkpoint races or delivery runs between real places, such as Brookfield Square or the Brookfield East/Central high schools.

Map data © OpenStreetMap contributors, licensed under the ODbL. The in-game attribution must stay visible.
