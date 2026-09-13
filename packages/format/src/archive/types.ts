/** A file inside a map archive. */
export interface ArchiveEntry {
  /**
   * Path inside the archive, using forward slashes and no leading slash —
   * e.g. `maps/my_map.smf`, `mapinfo.lua`.
   */
  path: string;
  data: Uint8Array;
  /** Modification time. Defaults to the Unix epoch so builds stay reproducible. */
  mtime?: Date;
}

/** Progress callback shared by the archive writers. */
export type ArchiveProgress = (info: {
  /** Entries finished so far. */
  done: number;
  total: number;
  /** Path of the entry being processed. */
  path: string;
}) => void;
