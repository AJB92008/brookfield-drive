// Map bounding box: the City of Brookfield, WI (OSM relation 251870) and the City of Waukesha (relation 251879),
// each plus ~300 m margin, as one rectangle. A bbox (instead of the city polygons) keeps the Town of Brookfield,
// Elm Grove, Pewaukee and western New Berlin drivable between them and stops roads dead-ending at city lines.
//   Brookfield only (until Nov 2026): { south: 43.0130, west: -88.1900, north: 43.1095, east: -88.0620 }
export const BBOX = { south: 42.9480, west: -88.3090, north: 43.1095, east: -88.0620 };

// World origin: the center of the original Brookfield-only bbox. Every baked coordinate (and every hardcoded
// one: mission starts/finishes, ghost runs, repair shops) is meters from here, so it stays fixed when BBOX grows.
export const ORIGIN = { lat: 43.06125, lon: -88.126 };
