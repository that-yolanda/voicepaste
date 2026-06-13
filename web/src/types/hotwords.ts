/** Hotword data types. */

export interface HotwordGroup {
  name: string;
  active: boolean;
  words: string[];
}

export interface HotwordData {
  active_group: string | null;
  groups: HotwordGroup[];
}
