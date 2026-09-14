export { toLua, luaString, luaNumber, luaIndexed, LuaIndexedTable, type LuaValue, type LuaTable } from './lua.js';
export * from './types.js';
export { writeMapInfoLua, collectMapInfoProblems, MAPHELPER_MAPINFO_LUA } from './write.js';
export {
  createMapInfo,
  DEFAULT_SUN_DIR,
  DEFAULT_GROUND_AMBIENT,
  DEFAULT_GROUND_DIFFUSE,
  DEFAULT_GROUND_SPECULAR,
  DEFAULT_GROUND_SHADOW_DENSITY,
  DEFAULT_SPECULAR_EXPONENT,
  DEFAULT_FOG_COLOR,
  DEFAULT_FOG_START,
  DEFAULT_FOG_END,
  DEFAULT_TERRAIN_TYPES,
  TERRAIN_TYPE_GROUND,
  TERRAIN_TYPE_ROCK,
  TERRAIN_TYPE_SAND,
  TERRAIN_TYPE_WATER,
  TERRAIN_TYPE_ROAD,
} from './defaults.js';
export {
  groundShade,
  peakGroundShade,
  groundShadowContrast,
  flatGroundNdotL,
  SMF_INTENSITY_MULT,
  type ShadeConditions,
} from './lighting.js';
