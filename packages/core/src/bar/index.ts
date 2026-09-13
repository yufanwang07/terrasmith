/**
 * The BAR gameplay layer: move classes, pathing and buildability analysis,
 * metal, and the pre-publish validator.
 *
 * This is the part that makes Terrasmith a Beyond All Reason tool rather than a
 * terrain generator. Everything here works in elmos and answers questions a map
 * author actually has — can a tank get there, does a factory fit, is the metal
 * even.
 */

export * from './movedefs.js';
export * from './pathing.js';
export * from './metal.js';
export * from './validate.js';
