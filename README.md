# Brookfield Drive

A free-roam driving game set in **Brookfield and Waukesha, Wisconsin**, about 20 × 18 km that also takes in Elm Grove, Pewaukee and western New Berlin. Every road is rebuilt from real OpenStreetMap data, along with the buildings, parks, ponds and rail lines.

## Run it

```bash
npm install
npm run dev        # then open http://localhost:5173
```

The baked map (`public/data/brookfield.json`) is already in the project folder, so the game makes no network calls while it runs.

## Photoreal mode (Google 3D city)

With a Cesium ion token, the game streams **Google Photorealistic 3D Tiles** of the area through Cesium's free personal tier. Press **P** to switch between the real 3D city and the classic look built from OpenStreetMap.

- **What the OSM layer still does:** the OpenStreetMap data stays underneath as an invisible layer for physics, traffic, street names and the minimap.
- **How cars follow the ground:** they raycast the real 3D surface, so hills, ramps and overpasses all work.
- **Token setup:** the token lives in `.env.local` (`VITE_CESIUM_TOKEN=...`, ignored by git) for local dev, and in the `CESIUM_TOKEN` repo secret for GitHub Pages. Use a token limited to `assets:read`, asset 2275207, and the site's URL.
- **Attribution:** the Google logo and the live data credits must stay on screen (Map Tiles API policy).
- **Fallback:** without a token, or if the stream fails, the game falls back to the classic look.

## Play anywhere

- **GitHub Pages:** https://ajb92008.github.io/brookfield-drive/ includes photoreal mode. It's deployed by `.github/workflows/pages.yml` on every push to `main`.
- **Private claude.ai page (classic look only):** https://claude.ai/artifact/Hg7dYNXP3YSQG1uXwWwhsc

To update the hosted copy after changing the code, run `npm run build:artifact`. That packs the game into `artifact/index.html` plus the map data. claude.ai caps each file at 16 MB, so a bigger map ships as `artifact/data/brookfield.part0.json`, `part1`, … and a small loader in the page joins them. Then republish that folder (ask Claude to do it).

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
| N | Missions list (arrows + Enter, or click). During a run: Backspace restarts, G toggles the ghost car |
| M | City map. Click anywhere on it to teleport there (cancels a mission) |
| R | Put the car back on the nearest road, upright (it stays damaged) |
| F | Call a tow to the nearest repair shop |
| T | Turn traffic on or off |
| P | Switch between the photoreal 3D city and the classic look |
| H | Show or hide the controls panel |

A gamepad also works: left stick steers, RT is gas, LT is brake, A/B is handbrake, Y changes camera, X resets, LB calls a tow, Back opens the map, Start opens missions (d-pad picks, A starts or retries, B closes).

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
- **AI damage:** every hit crushes the end or side that took it, scaled by the car's change in speed. A crushed front steams, then smokes. Hit hard enough, a car is wrecked: it stays where it stopped with its hazards on, and a caved-in front sometimes catches fire. Traffic changes lanes to get around it. A wreck is towed once you've moved on. A wrecked police car drops out of the chase.
- **Police:** a few patrol cars drive around. Go 15+ mph over the limit near one, crash into someone near one, or hit one, and they come after you with lights flashing. They route through the streets toward you, chase you down up close, and other drivers pull over to let them by. Stay more than about 320 m from every cruiser for 10 s to escape. Stop with one right next to you and you're busted.
- **Testing:** the traffic was tuned with a headless simulation that measures collisions between AI cars, stuck cars, red lights and stop signs run, and speeds against the limit.

## Crashes

Your car is a rigid body: 1,742 kg, with its real length and width. Hits are resolved at the actual contact point.

- **How it reacts:**
  - A head-on hit stops you hard. Crumple zones absorb most of it, so a 45 mph wall hit bounces back at only about 5 mph.
  - An off-center or angled hit spins you.
  - A glancing hit deflects you, and you scrape along the wall.
  - Hit another car and momentum is shared by mass, so a semi barely moves and you go flying.
- **Skids:** after a hit the tires skid on friction instead of snapping straight, so you slide and rotate realistically. The body pitches and rolls with the impact.
- **Rollovers:** sliding sideways off the pavement at about 20+ mph trips the car, and so does a hard enough shove from the side. Whether it tips is worked out from its center of gravity and body shape, and it can come to rest on its side or roof. Press R to put it back on its wheels.
- **What you can hit:**
  - Buildings, trees and other cars.
  - Traffic-signal poles, which are rigid.
  - Streetlights, stop signs and street-name signs, which break away at the base and fall over the way you were going. That's how the real ones are designed.
- **Effects:** hot sparks at metal contacts and while scraping, plus flying debris: body bits, glass from broken lights, mirrors, leaves.
- **Damage** (`src/damage.js`): ten zones (four corners, front, rear, both sides, roof, underside), scaled by the energy of the hit. Another car shares the energy by mass. Poles and trees bite deep into one spot, and walls spread it out. The panel next to the speedometer shows each zone, every system's health, warning lights and what just broke.
  - **Mechanical:**
    - **Engine and cooling:** a front hit cracks the radiator. Coolant leaks out, the temperature climbs, power fades, the engine misfires, and finally it seizes.
    - **Oil:** a big hit or a hard landing cracks the oil pan, and an engine run without oil dies.
    - **Gearbox:** rear hits cost the top gears, can jam it in one gear, or break the driveline.
    - **Brakes:** a damaged brake line makes the brakes weak and pull to one side.
    - **Steering and suspension:** knocked-out alignment pulls the car, the wheel sits off-center, steering lock drops, a bent corner sags and a bent wheel shimmies.
    - **Tires:** they puncture, go flat, blow out and shred down to the rim, which throws sparks. A big enough hit tears a wheel off.
  - **On the car:**
    - **Dents:** the body dents and crumples where you hit, and lights and mirrors break off.
    - **Scrapes:** paint is scuffed and then worn to bare metal wherever you scrape.
    - **Bumpers:** a bumper comes loose and hangs from one corner, dragging and sparking on the road, then drops off and stays on the road. You can drive into fallen parts and knock them along.
    - **Hood:** it crumples and its latch breaks. Above about 60 mph the wind can fling it up against the windshield.
    - **Trunk and doors:** they spring open and swing. Doors swing with the turns.
    - **Glass:** the windshield cracks in spider webs, also shown over the screen in the hood camera, and side windows shatter.
    - **Steam, smoke, fire:** a hot radiator steams and a sick engine smokes. A big front crash or a cooked engine leaking oil can catch fire, which finishes the car.
    - **Puddles:** oil and coolant drip as you drive and pool where you stop.
  - **Repairs:** R only puts the car back on the road. To fix it, drive into the green ring at one of the 31 real auto repair and tire shops (wrench icons on the map) and stop. A car that can't drive gets towed to the nearest one with F. Missions always start with a repaired car.

## Classic look: what it's made of

The classic look uses only free, open data:

- **Terrain:** real elevation from USGS 3DEP lidar (public domain), baked to a 10 m grid (`npm run fetch-terrain`, then `build-map`). It ranges from 186.8 m to 341.4 m above sea level across the map. Ground, roads, buildings, trees, street furniture and all cars follow it. It was checked against Google's photogrammetry mesh: within about 1–2 m across 76 m of relief.
- **Bridges:** bare-earth lidar has no bridges, so OSM bridge ways (chained when split) get a straight deck from abutment to abutment, with parapets. You can drive over them and under them.
- **Ground:** flat cartoon colors matching the rest of the classic look: lawns, tree shade, fields, bare soil, concrete, parking-lot asphalt and water. The layout comes from real aerial photos (USDA NAIP via USGS, public domain). Each ~1 m pixel is classified from the photo plus its infrared band and OSM water and parking areas, then cleaned into simple shapes. Tiles stream in 500 m squares around the car. A shader keeps the shape edges crisp up close.
- **Roads on hills:** roads are level across their width at the lidar height of their centerline. The ground mesh uses exactly the terrain grid points. The game cuts road beds into it just deep enough that it never shows through a road, and drops an earth bank where the ground falls away beside a road. `npm run audit-ground` checks every road in the city (3 million sample points). The car drives on the same surface you see, and gravity pulls it along slopes.
- **Roofs and trees:** roof colors come from the aerial photos. Trees are placed where the infrared band shows tree canopy, about 463k of them.
- **Buildings:** OpenStreetMap footprints with procedural facades: siding, brick and stucco with windows, garage and front doors facing the street, storefronts, office glass and warehouse docks. Roofs are gable or hip on houses, and flat with parapets and rooftop units on commercial buildings.
- **Street furniture:** traffic signals cycle and AI traffic obeys them. Also stop signs, painted crosswalks, sidewalks, streetlights, green street-name signs, and business-name signs from OSM shops, restaurants and offices.

The facade textures and roof shapes are generic patterns, not copies of real buildings. Nothing is derived from Google's 3D tiles, whose terms forbid it.

## Refresh the map data

```bash
npm run fetch-map -- --force   # downloads raw OSM data from Overpass into data-raw/
npm run fetch-aerial           # downloads NAIP aerial photo + infrared tiles to data-raw/ (inputs only, not shipped)
npm run fetch-terrain          # downloads USGS 3DEP lidar elevation to data-raw/terrain-*.tif (4 tiles)
npm run build-map              # bakes public/data/ (map + terrain) and the stylized ground tiles in public/ground/
npm run audit-ground           # checks that the ground never pokes through a road anywhere
```

- **Fetch step:** `scripts/fetch-osm.mjs` tries several Overpass mirrors with retries, because the public servers are often overloaded.
  - **Tiling:** it fetches the area as a 2 × 2 grid of tiles, each cached in `data-raw/osm-tiles/`, and merges them by OSM id.
  - **Terrain and aerials:** terrain comes in 4 overlapping tiles. Aerial tiles are fixed 500 m cells, so growing the area only downloads the new ones.
- **Area covered:** one rectangle around the City of Brookfield (OSM relation 251870) and the City of Waukesha (relation 251879), each plus about 300 m of margin. It's set in `scripts/bbox.mjs`.
- **Origin:** game coordinates are meters from a fixed origin, the center of the original Brookfield-only box, also in `scripts/bbox.mjs`. Growing the box doesn't move the spawn, the missions or saved ghosts.
- **Change the place:** to drive somewhere else, change the box (and the origin) in `scripts/bbox.mjs` and the spawn logic in `scripts/build-map.mjs`.

## How it's built

| File | Role |
| --- | --- |
| `scripts/build-map.mjs` | Projects lat/lon to local meters (x = east, z = south). Works out road widths from lanes and road class, building heights from tags or footprint size, and ground areas. Stitches multipolygon rings and picks the spawn point (W Bluemound Rd at Moorland Rd). |
| `src/world.js` | Builds road ribbons with mitered joins and junction discs, painted lane lines (double yellow, dashed lanes, edge lines, gaps at intersections), extruded buildings with hip roofs on houses, parks and water, rail lines, and about 463k instanced trees. Static geometry is merged into 500 m tiles, and those (plus the street furniture) are grouped into 1 km cells. Cells past the view distance are hidden, the world's matrices are computed once instead of every frame, and a cell's CPU-side vertex arrays are dropped once they're on the GPU. That keeps the 20 × 18 km map at the same frame rate as Brookfield alone. |
| `src/sc430.js` | The player car, a 2002 Lexus SC 430 built from the official spec sheet: 4.515 m long, 1,742 kg. The 3UZ-FE V8 torque curve makes 300 hp and 325 lb-ft. Torque goes through a torque converter and 5-speed automatic (3.266 final drive, 245/40R18) with a rear-wheel-drive traction limit. Drag uses Cd 0.30, and there's a 155 mph limiter. Stock car: 0–60 in 5.96 s, quarter mile in 14.6 s, 60–0 braking in 124 ft, 35.4 ft turning circle. The **Sport tune** (the default; **K** toggles) has 450 hp, no limiter, stickier tires, quicker shifts and a 27.9 ft turning circle: 0–60 in 4.37 s, quarter mile in 12.5 s at 120 mph, 196 mph top speed, 1.18 g cornering. |
| `src/car.js` | The contact-shadow texture. |
| `src/vehicles.js` | AI vehicle types: models, sizes, masses and acceleration, plus the lamp shader for brake lights, turn signals and police lights, and the per-car crush shader for crash damage. |
| `src/speedlimits.js` | Posted speed limit for every road. |
| `src/missions.js` | Mission mode: the 12 missions, routing on the road graph (Dijkstra by travel time at the speed limits), the finish beacon and on-screen marker, splits, the ghost car, medals, results and saved bests. |
| `src/police.js` | When police chase you, escapes, busts, and the pursuit banner. |
| `src/crash.js` | Crash effects (sparks, debris, smoke, steam, flames), breakaway poles, and smoke and fire from damaged AI cars. |
| `src/damage.js` | The player car's damage model: zones, mechanical failures and their effects on driving, dents, scrapes, loose and fallen panels, glass, fire, puddles, and the damage panel. |
| `src/shops.js` | Repair shops: rings at every real repair and tire shop, repairs, the tow, and their map icons. |
| `src/terrain.js` | Loads the elevation grid. `T()` is the drawn ground and `Troad()` the original lidar surface that roads follow. `carveRoadBeds()` lowers the ground under roads just enough. |
| `src/aerial.js` | Streams the stylized ground tiles as meshes on the exact terrain grid, with the crisp-edge shader. |
| `scripts/stylize-ground.mjs` | Classifies the aerial photos into the ground palette (run by `build-map`; `--skip-ground` skips it). |
| `src/traffic.js` | AI traffic on the real road graph: IDM driving, junction reservations and right-of-way rules, MOBIL lane changes, junction curves, crashes, crash damage and wrecks, and police routing and chasing. |
| `src/hud.js` | Speedometer, street-name sign with route shields, the town you're in, a rotating minimap, and the full city map, both with the mission route. |
| `src/spatial.js` | Grid indexes for road and building lookups. `RoadIndex.surfaceHeight()` gives the drivable height: road surface, bridge deck or ground. |

## Missions

Press **N** for the mission list: 12 timed runs between Brookfield landmarks, in three tiers. Pick one with the arrow keys and Enter, or click it.

| Tier | Mission | From → to |
| --- | --- | --- |
| Easy | Village Errand | Tonawanda Elementary School → Elm Grove Village Hall |
| Easy | Ice Time | Burleigh Elementary School → The Ponds of Brookfield Ice Arena |
| Easy | After-School Shopping | Pilgrim Park Middle School → Brookfield Square |
| Easy | Code Blue | Brookfield Fire Station No. 1 → Ascension Elmbrook Hospital |
| Medium | Last Bell | Brookfield East High School → 15185 Kings Ridge Ct. |
| Medium | Morning Commute | 15185 Kings Ridge Ct. → Brookfield City Hall |
| Medium | Movie Night | Brookfield Public Library → Silverspot Cinema |
| Medium | Rivalry Game | Brookfield Central High School → Brookfield East High School |
| Hard | Mall Dash | 15185 Kings Ridge Ct. → Brookfield Square |
| Hard | The Long Way Home | Brookfield Sports Complex → 15185 Kings Ridge Ct. |
| Hard | Bullseye to Bullseye | Target (west, Bluemound) → Target (east, Bluemound) |
| Hard | Cross-Town | Brookfield Academy → Elm Grove Village Hall |

15185 Kings Ridge Ct. isn't in OpenStreetMap, so that finish is the curb on the cul-de-sac bulb next to its mapped neighbors (15165 and 15160). Brookfield Square's finish is the mall's west entrance.

How a run works:

- **Same start every time.** You're taken to the mission's start, at or beside the place it's named for, and the car is repaired and traffic resets. A card shows the mission, the medal times and your best during the 3-second countdown.
- **Fixed medal times** for gold, silver and bronze on every mission, so every run is comparable and your best is a real record. They were set by driving each mission with a scripted test driver (traffic off): gold is its time plus 20%, silver plus 60%, bronze about double.
- **No other rules.** Speed, run lights, cut through lots. The police leave you alone for the run.
- **Navigation:**
  - The route shows on the minimap and the city map. It's the fastest legal route at the speed limits, it respects one-way streets and divided roads, and it updates as you drive, so it follows you if you leave it.
  - A tall light beam, colored by tier, stands over the finish. You can see it from across town.
  - A label on screen shows the distance; when the finish is off screen, an arrow at the edge points to it.
- **Splits:** when you're 3/4, 1/2 and 1/4 of the way from the finish (by road), the split time pops up against your best run's split.
- **Ghost:** your best run plays back as a see-through car you can race. **G** turns it on or off.
- **Results:** medal, time and the change from your best, every split against your best, top and average speed, distance driven and damage taken. **Enter** retries, **N** opens the list, **Esc** drives on.
- **Restart** a run any time with **Backspace**. Abandon one from the list; teleporting from the city map cancels it.
- Bests and ghosts are saved in your browser.

## Ideas for next steps

- **Other mission types.** Checkpoint races, deliveries, or police escapes.

Map data © OpenStreetMap contributors, licensed under the ODbL. The in-game attribution must stay visible.
