# AGENTS.md — @whippin/benchmark (offline LLM puzzle benchmark)

> Package-scoped guidance. The root `AGENTS.md` applies here too (engineering
> principles, the per-puzzle JSON schema, testing policy, issue/PR workflow). This
> harness REPLAYS the web front's game rules: the score/guess-identity contract lives
> in the Score section of `packages/web/AGENTS.md`, and `llm_play.py`'s `_guess_key`
> is the parity twin of the web's `guessKey` — they move together. Paid provider
> calls never run in tests/CI.

## File map

```
  benchmark/                  offline LLM puzzle benchmark (pkg @whippin/benchmark, #68)
    scripts/llm_play.py       LLM player/referee; reads generation output + web vocab
    scripts/playbook_distill.py  92-puzzle ultra analyst -> critic playbook distiller (#88)
    datasets/strategy-fr-92/  frozen static distillation corpus (92 gzipped puzzles)
    playbooks/                versioned final critic-only model playbook profiles
    tests/test_llm_play.py    provider-adapter + game-rules parity tests
    output/                   full local benchmark/distillation records (gitignored)
    pyproject.toml, uv.lock   isolated Anthropic/OpenAI + Kimi transport dependencies (uv)
```

---

## Commands

Run from the repo root (`pnpm --filter @whippin/benchmark`); no `--` separator —
pnpm forwards args straight to the script.

```bash
# Benchmark a generated puzzle offline, as a lab reading. --model is required
#    and runs exactly one model. Missing API-provider keys skip with a warning; --effort applies
#    one reasoning level (none|low|medium|high|xhigh|max; default none). --auth api
#    (default) uses the selected provider's API key; --auth subscription uses authenticated
#    Claude.ai / saved ChatGPT Codex-plan access, or Kimi Code with KIMI_CODE_API_KEY.
#    GPT API runs allow the documented
#    none|low|medium|high|xhigh|max; ordinary Codex-plan play supports
#    low|medium|high|xhigh|max. Kimi K3 requires subscription auth,
#    rejects none, and maps medium/high -> high plus xhigh/max -> max. --session
#    persistent|stateless defaults to persistent: one native provider conversation per
#    run is the primary product benchmark; stateless reconstructs the complete public
#    record in fresh turns for diagnostics. The historical frozen shared gameplay baseline
#    is prompt v21 at medium effort with NO --playbook. The current harness is prompt v23;
#    do not mix its results into v21 comparisons. --playbook remains an experimental loader only;
#    the static-corpus playbooks are paused and must not be used for benchmark scores.
#    --runs N plays N full runs (default 1); every run is recorded as-is — there is no
#    representative selection and no cost pruning. Puzzle paths may be repo-root-relative
#    (packages/generation/output/...) or generation-package-relative (output/...).
#    EVERY invocation appends its complete session (all runs, transcripts, token usage)
#    to output/<puzzle>.bench.json — file-locked, so overlapping runs for different
#    models accumulate instead of clobbering each other. The puzzle JSON is never written.
pnpm bench:puzzle <puzzle.json> --model MODEL [--playbook <model>.playbook.json] [--effort LEVEL] [--auth api|subscription] [--session persistent|stateless] [--cap N] [--runs N]
KIMI_CODE_API_KEY=... pnpm bench:puzzle <puzzle.json> --model KIMI --auth subscription --effort medium

# PAUSED EXPERIMENT: bootstrap one model's playbook from all 92 static French puzzles
#    (#88). Do not run this for normal benchmark production. Each real
#    run makes exactly two resumable paid calls: unrestricted analyst, then independent
#    critic/rewrite. Workflow-level ultra maps to Sonnet adaptive+max, Codex-plan GPT
#    literal ultra, or GPT API max+Pro. --dry-run validates all inputs and reports exact
#    identities/call count without auth checks, writes, or provider calls. Raw outputs
#    are gitignored; selected final-only profiles are versioned under benchmark/playbooks/.
pnpm bench:playbook:distill --model SONNET --auth subscription [--dry-run]
pnpm bench:playbook:distill --model GPT-SOL --auth subscription [--dry-run]
```

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- **Offline LLM benchmark harness (#68, Kimi provider #91, native sessions #93,
  decided 2026-07-19).** The
  dedicated `benchmark` workspace owns `benchmark/scripts/llm_play.py`, its tests, and
  its provider dependencies.
  It imports generation's canonical `scripts/slug.py`, reads the same web vocab as the SPA,
  and replays folded-vocab existence, unique-try scoring, broadcast rank/MISS feedback,
  strict improvement, solved locks, and the counted-try cap. The singular `--model`
  accepts the seven-model roster's friendly selector (`OPUS`, `SONNET`, `FABLE`, `GPT-SOL`,
  `GPT-TERRA`, `GPT-LUNA`, `KIMI`) or exact id; each invocation runs exactly one model.
  **The harness is a lab instrument only (user-decided 2026-08-12):** the app's benchmark
  display was removed (root `AGENTS.md`, schema section), and with it went the roster's
  `display` flag, the `--selection median|best` machinery (representative selection and
  every cost-pruning path), and `--in-place` (the puzzle-JSON embed). Nothing ever writes
  into a puzzle file; every invocation appends its complete session to the lab artifact
  (below). Ordinary play exposes `none|low|medium|high|xhigh|max`: GPT-5.6 API supports the full scale;
  Codex-plan GPT supports `low` through `max`; Anthropic supports `none` through `max`.
  Kimi requires `--auth subscription` with the dedicated `KIMI_CODE_API_KEY`, rejects
  `none` (which would route away from K3), and maps `low→low`, `medium|high→high`, and
  `xhigh|max|ultra→max` (`ultra` is internal, not an ordinary CLI choice). Its distinct
  `kimi_code_agent_sdk` transport pins
  `https://api.kimi.com/coding/`, uses a fresh temp workspace/config, and an Agent SDK
  invocation with no system prompt, tools, MCP,
  settings, skills, agents, plugins, or slash commands; inherited Claude credentials,
  config, and endpoint/model overrides are removed for the subprocess and restored on
  success or failure. Console output and raw lab sessions record requested + effective
  effort, provider/model/transport/auth/session, prompt/cap, duration, and
  **canonical token-usage schema v1** (decided 2026-07-19); token-aware transports also
  print each counted turn's canonical usage immediately. Its fixed fields are inclusive
  `input_tokens`, the `cached_input_tokens` and `cache_write_input_tokens` subsets,
  inclusive `output_tokens`,
  nullable `reasoning_output_tokens` (null when the provider has no breakdown), and
  `total_tokens = input_tokens + output_tokens`. Provider-native payloads remain alongside
  the canonical values as local raw audit data. Persistent Codex CLI's cumulative thread
  snapshots are differenced within each run before per-turn display or aggregation, and
  the baseline resets for every run. Prompt
  v23 defaults `--session persistent`: each run opens one fresh native provider conversation,
  then sends only the newest referee message. Agent SDK transports resume their session id;
  Codex CLI resumes its saved thread; Anthropic API retains the complete assistant content,
  including signed thinking blocks; OpenAI Responses chains `previous_response_id`.
  `--session stateless` is the controlled diagnostic: every turn is fresh and reconstructs
  the fixed rules, initial clues, every prior player reply and exact ordered outcome, plus the
  latest authoritative snapshot. Both modes expose the same public puzzle evidence; neither
  adds hidden puzzle data. The rules explicitly say a displayed ranked clue's
  distance is already known and cannot improve its own word at an equal rank. In stateless
  mode, Anthropic receives the byte-identical prompt as a cacheable fixed-rules block plus the
  growing record.
  The visible reply must be one word, while the prompt affirmatively requires private
  multi-step deduction; malformed prose is rejected, never truncated into a guess.
  `--playbook` accepts only a model/provider/prompt-matched,
  hash-verified `whippin_model_playbook` profile and injects its `final_playbook` under the
  fixed rules as advice. `--runs N` plays N full runs (default 1, ONE uniform default for
  every model — Kimi included, no per-provider divergence); every run is played to its
  natural end (solve, cap DNF, or a bounded reply error) and recorded as-is. Kimi prints its counted-guess
  exposure and warns that
  non-counting turns add paid requests; `low` still uses adaptive thinking. Lab sessions
  record the session mode and each run's termination. **Every invocation appends its
  complete session — all runs, transcripts, token usage — to
  `output/<puzzle>.bench.json`** (`write_lab_artifact`), **guarded by
  `_exclusive_file_lock`** (an advisory `flock`
  on a sidecar `.<name>.lock`) spanning the read AND the write: the atomic replace alone
  only makes the final swap indivisible, so without the lock two overlapping runs both
  edit the same snapshot and the second drops the first's session. Local benchmark
  output is gitignored and paid provider calls never run in tests/CI.
- **Frozen neutral gameplay baseline (decided 2026-07-17).** Use prompt v21 at `medium`
  effort, without `--playbook`, for both Sonnet and GPT. Two direct same-puzzle stateless
  v21 smokes produced 11 then 6 tries for Sonnet, and 13 then DNF-at-30 for GPT, exposing
  substantial GPT reliability variance. The static-corpus Sonnet/GPT playbooks regressed
  play and are paused; keep them as audit artifacts, not production guidance.
- **Paused bootstrap playbook distillation (#88, decided 2026-07-16; paused
  2026-07-17).** The rigorous calibrated
  neutral-play curriculum from #84/#86 is postponed, not discarded: its exact combined tip
  is preserved remotely at `archive/rigorous-calibration-curriculum-2026-07-16` (`5d727aa`).
  The active branch instead commits `benchmark/datasets/strategy-fr-92`: exactly 92 French
  static puzzles / 276 targets with manifest-bound sentences, secrets, starts, ranks, and
  hashes. `playbook_distill.py` validates the whole graph before auth or writes, then builds
  one deterministic context packet containing every puzzle/target, all neighbors through
  rank 50, and deterministic landmarks through rank 10,000. Each model makes exactly TWO
  resumable long-form calls: an unrestricted analyst pass, then a second critic/rewrite pass
  over the same evidence plus the draft. Workflow `ultra` maps to Anthropic adaptive thinking
  + `max`, Codex-plan GPT literal `ultra`, or GPT API `max` + Pro reasoning. There is no old
  eight-item/2,000-character playbook cap. Both raw stages remain only in the gitignored audit
  artifact; the separate hash-pinned profile contains the critic's final playbook, and ONLY
  that final text can enter `llm_play`. The accepted Sonnet/GPT critic profiles are versioned
  in `benchmark/playbooks/`; raw analyst and continuation transcripts remain local. Claude
  Code max-output recovery can emit one logical answer across several assistant messages, so
  the adapter assembles every ordered text block and removes an exact repeated seam before
  hashing the stage. `--dry-run` performs zero auth checks, writes, or calls.
