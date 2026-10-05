// The SCREEN's own runtime types: a hole as the board holds it while a round is played,
// and one floating hit over it. Nothing outside the web reads either — the puzzle and API
// schema types are @whippin/shared's.

export interface RuntimeHole {
  pos: number;
  secret: string; // secret slug -> key into RankMap
  word: string; // currently displayed (accented) word
  rank: number;
  startRank: number;
  // A GIVE-UP's reveal: the hole shows its secret at rank 0 without having been found — the
  // held chip stays, the exponent goes, and it never wears the found cobalt.
  revealed?: boolean;
}

export interface HitState {
  holeIndex: number;
  value: number;
  id: number;
  startDelayMs: number;
  fadeDelayMs: number;
  miss?: boolean; // true => the guess was too far for this hole; render "MISS", not a number
  // #301: the blow this guess lands on the hole — the CUT of a guess that charges the
  // hole's meter, the ULTRA star of the exact hit. Absent on a miss, a repeat, or a rank
  // the charge table pays nothing for.
  strike?: 'slash' | 'ultra';
  // #301: what this guess added to the hole's meter — the loot that flies into it. Absent
  // (or 0) when the meter did not rise (a hint taken halves it): nothing to throw.
  charge?: number;
}
