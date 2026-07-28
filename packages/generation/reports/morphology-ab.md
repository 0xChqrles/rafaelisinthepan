# Morphology source A/B — Morphalou 3.1 vs Lefff 3.4 (#131)

- Lefff: Lefff 3.4 — Lionel Clément, Benoît Sagot (Inria / ALMAnaCH) — `lefff-3.4.0.mlex.tar.gz`
- Morphalou: Morphalou 3.1 — ATILF / CNRS, via ORTOLANG (LGPL-LR) — `Morphalou3.1_formatCSV_toutEnUn.zip`
- Typability: `web/public/vocab/fr.json` (127,783 slugs), the sole typability authority.
- Morphalou rows skipped as unmappable/malformed: 0.

Both sources are parsed into the SAME internal feature vocabulary (#119's cells for verbs, number for nouns, gender x number for adjectives), through the same token rule and lemma normalization.

## Coverage per POS

| POS | source | lemmas | surfaces | (lemma, feature) cells | typable surfaces | realizable cells (>=1 typable form) |
|---|---|---:|---:|---:|---:|---:|
| verb | Lefff | 7,819 | 301,191 | 396,653 | 58,135 | 92,030 |
| verb | Morphalou | 13,717 | 510,210 | 665,628 | 63,417 | 103,040 |
| noun | Lefff | 41,674 | 85,846 | 82,980 | 50,542 | 49,803 |
| noun | Morphalou | 100,325 | 183,028 | 187,194 | 64,948 | 68,280 |
| adj | Lefff | 17,596 | 56,700 | 70,301 | 32,465 | 42,844 |
| adj | Morphalou | 36,419 | 98,441 | 129,842 | 41,141 | 53,509 |

## Cell diff (same feature vocabulary, same lemma key)

| POS | shared | Morphalou only | Lefff only | Morphalou only (realizable) | Lefff only (realizable) |
|---|---:|---:|---:|---:|---:|
| verb | 387,839 | 277,789 | 8,814 | 10,991 | 139 |
| noun | 78,769 | 108,425 | 4,211 | 18,776 | 183 |
| adj | 41,621 | 88,221 | 28,680 | 24,944 | 14,198 |

The adj row is dominated by a KEYING convention, not by content: Lefff keys a participial adjective by its verb lemma («plongé» under «plonger») where Morphalou keys the participle graphy itself. The surface diff below is keying-independent.

## Surface diff — does the source know (form, feature) at all?

Typable surfaces only (slug in the existence set).

| POS | shared | Morphalou only | Lefff only |
|---|---:|---:|---:|
| verb | 91,798 | 10,996 | 185 |
| noun | 51,950 | 15,900 | 335 |
| adj | 36,950 | 16,446 | 2,657 |

## Basic verbs (top 300 Lexique lemma frequency): paradigm holes

Cells one source states and the other lacks, on the verbs every player meets. A defective paradigm (falloir, pleuvoir) is absent from BOTH sides, so it never lists here.

### Missing in Lefff, present in Morphalou: 0 cells on 0 of the top 300 verbs

(none)

### Missing in Morphalou, present in Lefff: 2 cells on 2 of the top 300 verbs

| verb (freq rank) | missing cells | example forms |
|---|---|---|
| pouvoir (6) | 1: sub:pre:2s | sub:pre:2s: puisses |
| asseoir (63) | 1: par:pas:m:p | par:pas:m:p: assis |

### Form-level holes on shared cells (top 300 verbs, typable forms)

A cell can exist in both sources while one lacks a spelling of it. Variants share the slug of a form the other source has for the cell (the 1990 rectifications fold onto the traditional slug: plait/plaît, espèrerai/espérerai); missing forms do not.

| side | spelling variants | forms with no counterpart |
|---|---:|---:|
| only in Morphalou | 55 | 21 |
| only in Lefff | 6 | 14 |

The variant imbalance is the 1990 rectifications: Morphalou carries them, Lefff does not. The no-counterpart lists are NOT symmetric in meaning — read them against the raw sources (see the spot checks): a Morphalou-only form can be pollution from a mixed-in second conjugation (sortir/repartir carry the rare legal «-issant» paradigm INSIDE the same entry) or a mis-tagged cell (fuisse as sub:pre), while the Lefff-only list is dominated by first-person-singular rows Morphalou dropped where the form is homographic with the 2s (sors, peux, fuyais…).

Forms only Morphalou states:

- `foutre / imp:pre:2s`: fous
- `fuir / sub:pre:1s`: fuisse
- `fuir / sub:pre:3s`: fuisse
- `pouvoir / sub:pre:3s`: puisses
- `repartir / imp:pre:1p`: repartissons
- `repartir / imp:pre:2p`: repartissez
- `repartir / imp:pre:2s`: repartis
- `repartir / ind:imp:3p`: repartissaient
- `repartir / ind:imp:3s`: repartissait
- `repartir / ind:pre:1p`: repartissons
- `repartir / ind:pre:1s`: repartis
- `repartir / ind:pre:2p`: repartissez
- `repartir / ind:pre:2s`: repartis
- `repartir / ind:pre:3p`: repartissent
- `repartir / ind:pre:3s`: repartit
- `repartir / par:pre`: repartissant
- `repartir / sub:pre:3p`: repartissent
- `sortir / imp:pre:2s`: sortis
- `sortir / ind:pre:1s`: sortis
- `sortir / ind:pre:2s`: sortis
- `sortir / ind:pre:3s`: sortit

Forms only Lefff states:

- `asseoir / ind:pre:1s`: assois
- `asseoir / sub:pre:1s`: assoie
- `essayer / cnd:pre:1s`: essayerais
- `foutre / cnd:pre:1s`: foutrais
- `fuir / ind:imp:1s`: fuyais
- `fuir / sub:pre:1s`: fuie
- `payer / cnd:pre:1s`: payerais
- `pouvoir / ind:pre:1s`: peux
- `repartir / ind:imp:1s`: repartais
- `repartir / ind:pre:1s`: repars
- `repartir / sub:pre:1s`: reparte
- `sortir / ind:imp:1s`: sortais
- `sortir / ind:pre:1s`: sors
- `sortir / sub:pre:1s`: sorte

## Spot checks

Each verified against the raw sources during this audit.

- `foutre / imp:pre:2s` — Lefff: fouts; Morphalou: fous, fouts — Lefff's compiled-class failure mode, confirmed: its inflection class generates the NON-WORD «fouts» (Y2s) and the real «fous» is nowhere in its paradigm
- `conquérir / par:pas:m:p` — Lefff: conquis; Morphalou: ABSENT — the Morphalou gap #119 recorded
- `asseoir / par:pas:m:p` — Lefff: assis; Morphalou: ABSENT — «assis» has no masculine-plural participle row in Morphalou
- `pouvoir / sub:pre:2s` — Lefff: puisses; Morphalou: ABSENT — Morphalou tags «puisses» thirdPerson — a raw-data error, the cell is lost
- `pouvoir / ind:pre:1s` — Lefff: peux, puis; Morphalou: puis — Morphalou's only «peux» row is secondPerson; the cell survives via «puis» alone
- `fuir / sub:pre:1s` — Lefff: fuie; Morphalou: fuisse — Morphalou states «fuisse» (mis-tagged; it is the sub:imp) and lacks «fuie»
- `sortir / ind:pre:1s` — Lefff: sors; Morphalou: sortis — Morphalou's one verb entry drops the 1s «sors» row AND mixes in the rare legal «-issant» conjugation, so the cell realizes as «sortis» — a WRONG form, not a missing one

## Decision

Per #131's rule — Morphalou wins if it has the cells missing in Lefff and comparable-or-better intersected coverage — **Morphalou 3.1 wins the A/B**:

- verb: realizable cells 92,030 → 103,040 (+12.0%) intersected with the reduced vocabulary.
- noun: realizable cells 49,803 → 68,280 (+37.1%) intersected with the reduced vocabulary.
- adj: realizable cells 42,844 → 53,509 (+24.9%) intersected with the reduced vocabulary.
- Lefff's confirmed basic-verb defects are covered by Morphalou: the «fouts»/«fous» class error, and the 1990 rectified spellings Lefff lacks wholesale.
- Morphalou's own basic-verb holes exist but are per-entry, small and ENUMERABLE (2 cells + 14 forms on the top 300, all listed above). Lefff's failure mode — a wrong inflection class silently truncating or corrupting a paradigm — cannot be enumerated from inside the data. That asymmetry is the issue's premise, and it reproduces.
- GLÀFF is not needed: Morphalou's gaps do not defeat the decision rule, and it would trade curated-per-entry data for Wiktionnaire noise.

Two hazards the unified-table issue MUST carry forward:

1. **Mixed-paradigm entries.** Morphalou appends a homographic rare conjugation inside the SAME entry (sortir, repartir), and with a dropped 1s row the cell realizes a WRONG form («je sortis»), not a missing one. The build needs a mixed-paradigm detector (conflicting co-cells inside one entry) plus frequency gating, and must validate the enumerated top-verb cells loudly.
2. **The enumerated basic-verb holes** (puisses, assis m:p, peux 1s, fuie, sors/sortais/sorte 1s, …) need explicit guards — validation against the expected paradigm, NOT a silent cross-source patch: #131 rules out any union of sources.
