// Shared map frame: bbox + the equirectangular projection used for every baked coordinate.
//   x = east (m), z = south (m), origin = bbox center.
import { BBOX } from './bbox.mjs';

export { BBOX };
export const LAT0 = (BBOX.south + BBOX.north) / 2;
export const LON0 = (BBOX.west + BBOX.east) / 2;
const phi = (LAT0 * Math.PI) / 180;
export const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
export const M_PER_DEG_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);

export const toX = (lon) => (lon - LON0) * M_PER_DEG_LON;
export const toZ = (lat) => -(lat - LAT0) * M_PER_DEG_LAT;
export const toLon = (x) => LON0 + x / M_PER_DEG_LON;
export const toLat = (z) => LAT0 - z / M_PER_DEG_LAT;

// Map extent in local meters (same as map.bounds in the baked JSON, before rounding).
export const HALF_W = (M_PER_DEG_LON * (BBOX.east - BBOX.west)) / 2;
export const HALF_H = (M_PER_DEG_LAT * (BBOX.north - BBOX.south)) / 2;
