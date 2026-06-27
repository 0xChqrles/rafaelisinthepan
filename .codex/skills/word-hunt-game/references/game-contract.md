# Game Contract

## Data Shape

The app loads `/game_data.json`, served by Vite from `public/game_data.json`.

```json
{
  "en": {
    "phrases": [
      {
        "id": 0,
        "words": ["the", "old", "fisherman"],
        "holes": [
          { "pos": 2, "secret": "fisherman", "start": "sailor", "start_rank": 87 }
        ]
      }
    ],
    "ranks": {
      "fisherman": { "fisherman": 0, "sailor": 87 }
    }
  }
}
```

Required invariants:

- `ranks[secret][word]` is an integer distance rank.
- `0` means the secret itself; lower rank is always closer.
- `ranks[secret][secret]` must be `0`.
- A word exists if it is a key in any rank map.
- Rank maps for hole secrets should share the same vocabulary keys so gameplay can compare a valid guess against every active hole.
- Each hole starts as `{ word: start, rank: start_rank }`.
- `start_rank` must equal `ranks[secret][start]`.
- A hole's `pos` points at the secret word in `phrase.words`.

## Guess Loop

Normalize the guess with lowercase ASCII letters only:

```js
input.toLowerCase().replace(/[^a-z]/g, '')
```

On Enter:

1. If the normalized word is absent from every rank map, show the invalid state and reset input.
2. If present, compute `r_h = ranks[h.secret][word]` for each hole.
3. Pick the hole with the smallest `r_h`.
4. If that rank is lower than the picked hole's current rank, replace that hole's displayed word and current rank.
5. Otherwise keep phrase state unchanged and show a floating hit with that rank on the picked hole.

## Scoring

For each hole:

```js
s(rank) = 1 - Math.log(rank + 1) / Math.log(N + 1)
p_hole = (s(currentRank) - s(startRank)) / (1 - s(startRank))
```

`N` is `Object.keys(ranks[secret]).length`.

Progress is `100 * average(p_hole)`. It starts at `0` and reaches `100` only when every hole has rank `0`.

## Screens

- Language select: black background, six CSS/SVG pixel-art flags, no emoji flags. Clicking English starts the game timer.
- Game: top progress bar, top 2:00 countdown, large centered phrase, minimal underscore input.
- Timer expiry: freeze input and show final percent.

## Style

- Use the local Undertale font from `public/undertale.ttf`; do not import Google Fonts.
- Keep a flat modern UI with pixel-art typography and assets. Avoid scanline overlays, heavy glow effects, and terminal-style neon accents.
- Keep `FloatingHit` and `ShakeWord` as separate components with `TODO(anim)` comments for later animation polish.
