// Shared map frame: bbox + the equirectangular projection used for every baked coordinate.
//   x = east (m), z = south (m), origin = ORIGIN (fixed; NOT the bbox center, so the map is not centered on 0,0).
import { BBOX, ORIGIN } from './bbox.mjs';

export { BBOX };
export const LAT0 = ORIGIN.lat;
export const LON0 = ORIGIN.lon;
const phi = (LAT0 * Math.PI) / 180;
export const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
export const M_PER_DEG_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);

export const toX = (lon) => (lon - LON0) * M_PER_DEG_LON;
export const toZ = (lat) => -(lat - LAT0) * M_PER_DEG_LAT;
export const toLon = (x) => LON0 + x / M_PER_DEG_LON;
export const toLat = (z) => LAT0 - z / M_PER_DEG_LAT;

// Map extent in local meters (same as map.bounds in the baked JSON, before rounding). North is -z.
export const EXTENT = { minX: toX(BBOX.west), maxX: toX(BBOX.east), minZ: toZ(BBOX.north), maxZ: toZ(BBOX.south) };
