export { toLua, luaString, luaNumber, luaIndexed, LuaIndexedTable, type LuaValue, type LuaTable } from './lua.js';
export * from './types.js';
export { writeMapInfoLua, collectMapInfoProblems, MAPHELPER_MAPINFO_LUA } from './write.js';
export {
  createMapInfo,
  DEFAULT_SUN_DIR,
  DEFAULT_TERRAIN_TYPES,
  TERRAIN_TYPE_GROUND,
  TERRAIN_TYPE_ROCK,
  TERRAIN_TYPE_SAND,
  TERRAIN_TYPE_WATER,
  TERRAIN_TYPE_ROAD,
} from './defaults.js';
