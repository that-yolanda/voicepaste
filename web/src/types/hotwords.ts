/** Hotword data types. */

export interface HotwordGroup {
  id: string;
  name: string;
  words: string[];
}

export interface HotwordData {
  /** id of the currently active group (single-select). */
  active_group: string;
  groups: HotwordGroup[];
}
