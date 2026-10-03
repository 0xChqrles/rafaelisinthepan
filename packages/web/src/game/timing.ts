// THE BEATS OF A GUESS, shared by the two boards that play one: the day's round
// (screens/Game) and the lesson's (tutorial/LessonBoard). A leaf module, so the lesson
// keeps the round's time without importing the round.

// How long an uncyphered ghost stands in the prompt, as a typed word, ONCE THE LAST
// LETTER HAS SETTLED, before the prompt clears and the guess's choreography begins.
export const REVEAL_HOLD_MS = 500;

// When a guess impacts several holes, effect starts are staggered this many ms apart.
// Floating distance/MISS feedback uses the same start stagger, then fades as one batch.
// (The tutorial's board is ONE hole, so it staggers nothing — it takes the intro constant
// below instead, which is what makes its single hit read like a real one.)
export const STAGGER_MS = 200;
// How long the LAST impacted hole's feedback stands before the guess is released into the
// board (every earlier one stands longer, by the stagger): long enough to read each hole's
// number over its own hole (user-asked 2026-09-23, "make sure we have the time to see them
// well"; it was 320).
export const FLOATING_HIT_INTRO_MS = 800;

// Deadline for the keyboard's solved-exit beat handing the tray back (see Game's effect):
// a generous multiple of the real duration, so it only ever fires if the DOM signal
// itself was lost.
export const KB_EXIT_FALLBACK_MS = 1_200;

// How long a GIVE-UP's revealed sentence stands once its unfound words have settled into
// their secrets, before the keyboard drops and the sentence dissolves: the answer is read in
// place. A solve needs no such hold — its last word was the player's own, and a streak's
// celebration follows it. Never under reduced motion.
export const GIVE_UP_HOLD_MS = 1_000;
