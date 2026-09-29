import type { LevelArtName } from '../../levels';
import attention from './attention';
import distance from './distance';
import game from './game';
import judge from './judge';
import meanings from './meanings';
import type { SceneMaker } from './kit';

export type { Raster, Scene, Stage } from './kit';

export const SCENES: Record<LevelArtName, SceneMaker> = { game, distance, meanings, attention, judge };

// A frame worth holding when nothing moves (reduced motion, a still thumbnail): the time at
// which each scene is most itself.
export const STILL_T: Record<LevelArtName, number> = {
  game: 5.9,
  distance: 7,
  meanings: 2.4,
  attention: 3.1,
  judge: 11.2,
};
