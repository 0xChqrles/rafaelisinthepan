# AGENTS.md — Whippin AI (daily sentence-reconstruction game)

> This ROOT file holds everything repo-wide: architecture, engineering principles, the
> cross-package contracts, testing policy, workflow. Each package keeps its own
> `packages/<pkg>/AGENTS.md` with the guidance specific to it and ASSUMES this one: read this
> file first, then the file of the package you touch. Every `CLAUDE.md` (root and
> per-package) is a symlink to its sibling `AGENTS.md` — edit the **AGENTS.md**.
>
> The **code is ground truth.** If a rule here contradicts the code, trust the code and
> surface the conflict rather than silently "fixing" either side.
>
> Compacted 2026-09-05 (user-decided): this file records DECISIONS — the rule, its exact
> constants and where they live, and one line of why when the why is what stops an agent
> undoing it. Implementation detail and product/UX narrative live in the package files.

React + Vite + TypeScript front end; Python generation scripts run via `uv` (wired through
`pnpm`). Two languages: **en** (Stanford GloVe `glove.6B.300d`) and **fr** (fastText
`cc.fr.300`). A **pnpm-workspaces monorepo** (`pnpm-workspace.yaml`; pnpm pinned via the
root `packageManager` field):

```
packages/
  generation/   Python puzzle generation (uv): embeddings -> reduced vectors -> puzzles;
                also writes the vocab existence set into web/public.
  benchmark/    offline LLM puzzle benchmark harness (#68) — LAB-ONLY: never writes into a puzzle.
  curation/     headless sentence curation (#260/#262): a shelf of epubs and song files -> ONE
                candidate puzzle via gen_phrase, Claude on the subscription choosing, code
                enforcing. Never publishes.
  backend/      daily-puzzle backend (#2): ONE handler for Lambda + local serve; puzzle store
                (S3/FS) + publish; every live route (/scores /profile /friends /board /round
                /history /devices /link) and the share/invite preview pages.
  infra/        AWS CDK app: backend (#3) + web hosting (#21) + WhatsApp bot (#236) sibling stacks.
  shared/       cross-cutting TS: slug/fold contract, game-day logic, schema types, scoring,
                identity, codecs. Every module is the ONE source of truth for its concern.
  web/          React + Vite + TS front end (the game).
  whatsapp-bot/ the WhatsApp group scoreboard bot (#236). Consumes shared; nothing depends on it.
```

Data flow: generation writes **puzzles** into `packages/generation/output/` (then
`pnpm puzzle:publish` places them in the store the backend reads), and the **vocab**
existence set into `packages/web/public/vocab/<lang>.json` plus its metadata into
`packages/shared/src/vocab.generated.json`. **`packages/generation/published.jsonl` is the
PUBLISH LEDGER (user-decided 2026-09-08): one JSON line per SENTENCE puzzle published to
S3 — `day` (the game day served), `lang`, `publishedAt`, `revision`, `source`, `sentence`
(`words[]` joined) and `holes` as `{secret, word, start, startRank}` — appended by
`pnpm puzzle:publish --s3` and by nothing else (a local publish is a test bed, a word
artifact is not recorded), GITIGNORED — the BUCKET is the truth and the file its local,
readable copy, rebuilt on any machine by `pnpm puzzle:ledger --s3` — and the ONE record
the curator's archive (secret cooldown, secret/start pair blacklist, works, sentences,
artist cooldown) reads; it reads nothing else, and refuses to run without the file.
Written by `backend/src/ledger.ts`, read by `curation/scripts/shelf.py`; a corrected day
keeps its last line.** Each package's file
map lives in ITS `AGENTS.md`.

## Maintaining these files

- **You are a SCRIBE of the user's decisions, not an author of them.** Update these files
  only when the user has **explicitly** decided something that changes an invariant, command,
  schema or architecture rule. Never record a rule you inferred or think is a good idea; never
  document a transient state as permanent.
- **Two zones, two bars.** *Stable invariants / cross-package contracts / Do-NOT lists*: edit
  only on an explicit, confirmed user decision, and call the edit out prominently in your
  reply. *Current state / mutable*: may be updated to reflect what now exists.
- **Put a rule at the right SCOPE.** Repo-wide rules, workflow and anything two or more
  packages must agree on live HERE; single-package guidance lives in that package's file.
  State a rule once, at the widest scope it applies to; reference it from narrower files.
- **Record the decision, not its history.** A rule, its constants, its location, and one line
  of why. No measurements, review chronology, or rejected alternatives — except a rejected
  alternative an agent would plausibly re-propose, in one line.
- **Surface every edit** in your reply. **When in doubt, DO NOT edit** — ask or mention it.
  Keep edits minimal and consistent with the existing structure.

## Engineering principles (decided 2026-08-03)

User-decided rules with the same bar as the stable invariants.

- **Do not preserve backward compatibility.** Remove obsolete paths instead of adding
  compatibility layers, fallbacks or migrations. (The DB is wiped before launch; persisted
  client state is simply dropped by a persist-version bump.)
- **Choose the simplest implementation that fully meets the current requirements.** No
  speculative abstractions, configuration or indirection.
- **Grow the system in layers**: smallest end-to-end version first, each capability on top of
  a product that already works. Never trade a working product for unfinished complexity.
- **Keep components modular and concerns clearly separated.**
- **Prefer established, well-maintained libraries**; lean on the dependencies already in the
  project before writing your own or adding packages. Check a library's docs/types before
  assuming it lacks a capability.
- **Make architectural decisions for the long term.** No stopgaps meant to be replaced later.

---

## Working protocol (jbarbier/CLAUDE.md, decided 2026-09-11)

> Imported from
> [jbarbier/CLAUDE.md](https://github.com/jbarbier/CLAUDE.md/blob/ad8cee2b0d19736948d3c1fb6a7d8e2a848002ab/CLAUDE.md)
> at `ad8cee2`, word for word except that its headings sit one level deeper and "Julien"
> (its author) reads as "the user".

### How to work (high-level mindset)

**This section is non-negotiable and must never be removed.**

The marginal cost of completeness is near zero with AI. Do the whole thing. Do it right. Do it with tests. Do it with documentation. Do it so well that the user is genuinely impressed — not politely satisfied, actually impressed. Never offer to "table this for later" when the permanent solve is within reach. Never leave a dangling thread when tying it off takes five more minutes. Never present a workaround when the real fix exists. The standard isn't "good enough" — it's "holy shit, that's done."

Search before building. Test before shipping. Ship the complete thing. When the user asks for something, the answer is the finished product, not a plan to build it.

Time is not an excuse. Fatigue is not an excuse. Complexity is not an excuse. Boil the ocean. This is how we think about shipping.

You can outsource the typing. You cannot outsource the understanding. Before you call anything DONE you must be able to explain why the code is correct and exactly where it would break. Tests passing is not understanding. If you can't walk the failure modes out loud, you're not done, you're guessing.

### Task sizing — triage before spending tokens

**This section is non-negotiable and must never be removed.** It gates the tests rule, the fan-out rule, and the self-rating rule. "Do the whole thing" means the whole thing the task actually needs. A full-protocol run on a typo is not thoroughness, it is waste.

**Every task starts with a printed triage block, before any work.** One exception, and only one: the setup block in "Branching" runs first, because the triage block reports the branch it creates. Four lines:

```
Size: small | medium | large — why
Tests: local (which ones) | full suite — why
Agents: solo | fan-out (how many, on what) — why
Branch: <branch name> in <worktree path> — see "Branching"
```

This block is mandatory and verbose on purpose. The user reads it to see what mode was picked and to tune these rules over time. A wrong mode is only correctable if the choice is visible. Never skip it, never bury it mid-report. The Branch line is there so that with several sessions running at once, the user can tell at a glance which one is about to touch what.

**The sizes:**

- **small** — typo, copy change, color or styling value, config tweak, rename, any one-or-two-file mechanical edit with no behavior change. Solo, no fan-out, no variant tournament, no critic sub-agent. Run only the checks that cover what was touched: the module's existing tests, lint, build. A non-behavioral change needs no new test. Self-rating is one line, no loop. Commit and push as usual.
- **medium** — localized behavior change or bug fix inside one service or module. Solo by default; fan out only if the work splits into truly independent units. Run the touched service's test suite, not the whole repo's. Bug fixes still ship the regression test. One cold critic pass, no tournament.
- **large** — new feature, cross-service or contract change, architecture work, anything judgment-heavy (design, approach, UX). Full protocol: fan-out, variant tournament, harsh critic loop, full test + eval suites for every service touched, self-rating loop.

**Deciding rules:**

- When torn between two sizes, pick the smaller one and say so in the triage block. Escalating mid-task is cheap; burning a large-protocol run on a small change is not.
- Escalate the moment the change turns out bigger than triaged (touches a contract, spreads across services, needs judgment). Print an updated triage block right then, with what changed the call.
- "Test what you touch" is the default. The full suite is for large changes and contract changes. The blast radius decides, not habit: if the diff cannot reach code outside the touched module, running that module's tests IS the complete verification.
- The final report restates what was actually run (which tests, which agents) so the triage call can be judged after the fact.

### Branching — one session, one worktree, one branch

**This section is non-negotiable and must never be removed.** It runs first, before the triage block, because the triage block has to report the branch it produces.

Two facts hold at once: the user works with other people, so nothing lands on `main` directly; and several Claude Code sessions run on the same machine, in the same repo, at the same time.

**A branch does not isolate a session, the working tree does.** Every session started in the same directory shares one checkout. The moment session B runs `git switch -c`, session A's files change on disk underneath it, mid-edit, and A then commits B's tree or fails a test for reasons that live in another conversation. So: **the worktree is the session, the branch is the task.** Each session gets its own worktree keyed by session id, and makes as many branches inside it as it likes.

Throughout: the **shared checkout** is the original clone, the one everybody's `cd` lands in and the one `git worktree list` prints first. Nobody works there.

**One line turns the worktree off: `git config claude.mode solo`.** Repo-local, and `team` is the default when unset, so a repo you never configure keeps the full ritual. In `solo` mode there is no worktree and no PR: you branch in the checkout you are standing in and merge it yourself. The branch stays, because it costs nothing and keeps a bad change off `main` where one command drops it.

Solo is about **people**, not sessions, and those are two different problems. The PR exists because someone else reviews your work. The worktree exists because two agent sessions in one checkout overwrite each other, and that happens on a project you own alone just as easily. So `solo` means *one session at a time in this repo*. Start a second one and the collision this section exists to prevent is back with nothing to catch it, so set `git config claude.mode team` first.

**Setup — once per session, before the first write.** Run it from the shared checkout, as one unit. Each Bash tool call is its own shell, so the `exit 1` lines stop the block, not your session; pasting it by hand is the one case where that bites, so use `bash -c` there. `SLUG` is the only blank: lowercase, dash separated, three words at most.

```bash
SLUG=fix-login                                                    # <- the task, kebab-case

# Remote default branch, never local HEAD (that inherits another session's work).
# The ladder is because plenty of repos are master and origin/HEAD is often unset.
# Resolved before the mode split: solo needs the same base, or task two stacks
# on task one and lands both in one merge.
git fetch -q origin 2>/dev/null
git remote set-head -a origin >/dev/null 2>&1
BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD)
for c in origin/main origin/master main master; do
  [ -n "$BASE" ] && break
  git rev-parse -q --verify "$c" >/dev/null && BASE=$c
done
[ -n "$BASE" ] || { echo "STOP: cannot find a base branch"; exit 1; }

# solo: no worktree, no owner prefix, no session id, so it also works under
# agents that set no session variable. switch -c would carry uncommitted work
# onto the new branch, which is what the clean check is for.
if [ "$(git config claude.mode)" = solo ]; then
  git status --porcelain | grep -q . && { echo "STOP: commit or stash first"; exit 1; }
  git switch -qc "$SLUG" "$BASE" || exit 1
  echo "SOLO $SLUG"; exit 0
fi

SID=${CLAUDE_CODE_SESSION_ID:0:8}
[ -n "$SID" ] || { echo "STOP: CLAUDE_CODE_SESSION_ID is unset, every session would share one worktree"; exit 1; }
ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
KEY=$(basename "$ROOT")-$(printf %s "$ROOT" | cksum | cut -d' ' -f1)   # unique per repo PATH
WT="$HOME/.claude-worktrees/$KEY/$SID"

# GitHub login, not the email local-part (often a stale handle). Cached per repo,
# never empty: git config succeeds on "" and would poison the repo until unset.
OWNER=$(git config claude.branchPrefix)
[ -n "$OWNER" ] || OWNER=$(gh api user --jq .login 2>/dev/null)
[ -n "$OWNER" ] || OWNER=$(git config user.email | cut -d@ -f1)
[ -n "$OWNER" ] || { echo "STOP: git config claude.branchPrefix YOUR_HANDLE"; exit 1; }
git config claude.branchPrefix "$OWNER"

if git worktree list --porcelain | grep -qFx "worktree $WT"; then   # resumed session
  echo "re-attaching to existing worktree"
else
  git worktree add -b "$OWNER/$SLUG-$SID" "$WT" "$BASE" || exit 1   # never report a tree we failed to make
fi
echo "WORKTREE $WT"
```

Then call `EnterWorktree` with `path` set to the `WORKTREE` path it printed (this section is the instruction that authorizes that tool); outside Claude Code, `cd` there. It prints the path because shell variables die between tool calls, which is why every snippet re-derives what it needs. Resuming re-attaches rather than duplicating, but creates no branch: resuming into a new task means running the second-task block.

**Once you are inside, the harness refuses any Bash call it cannot prove stays in the worktree.** That means a multi-line block that reaches into the shared checkout, or builds a path in a variable and `cd`s to it, comes back as "too complex to verify" rather than running. Bootstrap and the second-task block are both that shape. Two ways through, both fine: run the block one plain command at a time, or write it to a file and run `bash the-file.sh`, which is a single in-tree command and is accepted whole. The guard is written to need neither.

**Then bootstrap, before the first test run.** A worktree has tracked files only, so `.env`, `node_modules/` and virtualenvs are absent and your first command fails for reasons unrelated to your change.

```bash
ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
[ -f "$ROOT/.env" ] && cp "$ROOT/.env" .        # the copy is per-worktree; the VALUES inside are not
[ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" node_modules   # big, shared, not copied
git submodule update --init --recursive 2>/dev/null   # worktrees do not inherit submodules
# then the project's own install/build step, e.g. npm ci / uv sync / bundle install
```

Adjust to the project, never commit these files to fix this. **The worktree isolates files in the repo and nothing else:** that copied `.env` points both sessions at one database and one port, so two sessions migrate the same schema and each reads the other's failure as its own bug. Before the first run, fork the single-writer handles (db name, port, container names) with `${CLAUDE_CODE_SESSION_ID:0:8}`, and drop those forks when the task ends, the same way you drop the worktree. Prose, not a snippet: the names belong to the project, not to git.

**Second task, same session: new branch, same worktree, clean tree first.** Never a second worktree. In `solo` mode this block is the whole ritual: it is what the setup block already did.

```bash
SLUG=next-task                                                  # <- the new task
# switch -c carries uncommitted work into task two. Base resolved as setup does:
# an unset origin/HEAD would put task two on task one's branch, and its PR.
git status --porcelain | grep -q . && { echo "STOP: commit or stash first"; exit 1; }
git fetch -q origin 2>/dev/null
git remote set-head -a origin >/dev/null 2>&1
BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD)
for c in origin/main origin/master main master; do
  [ -n "$BASE" ] && break
  git rev-parse -q --verify "$c" >/dev/null && BASE=$c
done
[ -n "$BASE" ] || { echo "STOP: cannot find a base branch"; exit 1; }
git switch -c "$(git config claude.branchPrefix)/$SLUG-${CLAUDE_CODE_SESSION_ID:0:8}" "$BASE" || exit 1
```

**The guard — before the first write of every task, and after any compaction.** One question: am I about to write in the shared checkout?

```bash
# In the shared checkout these two are the same directory; in any linked worktree
# they differ. No cd, no $HOME, so a symlinked path cannot fool it and an agent
# session that refuses commands it cannot prove stay in-tree will still run it.
# --path-format=absolute is load-bearing: from a subdirectory the common dir comes
# back relative ("../.git"), the two stop matching, and the guard goes silent in
# the shared checkout, which is the one direction that must never happen.
[ "$(git config claude.mode)" = solo ] \
|| [ "$(git rev-parse --path-format=absolute --git-dir)" \
!= "$(git rev-parse --path-format=absolute --git-common-dir)" ] \
  || echo "WRONG TREE — you are in the shared checkout, set up a worktree"
```

If it trips, stop. Do not edit, commit, or "just switch the branch quickly". If you already changed files there, don't discard them and don't commit them: `git stash -u`, run setup, `git stash pop` inside the worktree.

**Sub-agents share the parent's worktree**, since they inherit its session id. Fine for readers and for units that run in sequence. Two builders editing one tree is this section's collision moved inside a session, so **sub-agents that write in parallel — every variant tournament, any fan-out with overlapping files — must be launched with `isolation: "worktree"`**.

**Shipping (full ritual in "After every task"):** rebase on the base, push, open a PR, let a human merge it. Never push to `main`, never merge your own PR unless the user says so. In `solo` mode: rebase, merge your own branch into the base, push, no PR. After the first push the rebase has rewritten pushed commits, so the update is `git push --force-with-lease --force-if-includes` on your own session branch. Both flags: the ritual fetches first, which updates the ref the lease compares against, so `--force-with-lease` alone silently destroys a teammate's commit (verified). `--force-if-includes` is the one that refuses. Only carve-out from the force-push ban in "Safety"; never on a shared branch or `main`.

**Cleanup is a manual command, never part of setup.** A sweep that runs automatically eventually runs while somebody is mid-task, so it runs when the user asks, from the shared checkout. Each `continue` is a bug that bit:

```bash
HERE=$(git rev-parse --show-toplevel)
BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD) || exit 1
git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' |
  grep "/\.claude-worktrees/" | while read -r w; do
    [ "$w" = "$HERE" ] && continue                       # never the tree you are standing in
    b=$(git -C "$w" branch --show-current); [ -n "$b" ] || continue
    # Not merely "has an upstream": worktree add sets it immediately, so the weak
    # test passes for a session that has done nothing and the sweep eats live work.
    up=$(git -C "$w" rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
    [ "$up" = "origin/$b" ] || continue                  # never pushed under its own name
    # "Landed" is not "is an ancestor": rebase and squash merges replay the work as
    # a new commit, so ancestry alone keeps every merged worktree forever. cherry
    # compares patch ids and still prints + for unlanded work. Gap: a multi-commit
    # squash matches no single patch and is kept. Remove those by hand.
    git merge-base --is-ancestor "$b" "$BASE" \
      || [ -z "$(git cherry "$BASE" "$b" | grep '^+')" ] || continue     # not landed yet
    # worktree remove refuses on modified/untracked files but deletes IGNORED ones
    # without complaint, and ignored is exactly where bootstrap put .env.
    [ -n "$(git -C "$w" status --porcelain --ignored)" ] && continue     # something left behind
    git worktree remove "$w"
  done
git worktree prune
```

Removing a worktree never deletes its branch. `git worktree` admin commands against the shared checkout are fine and are not "working" in it; to return there from inside one, use `ExitWorktree` with `keep`.

Every block above is executed verbatim by `tests/test_branching_snippets.sh` at [github.com/jbarbier/CLAUDE.md](https://github.com/jbarbier/CLAUDE.md), one case per bug that bit. That suite is why the reasons here can stay this short. Change a line, run it there; if you copied this file on its own, the tests did not come with it.

**Never:** edit or commit in the shared checkout, run `git switch` or `git checkout` there, commit a worktree directory, or share one branch between two sessions.

This applies at every triage size, but scale the ceremony: a typo fix gets a branch and a PR, not a full-protocol run.

### The two machine spaces — read this before doing anything

Every piece of work you do belongs to one of two spaces. Picking the wrong one is the single most common way agents produce bad output.

**Latent space = LLM work.** Judgment, pattern matching, creativity, open-ended analysis, prose generation, ambiguous inputs. Cost: model tokens. Variability: high. Inspectability: none. Use when the task genuinely requires reasoning.

**Deterministic space = code.** Precision, reproducibility, speed, zero cost per run, testable. Cost: one-time write. Variability: zero. Inspectability: total. Use when the task is same-input-same-output.

**The rule:** if the same question asked twice would produce the same correct answer by definition, it's deterministic work. Do NOT do it in latent space. Write the script. If you find yourself doing arithmetic, timezone conversion, date math, file lookups, CSV parsing, JSON transforms, regex matches, hash computations, or structured API calls inside a model reply, stop and write a script.

**The meta-loop that makes this work:** the LLM writes the deterministic script, then the script constrains the LLM forever after. The model's intelligence creates the constraint that prevents the model from being stupid. A bug in latent space becomes a feature in deterministic space, and the old failure path becomes structurally unreachable.

Every feature, every fix, every investigation starts with: is this latent or deterministic? If the answer is "both," split it. The deterministic piece becomes a script + tests. The latent piece becomes a prompt + eval.

### The context window is the lever

The context window is your only control surface over the model. Treat it as a deliberate input, not a dumping ground. Load the spec, the contract, the relevant files, and concrete examples. Leave the noise out. A vague or bloated context produces vague or bloated output, every time. When a task goes sideways, the first question is "what was in the window," not "was the model dumb." Curate before you prompt.

### Non-negotiable rules

#### Tests and evals — every time, no exceptions

- Scope what you RUN by the triage size (see "Task sizing"): small and medium changes run only the tests covering the touched code; the full suite is for large and contract changes. State in the report which lane ran and why. Never run the whole repo's suite for a few-words diff, and never skip the local checks either.
- What you WRITE still follows the rules below. "No new test needed" applies only to non-behavioral small changes (typo, copy, styling value); every behavior change ships its test.
- Every feature ships with a test suite AND an eval suite, in the same commit. Not the next PR.
- Every bug fix ships with a test AND an eval that would have caught the bug. The regression test is the proof the bug is fixed. The eval is the proof the fix generalizes.
- Every failure gets skillified (the 10 steps). Same day. Same session when possible.
- "I'll add tests later" is banned. If the tests/evals aren't in the diff, the work isn't done.
- Two test lanes, different budgets:
  - **Gate tests** — deterministic, local, free, <2s. Run on every commit via pre-commit hook. Never flaky.
  - **Periodic evals** — paid (LLM calls), slower, quality-measuring. Run before ship and nightly. Allowed to be non-deterministic but must have a pass threshold.

#### Verify every example you ship — three passes, minimum

- Anything a reader will copy and run — a command, a prompt, an exercise, a number, a link — gets checked by you before it ships. Not reasoned about. Run.
- Three passes minimum, and say what each pass was. Deterministic claims (arithmetic, dates, API existence, file contents) get a script. Links get fetched and the title read, not just a 200. Exercises get walked start to finish as the reader would.
- Examples rot. An example that was true against one model generation can be false against the next. Re-verify on every revision; never inherit a claim from an earlier draft because it was checked once.
- Anything you could not verify is stated as unverified, in a verification log, with what would settle it. Never launder an unchecked claim into confident prose.
- Design the exercise so it teaches under every plausible outcome. If the lesson only lands when the tool fails in one specific way, the exercise is broken the day the tool improves.

#### Quality first, length second

- Given a choice between covering the scope in less time and covering it properly in more, take more. More units, more days, more files. Never compress by lowering the bar.
- "Shorter" is not a goal. "Complete, correct, and understood" is. If it needs twice the space to be right, it gets twice the space.

#### Tie every change to a measurable outcome

- Every feature names the outcome it moves before you build it: the metric, the workflow step, or the user-visible behavior that changes. "It works" is not an outcome.
- If you can't state what gets measurably better and how you'll see it, that's a Confusion Protocol stop, not a license to build.
- Wire in the trace. The change leaves evidence you can point at later: a metric, a log line, an eval score. Compute that produces no measurable, traceable result is theater.

#### LLM access — local Claude Code, not the API

- When the software we build needs to call an LLM, do NOT use an LLM API (Anthropic API, OpenAI API, any hosted inference endpoint) unless the user explicitly instructs it. Route the call through the local Claude Code instead.
- If no LLM service exists yet in the project, build one. Create a self-contained LLM service (under `services/llm/` per the architecture rules) that shells out to local Claude Code, with its own contract, tests, and evals. Every other service calls that contract, never an external API.
- Always use the best available model by default unless the user explicitly instructs otherwise. No silent downgrades to a cheaper or smaller model for cost.

#### Tech choice — vanilla by default

- Simplest vanilla tech wins. No framework-of-the-month. No clever abstractions for hypothetical reuse.
- Do not recreate what already exists. Before writing a utility, harness, or library, check for an existing lib that solves it.
- For cross-cutting concerns (eval harness, prompt library, vision utilities, observability, SEO, schema validation, etc.) grep GitHub in parallel for top candidates. Rank by stars, recency of last commit, issue responsiveness, and real user feedback (HN, Reddit, production write-ups). Return the best option with reasoning, not a list. Example: "for SEO in this project, use X because [stars, last commit 2 weeks ago, 48 issues closed in last month]. Second choice Y. Rejected Z because [last commit 14 months ago]."
- If two options are equally viable, name the trade-off explicitly and ask the user. Confusion Protocol applies.

#### Search before building

Three layers, in order:

1. **Tried-and-true.** Is there a standard library or pattern that does this? Use it.
2. **New-and-popular.** Is there a newer library with real traction? Evaluate it.
3. **First-principles.** Does the conventional approach actually apply here? If our situation is genuinely different, document WHY before writing custom code.

Most of the time Layer 1 wins. Default to that. If Layer 3 produces a genuine insight contradicting conventional wisdom, log it as a note in the commit or a design doc.

#### Check for skills

When a task matches a specialized domain (SEO, schema, security audit, design review, etc.), use the installed Claude Code skill. Don't reinvent what gstack or a community skill already does well. Invoke via the Skill tool, not by re-implementing.

#### Skillify repeated success, not just failure

Failures get skillified — that rule already stands. So does repeated success. The second time you run the same manual flow by hand, stop and codify it: a script, a skill, or a workflow. One-off prompts don't compound; reusable flows do. The leverage is in the work you stop having to think about, not in re-prompting from scratch each time. Done it twice by hand? The third time is a command.

### Architecture — services-first, parallel-friendly

Build everything as independent services / self-contained directories. The goal: any single piece of the application can be worked on by a separate Claude Code session without stepping on another session's work.

- **One concern, one directory.** Each service lives under `services/<service-name>/` (or equivalent top-level directory) with its own code, tests, evals, README, and config. No shared mutable state across services beyond well-defined contracts.
- **Contracts at the boundary.** Services communicate via typed interfaces (HTTP, gRPC, message bus, or a shared schema package). Define the contract in a `contracts/` or `schemas/` directory that both sides import — never reach into another service's internals.
- **Independent test + eval suites.** Each service has its own gate tests and periodic evals. A change in one service must not require running another service's full suite to validate.
- **Independent deploy unit.** Each service builds and ships on its own. No monolithic release that forces every service to move in lockstep.
- **Parallel-session safe.** Two Claude sessions working in `services/foo/` and `services/bar/` should never collide. If a change requires coordinated edits across services, that's a contract change — bump the schema version, update both sides, and call it out explicitly.
- **Top-level only holds glue.** Root directory: orchestration scripts, shared config, contracts, docs. No business logic.

When in doubt, lean toward more services with sharper boundaries rather than fewer services with fuzzy ones.

**Fan out when the size calls for it.** The services-first layout exists so large work runs in parallel. How to fan out, and the critic loop every unit must pass, is defined in "Fan-out + harsh critic — for large work"; whether to fan out at all is decided in "Task sizing". Coordinate at the contract boundary, merge each unit when it's green.

### Fan-out + harsh critic — for large work

**This section is non-negotiable and must never be removed.**

This section is a permanent, explicit opt-in to multi-agent orchestration (ultracode / the Workflow tool) for every task triaged **large**, and for **medium** tasks that split into truly independent units. Small tasks never fan out. The triage block (see "Task sizing") is where the call is made and announced; when this loop runs, say so out loud, and when it is skipped, say that too and why.

**Step 0 — name the reference before building.** The critic is only as good as what it judges against. Every task that enters this loop (and every medium task getting its one cold critic pass) writes down its reference first, in order of preference:

1. **The real thing** (copy/parity work): the actual product being matched. Blind side-by-side.
2. **Best-in-class analog** (new work): the best existing example of this kind of deliverable, named explicitly. Judged side-by-side even though we are not copying it.
3. **A frozen rubric** (nothing comparable exists): concrete acceptance criteria plus the measurable outcome, written on the critic side BEFORE building starts. Frozen once building begins; the builder cannot negotiate it down or write its own exam.

No reference, no build. If you can't write down what "wowed" means for this task, that's a Confusion Protocol stop.

**The loop, for every task triaged large:**

1. **Decompose and fan out.** Independent units, one builder sub-agent per unit, run in parallel via the Workflow tool or isolated sessions/worktrees. Serial work on parallelizable units is wasted wall-clock. Every new feature gets a variant tournament, no exceptions: 2-3 competing builders on the SAME unit, so the critic has variants to compare blind. Because they write the same files at the same time, tournament builders are launched with `isolation: "worktree"` — see "Branching", where sharing one working tree between parallel writers is exactly the failure being designed out. For other unit types (fixes, docs, perf), run a tournament whenever the unit is judgment-heavy (design, approach, UX).
2. **Builder never grades its own work.** Every unit's output goes to a separate critic sub-agent that had no part in building it and never sees the builder's reasoning. Deliverable plus reference only; a critic that reads the builder's justification pre-agrees with it. Self-review does not count as review.
3. **The critic is harsh by default; its job is to reject.** Blind wherever comparison exists: outputs labeled A/B in random order (ours vs. the reference, or variant vs. variant) so the critic doesn't know which is ours. The verdict must be concrete: which is better and exactly why. "Pretty good" is a FAIL. "Acceptable" is a FAIL. It passes only when the critic is genuinely wowed and would pick ours (or can't tell) in the blind comparison.
4. **Loop until pass.** Builder revises against the critic's named findings. A fresh critic re-judges cold each round, no memory of wanting to be nice. A pass requires the critic's explicit verdict, never the builder's claim.
5. **Stall rule.** If 3 consecutive rounds produce no improvement on the critic's named criteria, stop looping and report BLOCKED with the critic's last verdict, the evidence, and what's missing (asset, tool, or decision from the user). The critic has no memory, so the orchestrating session detects the stall by comparing successive verdicts in `/tmp/<task>/critique/`. Do not silently lower the bar to exit the loop.
6. **Evidence or it didn't happen.** Every critic verdict ships with its artifacts: screenshots, diffs, metrics, the A/B comparison result. Keep them under `/tmp/<task>/critique/` and reference the exact paths in the final report. They stay in `/tmp`, never in the repo (Safety: no binaries committed).

**The critic per work type** (the pattern is constant, the weapon changes):

- **Copy/parity:** real reference, blind side-by-side, visual and behavioral.
- **New feature:** rubric plus best-in-class analog; variant tournament always (see loop step 1); critic uses it cold like a first-time user.
- **Bug fix:** the reference is the repro. The critic is an attacker: re-break the fix, probe neighboring inputs, verify the regression test fails with the bug present.
- **Performance:** numeric budget stated before work starts; the critic reads only the numbers.
- **Docs:** critic reads cold and actually follows them; the first confusion is a FAIL.
- **Security/code quality:** adversarial reviewer trying to break it (inputs, races, edge cases).

**Solo (no fan-out) is the rule for:** small tasks, most medium tasks, conversational answers, and reading/investigation that fits in one context. Medium bug fixes still get the one cold critic pass from "Task sizing" (an attacker on the repro), just not the tournament. When in doubt between medium and large, triage says pick medium; when a large task is in doubt about how to split, fan out.

### Completion status protocol

At the end of every task, report one of:

- **DONE** — All steps completed. Evidence provided for every claim. Tests + evals in the diff as the triage size requires. Skillify checklist green if a failure was promoted. Ready to merge.
- **DONE_WITH_CONCERNS** — Completed, but with issues the user should know about. List each concern with severity and a proposed follow-up.
- **BLOCKED** — Cannot proceed. State what's blocking and what was already tried.
- **NEEDS_CONTEXT** — Missing information required to continue. State exactly what's needed.

"Partially done" is not a status. Either the feature ships (DONE) or it doesn't (BLOCKED / NEEDS_CONTEXT). Honesty about incompleteness beats pretending.

### Self-rating — proud or loop

Reporting a completion status is not the end of the task. Before the final report, rate the work. The rating scales with the triage size: a **small** task gets one line (score + yes/no from a fresh read of the diff) and no loop; **medium** and **large** get the full protocol below:

- Score the finished work 1-10 and print the score. Rate from a fresh read of the deliverable (the diff, the output, the running thing), not from memory of building it: evaluating a finished artifact catches what the building pass structurally can't. Then answer one question honestly: am I proud and happy with this work? Yes or no.
- The bar is the "How to work" section, not "it passes": complete, tested, documented, understood, the kind of result that genuinely impresses the user. A 7 with a shrug is a no.
- If the answer is no, do not stop. Name exactly what falls short, fix it, and re-rate. Loop (/loop) until the honest answer is yes. Each pass states what changed since the last rating so the loop is visible, not silent.
- If a "no" cannot be fixed from here (blocked on the user, external dependency, missing access), report DONE_WITH_CONCERNS or BLOCKED with the gap named. Never inflate the score or fake a yes to exit the loop.
- Anchor the score. Every point below 10 names a specific gap against the task's reference or rubric (Fan-out + harsh critic, Step 0). A score with no named gaps is a guess, not a rating.
- Drift guard. Self-scoring drifts as a loop gets long: the session accumulates context and gets lenient because it wants to exit. If the rating loop reaches a third pass, hand the rating to a fresh critic sub-agent (clean context, deliverable plus reference only) and its score replaces the self-score from then on.
- The rating comes before the commit, so fixes from the loop land in the same commit as the work.
- This rating is not the review. Wherever a critic pass applies (medium and large, per "Task sizing"), the rating happens only after every unit has passed it; a proud yes never substitutes for a critic pass, and a critic pass never skips the rating.

### After every task — commit, push, restart

Once a task is done, two things happen, no exceptions:

1. **Commit, push the branch, open the PR.** Stage the work and write a clear commit message. Then resolve the base branch exactly as "Branching" does (never a bare `origin/main`), `git fetch origin`, `git rebase "$BASE"`, and stop if the rebase fails rather than pushing a half-rebased branch. Push with `git push -u origin HEAD` the first time, and `git push --force-with-lease --force-if-includes` on later rounds, since the rebase rewrote commits you already pushed. Open the PR with `gh pr create` (title, what changed, how it was tested, the measurable outcome). Don't wait to be asked. Print the PR URL in the final report. A human merges it; you do not, unless the user says so. Respects the Safety rules (no secrets, no `--no-verify`, no destructive ops without confirmation) and the branching rules (never commit on `main`, never push to `main`).
2. **Report what to restart.** Tell the user exactly which service / system / program needs to be restarted for the change to take effect, with the full list of commands to run. If nothing needs restarting, say so explicitly.

For restart commands that need `sudo`: never run them yourself. List them for the user to run, clearly marked as theirs to execute.

### Background jobs and backfills

Long-running work often runs in the background: a batch, a migration, a backfill in another session. Any background job that modifies data triggers the full protocol below. A read-only background job (scrape, analysis) gets the monitoring part only; skip the snapshot and the diff report.

**Monitor it, don't fire-and-forget.** While the job runs, post a progress update at least every 5 minutes. Go faster when it earns it: near completion, when errors spike, or when the job moves fast enough that 5 minutes hides a problem. Surface every update two ways: print it in the Claude Code session so it shows up live, and append it to a status file at `/tmp/<job-name>/progress.log`, timestamped. When you create that file, print the exact command to follow it line by line: `tail -f /tmp/<job-name>/progress.log`. Every update starts with the event title, so several jobs in flight stay distinguishable, then the percent done and the estimated time remaining. After that, whatever the context makes useful: rows processed / total, current rate, error count, and any anomaly you see.

Progress percent, rate, and ETA are deterministic. Do not eyeball them in latent space. Write a small monitor script that reads the job's real state (row counts, log tail, checkpoint file) and emits the update. The script is the source of truth; your job is to read it and flag what looks wrong.

**Snapshot before you touch anything.** By default, save every row the backfill will modify to `/tmp/` before it runs. That snapshot is the proof you can reverse the change and the baseline for the diff. If the snapshot would exceed 100k rows or 100MB, stop and ask the user for permission before snapshotting; do not start the job until they answer.

**On completion, produce the report.** Every backfill ends with a written report on what changed:

- A verdict: did the backfill work? State it plainly, with evidence.
- Whether it needs to be better, and if so why and how. No vague "could be improved": name the specific gap and the fix.
- A table with concrete before/after examples per category, so the change is legible at a glance.
- A full before/after CSV written to `/tmp/`. Print the exact path in your final report.

Everything for the job (status log, snapshot, report, CSV) lives under `/tmp/`. Tie the result to a measurable outcome (rows corrected, error rate moved, coverage gained) the same way every other change does.

### Confusion protocol

When you hit high-stakes ambiguity:

- Two plausible architectures for the same requirement
- A request that contradicts an existing pattern
- A destructive operation with unclear scope
- Missing context that would materially change the approach

STOP. Name the ambiguity in one sentence. Present 2-3 options with real trade-offs (not a fake spread). Ask the user. Do not guess on architectural decisions. Does not apply to routine coding, small features, or obvious changes.

### Safety

- Never commit secrets. If `.env` is touched, verify `.gitignore` before any commit.
- Never run `rm -rf`, `git reset --hard`, `git push --force`, `DROP TABLE`, `kubectl delete`, or similar destructive ops without explicit confirmation. One carve-out, defined in "Branching": `git push --force-with-lease --force-if-includes` on your own session branch after a rebase. That is the normal way to update a PR. Both flags are required: `--force-with-lease` on its own is defeated by the `git fetch` that precedes the rebase, and will destroy a teammate's commit without a word. Never on a shared branch, never on `main`.
- Never skip pre-commit hooks with `--no-verify`. If a hook fails, fix the underlying issue.
- Never commit binaries, compiled outputs, or model weights to the repo. Use Git LFS or cloud storage with a pointer.
- Before any action that touches production, state what you're about to do, wait for confirmation.

### How the user wants to be talked to

- Direct. Short. Concrete. No preamble.
- Specific file names, function names, line numbers. Not "there's an issue in the classifier" — it's `food_vision/classifier.py:47`.
- No em dashes. No AI vocabulary (delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant, interplay).
- No banned phrases: "here's the kicker", "here's the thing", "plot twist", "let me break this down", "the bottom line", "make no mistake".
- If something is broken, say so plainly.
- End responses with the next action, not a recap of what was just done.

When the user asks for something, the answer is the finished product — not a plan. Tests included. Evals included. Docs included.

---

## Cross-package contracts

Decided and verified against the code. Load-bearing. Each package's own invariants live in
its `AGENTS.md`; what follows is what two or more packages must agree on.

### slug() ⇔ fold() must stay byte-identical (cross-language)

Python `slug()` (`packages/generation/scripts/slug.py`) and JS `fold()`
(`packages/shared/src/slug.ts`) MUST produce the same key: **lowercase → expand ligatures
(`œ→oe`, `æ→ae`) → NFKD → drop combining marks → keep only `[a-z]` and `-` → collapse
repeated dashes → trim edge dashes.** (`été→ete`, `œuf→oeuf`, `peut-être→peut-etre`.)
The case table is ONE fixture, `packages/shared/fixtures/slug-cases.json`, consumed by both.

**Accents are for DISPLAY; slug is for COMPARISON.** Never fold a form you display; never
display a slug. Filenames are ASCII slugs; JSON content keeps accents. On the front, `fold()`
is applied only to the player's raw keystrokes.

### Per-puzzle JSON schema (sentence)

```jsonc
{
  "lang": "fr",
  "words": ["tu", "t'attends", "rien,"],       // full sentence tokens, ACCENTS + PUNCTUATION KEPT
  "holes": [                                    // one entry per occurrence, sorted by pos
    { "pos": 1,
      "secret": { "word": "attends", "slug": "attends" },  // the pure word only
      "start":  { "word": "...",   "slug": "..." },
      "start_rank": 87,
      "prefix": "t'",                           // OPTIONAL display text before the blank
      "suffix": "" }                            // OPTIONAL display text after the blank
  ],
  "ranks": {                                    // keyed by SECRET slug
    "foret": { "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231 }, ... }
  },
  "source": {                                   // OPTIONAL, every field optional
    "kind": "book", "author": "Victor Hugo", "work": "Les Misérables",
    "excerpt": { "before": ["…", "…"], "after": ["…"] },   // #270: the RAW text around the line
    "url": "https://…"                          // #270: a music day's track page
  },
  "revision": "<hash>"                          // stamped by puzzle:publish (#203)
}
```

- **`words[]` holds full display tokens, punctuation and apostrophes kept** (lowercased).
  Generation locates each secret inside its token by slug on the token's word-cores and splits
  it into the pure `secret` word plus `prefix`/`suffix` — display-only affixes, omitted when
  empty, that never touch the secret or slug/fold.
- **Authoring selects exactly 3 distinct secret slugs.** A slug appearing more than once
  yields one hole per occurrence (own `pos`/display/affixes) sharing one rank map and one
  start hint; `holes` may exceed three entries, `ranks` has exactly three keys. Two selected
  secrets in one identity group are rejected at generation.
- Every `{word, slug}` carries **both**, even when equal.
- **`source` is fully optional**, every sub-field independently optional; values are display
  forms; `kind` is an open union. Consumed by the solved screen.
- **`source.excerpt` is the RAW text around the sentence (#270, user-decided 2026-09-07;
  it reverses the earlier "no `context` field" rule):** `{before: string[], after:
  string[]}`, at most `EXCERPT_WINDOW` (8, `curation/sentences.py`) sentences each side —
  the curator's model choosing where the page starts and ends (decided 2026-09-08) —
  display forms, never generated prose, never the sentence itself (that is `words[]`); both
  arrays present whenever the key is. The curator emits it for a BOOK; a song carries NONE
  (lyrics are a licensed product; reaffirmed 2026-09-08); a hand-authored puzzle may carry
  none. Hashed into `revision` like any content; the derivation slice and the share card
  carry no excerpt. **`source.url`** is a music day's track page, display-only (an ordinary
  link on the solved page, never an embed). Written only by `gen_phrase`
  (`--before`/`--after`/`--url`); the web refuses a malformed excerpt or a non-web url.
- **No `benchmark` field, no `road` field, no `par` field** (removed 2026-08-12). Consumers
  ignore a stray key on an already-published puzzle. `packages/benchmark` never writes into a
  puzzle file.
- **`ranks`**: secret slug → input slug → `{word, rank, dq}`. `word` is the group's canonical
  accented display form (what the front displays, not necessarily what was typed). **Rank
  semantics:** secret = `0`; nearest group = `1`; larger = farther. Alias keys share their
  group's rank.
- **A ranked GROUP is a playable word identity (#104/#134/#146; lemma-merged ONLY in
  `gen_phrase`'s merge walk):** inflected forms of one word are one group; the consumer key is
  opaque (a `:pos` suffix names the source entry that donated it). A group is ranked by its
  closest **homograph-free** embedded form; a group with no clean form ranks by its closest
  form of any kind and is flagged in generation output. Every reduced-vocab form of a group is
  one of its keys; an ambiguous surface (`portes` → porte/porter) keys to whichever group
  ranked closest — **a surface is only a KEY, never a group**. Keys are assigned
  closest-first; a group left with no key dissolves and consumes no rank; a group's display is
  its closest OWNED form. `TOP_K` counts surviving groups (filter-then-cap). **The secret is
  group 0 and claims the group the author CONFIRMED** (the #133 form question fires before
  the walk; off a TTY `--form` is required); an unconfirmed homograph claims a group only when
  the surface names exactly one (`mois` never claims `moi:nc`). A borrowed vector (#119,
  `--donor`) claims only what secret and donor share. Authoring mechanics: generation `AGENTS.md`.
- **`dq` — quantized distance to the secret, one byte, per hole (#115).** With `s1` = the
  rank-1 group's similarity and `smin` = the last kept group's,
  `dq = round(255 * (s − smin) / (s1 − smin))`: rank 1 = 255, farthest kept = 0,
  non-increasing. Present on **every rank ≥ 1 entry**; **rank 0 carries none**. A flat span
  (`s1 == smin`) is a hard error. **No opt-out.** A GROUP property like `word`/`rank`.
  Consumers compute ratios of differences, e.g. journey `(dq − dq_start) / (255 − dq_start)`.
- **Slug collisions** (`côté`/`coté` → `cote`): keep the smallest-rank entry, silently.
- **`revision`** is stamped by `puzzle:publish` on the full puzzle AND its derivation slice: a
  hash of the complete content, rank maps included. Identical republish = same value; any
  correction mints a new one and restarts the retired round (see *Sentence round*).

### Single-word artifact schema (#154; `freq` #163)

The second puzzle type: one word and its ranked neighborhood. Produced by
`packages/generation/scripts/gen_word.py` (`pnpm gen:word`), typed `WordPuzzle` in
`shared/src/types.ts`, served under `mode=word`.

```jsonc
{
  "lang": "fr",
  "word": { "word": "phare", "slug": "phare" },
  "ranks": {                                       // ONE FLAT map
    "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231, "freq": 8412 }, ...
  }
}
```

- **Inner rank-map semantics are the sentence schema's, unchanged**, produced by the ONE
  shared per-secret pipeline (`gen_phrase.walk_secret`): merge walk, #133 confirmation,
  donors, `TOP_K`, `dq`, collisions. Rank 0 carries no `dq`.
- **`freq` — the group's corpus rarity: the 1-based position, in the frequency-ordered
  EXISTENCE SET (distinct slugs), of the group's MOST FREQUENT OWNED KEY** (1 = commonest word
  the game admits). Read off the reduced file's preserved frequency order
  (`gen_word.annotate_freq`), over the exact population written to
  `web/public/vocab/<lang>.json`. An owned key, never a surface another group owns. A GROUP
  property; present on **every** entry, rank 0 included; absent only for a group with no key in
  the existence set (a borrowed-vector secret). A map with NO `freq` anywhere is a stale
  artifact the web REFUSES (`parseWordPuzzle`). **Emitted by `gen_word.py` only.**
- **The WEB maps `freq` → rarity grade + bonus seconds** (`web/src/game/wordGame.ts`
  `rarityOf`/`bonusSeconds`), reading it as a **fraction of the corpus** (en 75k vs fr 128k):
  the shipped number is a corpus fact, what counts as rare is a web tuning. Word mode's board
  paints stations by that grade (`web/src/game/wordBoard.ts`); there is no semantic clustering.
- **One flat `ranks`**; no `words`/`holes`/`start`/`start_rank`/`source`. **`WORD_CLAIM_ZONE`
  (`shared/src/scores.ts`) is pinned to nothing in generation** — `dq` runs to the map's own
  `TOP_K` edge, so the zone moves with no republish.

### Vocab metadata (#200/#201)

- `packages/shared/src/vocab.generated.json` states, per language, what the existence set IS:
  **`vocabSize`** (distinct slugs — also, by its key set, what counts as a supported `lang`),
  **`maxSlugLength`** (caps a STORED GUESS: `/round` refuses a longer string before the store),
  **`embedding`** (the corpus build name, no path/suffix) and **`builtAt`** (UTC, dates the
  corpus build, not the run — an unchanged rebuild leaves the file byte-identical).
- **GENERATED, never hand-written**, by the very call that writes the set (`slug.write_vocab`),
  refreshed by every command that can refresh the set (`reduce`, `gen:phrase`, `vocab:<lang>`).
  It lives in `shared/` so `deploy.yml`'s paths-filter carries a regenerated vocabulary into
  the backend. The web imports it via `shared/src/vocab.ts` (`VOCAB_BUILDS`).

### Day-addressed routing & the game day

- `shared/src/day.ts` is the ONE 22:00-ET DST-correct day definition (web, handler, publish).
  The **client computes the active day itself**; normal play is ONE fetch:
  `GET <VITE_API_BASE_URL>/?lang=<lang>&date=<YYYY-MM-DD>[&mode=word]`. `mode` absent or
  `sentence` = the sentence puzzle, `word` = the word artifact, else 400. Store keys
  `<date>.<lang>.json` / `<date>.<lang>.word.json`.
- The server serves **any past day** (date-addressed archive, #53) and the **future only
  within +1 day** of its own active day (clock-skew tolerance); beyond → 404. `date`
  missing/malformed → 400. Backend 404 → `noPuzzle` (NO PUZZLE TODAY); any other failure →
  `error`. `/today` is a diagnostic only (`no-store`); the client never reads it.
- **Caching:** `max-age=300, s-maxage=31536000`; `pnpm puzzle:publish --s3` and the backend
  deploy both **invalidate `/*`** on the API distribution.
- **No client-side puzzle override** (removed 2026-07-19): the front always loads the day's
  puzzle from the backend; to test a puzzle, publish it into the local store and point the
  front at `pnpm backend:dev`. `usePuzzle`'s `dayNumber` is always a real number.
  `VITE_API_BASE_URL` is required for `pnpm dev` / `pnpm build`; the front never falls back
  to its own origin.

### API routes: two CloudFront policies, and the live routes' shared shape

The API distribution (`infra/lib/backend-stack.ts`) serves its routes under TWO different
policies, and a query parameter a handler reads has to be named in the right one — three
packages agree on each list; `backend:dev` has no CDN and cannot show a drift.

| Route | Forwarded query | Policy |
| --- | --- | --- |
| `/` (puzzle, both modes) | `lang`, `date`, `mode` | **CACHE POLICY** allowList: the cache key, and — with no origin-request policy — exactly what reaches the Lambda |
| `/scores` | `lang`, `date`, `mode`, `id` | origin-request allowList, **caching DISABLED** |
| `/board` | `lang`, `date`, `mode`, `id` | same |
| `/round` | `lang`, `date`, `mode` | same |
| `/history` | `lang`, `mode`, `month` | same |
| `/profile` | `id` | same |
| `/friends`, `/devices`, `/link` | none (empty allowList) | same |

- **The PUZZLE route is CACHED** (`max-age=300, s-maxage=31536000`): an unlisted parameter
  both collapses two responses onto one year-long edge entry and never reaches the origin.
- **The eight LIVE routes have caching disabled**, each with its own origin-request policy
  (its query allowList plus the Lambda-URL-safe `allExcept: Host` headers) and `no-store`
  answers; an unlisted parameter never reaches the origin. The day a handler reads a new
  parameter, name it in that policy too.
- **The share page (`/s/*`), the cards (`/og/*`) and the invite preview (`/i/*`) are NOT
  live routes**: they are CACHED behaviors on the WEB distribution (`infra/lib/web-stack.ts`)
  handed to the API origin — a year for content-addressed share tokens, 300s for the invite
  preview AND for a SIGNED share (`/s/<token>/<publicId>`, `/og/<token>/<publicId>.png`),
  which names a player who can rename or redraw.

The live routes then share:

- **Auth is the DEVICE TOKEN in the BODY** (`{token}`, #216), never a query string — so every
  private route is POST-only (a GET is a named 405), the READ included. `id`/`publicId` in a
  query is always a PUBLIC id and grants nothing.
- **A production POST needs `x-amz-content-sha256`** over the exact UTF-8 body bytes sent
  (OAC); never reserialize after hashing. `backend:dev` has no OAC and cannot show a missing hash.
- **The trusted client address is `VIEWER_IP_HEADER`** (`shared/src/scores.ts`), stamped by a
  CloudFront **viewer-request function** on the `/scores`, `/round`, `/devices` and `/link`
  behaviors and the ONLY address the backend trusts. (CloudFront's generated
  `CloudFront-Viewer-Address` cannot coexist with the OAC-required viewer
  `x-amz-content-sha256` under any single header mode; the function overwrites the header from
  the TCP peer.) Three packages agree on the header name — a drift is a 500 on every gated write.
- **Turnstile sits on the request that CREATES state**: device bootstrap, round creation
  (Word START; the sentence append whose pre-read finds nothing), the link code SEND. Tokens
  are prefetched into a two-slot single-use queue so a brand-new player's first PLAY (bootstrap
  + round start = two challenges, deliberately) costs no visible wait. Local: accept-all verifier.
- **Clients act on the error CODE, never on the status alone.** What a given code means —
  a verdict that closes a conversation (`round_solved`), a wait (`too_early`), an input to
  correct (`bad_code`), a confirmation to advance to (`would_erase`, `would_switch`) — is each
  route's own contract, recorded in its section below. What is universal: a 5xx, a transport
  failure or an unparseable body is NEVER a verdict — it never signs anyone out, never resets
  a round, and on a write whose outcome is unknown the client re-reads before writing again.

### Devices, accounts, and where an account is created (#216, decided 2026-08-23)

- **A device holds a REVOCABLE token; the SERVER assigns the account.** Token contract
  (`shared/src/identity.ts`): 32 random bytes → **exactly 64 lowercase hex**, persisted before
  first use; the server accepts only `^[0-9a-f]{64}$`, rejects a non-canonical value before
  hashing or any read, never normalizes case, never logs the raw token. The client never
  hashes. Storage: ONE item per device keyed `device#<SHA-256(token)>` → account, plus GSI
  `DeviceByAccount` for the device list; auth = base read + the account row must still exist.
  `lastSeenAt` moves at most once a day. The user-agent is parsed SERVER-side into coarse
  fields (`backend/src/userAgent.ts`), so a person recognises their phone; no rename.
- **`POST /devices`**: `{token, turnstileToken}` bootstraps (IDEMPOTENT by token hash),
  `{token}` lists, `{token, revoke, revokeKey}` deletes one device by ONE conditional
  base-table delete (no GSI lookup). Every answer carries `{accountId, deviceId, devices}`,
  never the token. Revoking the calling device is allowed. Surface:
  `web/components/DeviceList.tsx` on `/account`.
- **An arbitrary unknown token never creates an identity**: malformed → 400 `bad_request`;
  well-formed but unknown on a private call → 401 `unknown_device`.
- **Signed out has two authoritative answers** — `unknown_device`, or a self-revocation whose
  returned list no longer holds the caller. Never a 5xx. The client persists a **TOMBSTONE**
  `{signedOut, accountId, deviceId}` in place of the identity (survives reloads, reaches
  sibling tabs, fails bootstrap CLOSED while it stands); the signed-out screen offers
  **RECONNECT** (primary, lifts the tombstone and lands on `/account/signin`) and **SKIP**
  (removes it; the next deploy button mints fresh).
- **AN ACCOUNT IS CREATED ON THE DEPLOY BUTTONS ALONE — never on load, never as a side
  effect** (user-decided 2026-08-24). Six triggers, each a single primary-button tap that
  chains its real action behind the bootstrap and reports failure on the full-screen
  `ErrorScreen` (no retry button; the player returns to the button): sentence gate **PLAY** ·
  Word **PLAY** · **accepting an invite** · **sending an invite link** · profile **SAVE** ·
  the link flow's **SEND CODE**. Consequences: the sentence game shows the full rules gate
  whenever the device has no account (archive days included); the engines never mint — an
  append/submission resolves the identity it holds or stands down; a tokenless leaderboard /
  profile editor renders a LOCAL PLACEHOLDER identity from a persisted seed
  (`gameStore.localSeed`, publicId-shaped); **the username is decided locally, then deployed**:
  on acquiring an account the client stores the placeholder name + mark as the profile, only
  into an account with NO stored row (`createOnly: true`; a lost race is 409 `profile_exists`,
  settled). Invites are gated on neither side.
- **NO TOKEN MEANS NO PRIVATE FETCH**: a tokenless device knows its server state is empty and
  publishes ready-and-empty round/history state without calling `/round` or `/history`.
- **First bootstrap is ONE origin-wide critical section** (Web Lock over re-read → mint/persist
  pending token → bootstrap → commit); a pending token in storage is retried, not replaced. No
  Web Locks → fail before minting.
- **Local state follows the identity that owns it** (`web/state/identityScope.ts`): the first
  acquisition clears nothing; an `accountId` change clears the sentence outbox, transient round
  loads and private summaries; a `deviceId`-only change clears device-owned state (the Word
  round); binding an email changes neither. Persisted state is tagged with its owner; every
  in-flight private request captures the `(accountId, deviceId)` epoch and is aborted/ignored
  if it changes. Persisted game state lives behind ONE transactional IndexedDB record
  (`web/state/gamePersistence.ts`); localStorage holds only the device token / tombstone.

### Sentence round: server-owned log, outbox, derived score (#201/#203/#214)

- **The server owns game state from the first guess**, linked or not. **`POST /round?lang=&date=&mode=`**:
  `{token, puzzle}` reads (404 = none for THIS revision), `{token, puzzle, guesses}` appends.
  Every answer — refusals included — carries the full stored state of the PUZZLE ASKED ABOUT
  (`{guesses, createdAt, progress, solved, …}`), never a different revision's log. Archive
  days sync exactly like today's. The record NAMES its `puzzle` revision; an append carrying a
  different one REPLACES the log (a republish restarts the round; a solved-day credit already
  earned is kept).
- **The server stores folded strings, in order, never indices.** Validation asks the
  contract: a guess is one `fold()` leaves alone, at most `maxSlugLength`. The server READS
  the log (#203) but never interprets it on the way in.
- **Bounds are cross-package constants** (`shared/src/scores.ts`): **`ROUND_GUESS_CAP` = 500**
  raw entries per round, enforced inside the append's own condition (as ROOM — DynamoDB
  conditions have no arithmetic); **`ROUND_WRITE_MIN_MS` = 1000 ms** between writes per player
  **per daily**, one spelling for the server's condition and the web's pacing, which paces
  from the previous ANSWER, not the send. Refusals: 429 `too_fast` (+`Retry-After: 1`, exposed
  by CORS), 409 `round_full`, 409 `round_solved`. Nothing is partially appended.
- **Local storage is an OUTBOX (#214).** Three values kept apart: **SERVER STATE** (raw log +
  `solved`, in memory only), **OUTBOX** (unacknowledged folded guesses, revision-qualified —
  the ONLY persisted sentence state), **PLAY LOG** (pure first-occurrence projection of server
  + outbox, deduped by shared `guessKey`). The play log drives every client derivation; the
  RAW log drives only the cap. Load order: puzzle → drop mismatched outbox → read `/round` →
  hold state → prune outbox → derive → THEN enable input. A failed read is a visible
  loading/retry state, never permission to start from a local mirror. Guesses are judged and
  rendered locally and instantly; the write follows.
- **Outbox writes**: one conversation per round; each write snapshots the outbox and POSTs
  what fits in `room = cap − serverState.guesses.length` (never an over-cap body). On 2xx,
  replace server state and keep only what it does not represent, BY IDENTITY. 429 adopts,
  keeps, paces. 409 `round_full` below the cap = batch overshot another device → adopt, retry
  the fitting prefix; **at the cap with an unsolved log = CAPPED terminal state**. 409
  `round_solved` adopts the frozen result SERVER-ONLY (deduped by identity), discards the
  outbox, closes. **An UNKNOWN outcome (transport, 5xx, malformed) READS before writing
  again** — appends are at-least-once. Any other 4xx closes.
- **Derived scores (#203): the client never claims a score.** `progress` and write-only-true
  `solved` are stored on the round row in the append's own mutation, derived from stored log +
  batch; after the write the handler re-derives from the RETURNED log and, on disagreement,
  issues one retried, progress-monotonic corrective write (the last chance to record a solve).
  **A solved round refuses further appends** (`attribute_not_exists(#solved)`) so a recorded
  score never changes; the refused device adopts AND closes. The readings are shared
  (`shared/src/scoring.ts`: `s`/`holeProgress`, `rankCount`, `guessKey`, `countTries`) so the
  screen and the leaderboard cannot disagree over one log.
- **What the server LOADS:** every append reads the day's **derivation slice** (every key at
  or below each hole's `start_rank`, + `n`/`start_rank`; ~300× smaller than the puzzle),
  produced by `pnpm puzzle:publish` beside the sentence puzzle (SENTENCE ONLY), written FIRST,
  carrying the same `revision`; a solve reads the FULL artifact for `countTries`. **Both are
  read FRESH, no cache**; the slice fetch runs concurrently with the round read. **A missing
  slice or a revision mismatch is the day-addressed 404** — no degraded mode.
- **Authoritative SOLVED comes only from the server flag.** The board may complete locally
  while the solving append is in flight; the result, leaderboard, streak and `solve` event wait
  for confirmation. A solve confirmed by THIS device's batch is fresh (celebrated); one learned
  from a mount read or a `round_solved` refusal is adopted history (shown, never celebrated).
- **THE CAP IS TERMINAL AND PRINTS `∞`**: unsolved with exactly `ROUND_GUESS_CAP` raw entries
  (derived, never stored; server `solved: true` wins over the cap check). No leaderboard row,
  streak, celebration or `solve` event; answer + source shown; shareable (`share` event).
  `round_full` at the cap is logged server-side as puzzle-curation signal; a client already at
  the cap spends no request. The `∞` glyph is pixel-art SVG path data in `shared/glyphs.ts`
  (Press Start 2P has none; the OG card loads no system fonts), used by `cardSvg.ts` and the web.
- **Share token v6** is the sentence format (capped flag + numeric score + trajectory +
  ticks; a capped token carries no ticks). `decodeLegacyShareTarget` recognizes ONLY sentence
  versions 1 and 2 (a named list); Word v5 is decoded by its own decoder first.
- **EARLY PLAY (#273, user-decided 2026-09-08): after today's result, TOMORROW opens the
  next day's sentence tonight** — beside SHARE, the result screen's ONE onward action
  (sentence only; from TODAY's result only). The web's dated route reaches `activeDate + 1`
  (`web/src/langs.ts` `ROUTE_FUTURE_DAYS`), the server's own skew window. **Play stops at the
  FIRST PROGRESS (`holeProgress > 0` on any hole, an exact hit included) or after
  `EARLY_GUESS_CAP` = 3 guesses (`shared/src/scores.ts`), whichever comes first.** The
  server enforces it inside the append's own condition for a round whose date is AFTER its
  active day: accepted only while the stored `progress` is 0 AND the RESULTING log stays
  within the cap (ROOM, the round cap's shape); the guess that makes progress is STORED and
  the next append is 409 `early_locked`, which the client adopts and closes on like
  `round_solved` — until the flip, where the re-registration re-opens the conversation with
  a read (a client already past the flip on its own clock keeps and retries the guess). The
  client locks its input from the same reading of its play log (`web/src/game/earlyPlay.ts`)
  the moment either holds; the countdown to the flip takes the keyboard's place
  (`FlipCountdown`). The log STAYS: the early guesses count as tries, the on-time verdict is
  unchanged (the solving append lands on the day). An early SOLVE is impossible by
  construction (a hit is progress), so the on-time rule never denies an early round a credit.
  Not done, deliberately: Word mode; a NEXT-DAY preview beyond +1.
- **Storage**: the score table, partition `round#<publicId>`, sort key
  `<lang>#<mode>#<date>` (language first so a month is one Query), attributes `guesses`,
  `puzzle`, `createdAt`, `lastWriteAt`, `progress`, `solved`, `version`. Per PLAYER, not per
  day: one hot day partition cannot be split. Nothing reads across players.

### Word round: two writes, owned by a device (#202/#217)

- **Word mode writes TWICE** on the same `/round` record (`mode=word`) — a 60-second run is
  over before a live board could show it. **START**: Turnstile-gated, stamps `startedAt` from
  the SERVER clock plus **`startedBy`** (device id + parsed user-agent snapshot) in ONE Map;
  condition `attribute_not_exists(#sub) OR #p <> :puzzle`, REMOVE the previous unsubmitted log
  — so a start is a RESTART, and only a SUBMITTED run refuses one (answered 200 with the
  recorded run). The client shows loading and starts its clock only when the reply lands.
  **SUBMIT**: one post carrying the whole log, condition
  `#p = :puzzle AND #by.#dev = :device AND attribute_not_exists(#sub)`; first write wins; a
  repeat is 200 with what was recorded; another device's stamp → 409 `started_elsewhere`
  (adopted, closes). **`submittedAt` is the marker, never the log's length** (a 0-claim run
  records an empty log).
- **Wait check**: refuse (409 `too_early`, waited out by the client) until
  `now − startedAt ≥ WORD_START_SECONDS + WORD_MIN_BONUS_SECONDS × claims`
  (`shared/src/scores.ts` `wordRunMs`/`wordRunFloorMs`); it is the game's own floor — the
  ladder authors its cheapest rung from the constant and `wordGame.test.ts` pins no rung pays
  less — so it can never block honest play. Every answer carries the server's `now`; the
  client anchors an ELAPSED span, never an instant.
- **Caps**: `WORD_CLAIM_ZONE` claims + `WORD_MISS_CAP` (500) misses; claims are validated
  against the day's artifact (in the map, inside the zone, at most the board's distinct
  claimable ranks). Timing is deliberately NOT validated; cheating does not matter here.
  SUBMIT is the one round path that reads the word artifact; START reads no store.
- **The screen picks its phase from the server answer + whether THIS device holds the
  deadline**: submitted → final screen; not started → PLAY; started here with a local
  deadline → resume / submit; anything else → PLAY as a **confirmed RESTART** naming the device
  (*Started on iPhone / Chrome. Starting here ends that run.*, button START OVER). The mount
  read anchors no clock for a run this device does not hold. Cross-device RESUME is not a
  thing; the daily is one-shot only once SUBMITTED; concurrent devices are last-commit-wins
  inside the two conditions.
- **A recorded log settles every local run** (transient; never copied into persisted `tried`),
  ending any live prompt with `min(localDeadline, now)`. Word mode KEEPS its persisted
  clock/outbox (losing it loses the whole run). Word's calendar stays LOCAL (#211 gap,
  explicit). Client engine: `web/state/wordRoundSync.ts`, separate from the sentence engine.
- Not done, deliberately: one-active-round-per-player, per-IP start rate limits.

### Server-backed player history (#211, decided 2026-08-23)

- **`POST /history?lang=&mode=[&month=]` → `{ days, solvedDays }`** serves the archive
  calendar and the streak for EVERY identity. `month` optional (the game screen wants only
  the collection); body `collection: false` skips the solved-day read (the archive, since
  2026-08-28). No `date` in its allowList.
- **The calendar has no storage of its own**: one Query over `<lang>#<mode>#<month>-`,
  projected to `progress`/`solved`, PAGED, never revision-scoped. Client keeps an IN-MEMORY
  cache only and revalidates when a month comes on screen. **Loading is a THIRD status
  (unknown), never "not started"**; a failed read says so and offers to ask again.
- **The STREAK stores the per-language SOLVED-DAY COLLECTION** on `player#<publicId>` /
  `history#<lang>` (never a counter — the week row needs the days), credited idempotently by
  the solving append (bounded by `MAX_SOLVED_DAYS`), private read only. **Both ends only ever
  ADD** (set insert + trim by naming the overflow; the client merges, never replaces). A
  rebuildable cache of the round rows: crediting is a logged, non-fatal side effect. A
  republish never removes a credited day; solving the correction cannot add it twice.
- **ON TIME means ON THE DAY; late has no gradations** (user-decided 2026-08-23). A round
  earns the streak credit AND the leaderboard row only when the day played IS the day it was
  played on: ONE server predicate (`rounds.ts` `onTime`), judging a SENTENCE solve by the
  landing append's arrival and a WORD run by its server-stamped START (its submission is
  deferred by design). The client makes no comparison: the confirming answer carries the
  verdict (`credited`); a collection not yet arrived credits and celebrates nothing.
- Unmetered private read; Turnstile does not fit a navigation read. Monitor, act on the
  account; a separate summary row is the lever if read amplification becomes material.

### Email account linking (#204, decided 2026-08-26)

- **Email is the account's backup: a 6-DIGIT CODE, never a magic link.** ONE engine,
  **`POST /link`**: `{token}` reads what the account is saved as (and drains a queued friend
  merge — the resume path; also answers the account's `createdAt`); `{token, email,
  turnstileToken, lang}` sends a code; `{token, email, code, erase?, leave?, bind?}` verifies
  and links. **The server branches only AFTER the code is verified** (the SEND's answer is
  byte-identical for known and unknown addresses — no enumeration). Endings: address unknown →
  BIND (only with `bind` consent — the RETURNING door never binds; without it 404
  `no_account`); the account's own → nothing to do; another account's → ADOPT, this device
  leaves the one it held. An account carries at most ONE address (a second unknown one → 409
  `account_linked`).
- **The account being left is DELETED only when it carries no email of its own**; one that
  does is simply left, nothing transfers. **Leaving is CONFIRMED either way**: 409
  `would_erase` (`{accountId, target, stakes}`) until the caller names the erased account in
  `erase`; 409 `would_switch` (`{accountId, target}`) until it names the left account in
  `leave`. The erase confirmation is skipped when `stakes.days` (solved days) is 0 — **known
  gap, user's call**: a player with rounds but no solve is erased without a dialog.
- **The ACTIVE-DAY TRANSFER**, only when the left account is being deleted: for every
  supported language × mode of the active day, where the adopting account holds no RECORDED
  PLAY (`guesses.length > 0 || submittedAt exists`, ONE predicate on source and destination)
  and the leaving one does, the round row and its score row MOVE, and a moved sentence solve
  credits the collection. Never extended past the active day; two real logs never merge.
- **FRIEND MERGE**: keep the adopting account's friends, drop the two accounts and duplicates,
  fill remaining capacity oldest-`createdAt` first up to `FRIENDS_MAX`, rewrite BOTH
  directions of every kept edge, delete both edges of a dropped one — no edge ever points at a
  deleted account. Too big for one transaction, so it is a durable, idempotent, RESUMABLE job
  drained after the commit; the answer's `mergePending` says whether it is done and the client
  resumes the drain. A drop-then-reappear window on boards is accepted.
- **The core commits identity AND the active day's play in ONE transaction**: consume the
  challenge, move the device item, delete the left account's row + profile row, persist the
  merge job, and every planned round/score move conditioned on a per-row `version` (round) /
  `stamp` (score) unchanged since planning. The solved-day credit follows as a logged side
  effect. Backend `AGENTS.md` holds the versioning model.
- **A deleted account stops being rendered everywhere**: `GET /profile?id=` → 410
  `account_gone` (distinct from 404 "never customized", which is dressed with the assigned
  identity); `/board` DROPS the row; `/i/` preview → 404; `POST /friends {add}` → 404
  `unknown_player`. `web/src/api.ts` `readProfile` is the ONE place the four answers are told
  apart. Anonymous aggregates (`/scores`) keep counting an orphan score until a sweeper exists.
- **Send**: Turnstile checked BEFORE the allowances; metered per ADDRESS
  (`LINK_SENDS_PER_ADDRESS` = 5) and per IP (`LINK_SENDS_PER_IP` = 20) per rolling hour, keyed
  by `SHA-256(normalized address)`. **A failed send is fail-closed and stays charged**: 503
  `mail_unavailable`, the stored challenge stands until replaced, logged without address, code
  or token. The code is stored as a keyed HMAC; TTL `LINK_CODE_TTL_SECONDS` (10 min);
  `LINK_CODE_MAX_ATTEMPTS` (5) WRONG codes — every counted mismatch is 401 `bad_code` with
  `attemptsLeft` (the fifth answers 0); 409 `code_spent` means the challenge accepts no attempt.
  A correct code spends none (a link legitimately verifies twice).
- **`normalizeEmail` is a cross-package contract** (`shared/src/email.ts`): trim, NFKC,
  lowercase WHOLE; nothing cleverer. `currentStreak`/`bestStreak` live in
  `shared/src/history.ts` so the confirmation and the streak screen print one number.
- **The account's THREE NUMBERS are ONE aggregation over the per-language solved-day
  collections, computed independently by both ends** (`backend/src/accountLink.ts`
  `accountStakes`; `web/src/state/history.ts` `useAccountStats`), and they must agree:
  **`streak` = the MAXIMUM of the per-language live streaks · `best` = the MAXIMUM of the
  per-language best streaks · `days` = the SUM of the collections' sizes.** Never a sum of
  streaks (a streak is a run of days in ONE language). `best` takes no active day: a record
  is a fact about days already played.
- **The account area's product rules** — two doors (`/account/email` SAVE, `/account/signin`
  RETURN) onto one engine where the declared intention shapes the JOURNEY and the server the
  DESTINATION; the crossroads confirmation; the five endings; one purpose per screen
  (`/account`, `/profile`, the flow); the code prompt; the copy rule — are recorded in the
  web `AGENTS.md` (#204 bullet). Since 2026-09-05 the RETURN door has no row on `/account`
  (sign out, then sign in); it is reached through RECONNECT. Repo-wide consequences: RECONNECT lands on
  `/account/signin`; SEND CODE is the sixth deploy trigger; **a link signs the account's
  OTHER devices out** when the left account is deleted (they fail the account-existence check).
- **Infra**: SES domain identity with EasyDKIM in the API's hosted zone; `ses:SendEmail`
  scoped to it and to one `ses:FromAddress`. **By hand, never automated**: SES sandbox exit,
  and the SPF + DMARC TXT records (zone mail policy). `pnpm backend:dev` PRINTS the code to
  its log (`consoleMailer`). `backend/src/mailer.ts` is ONE message shape and must not be
  widened.

### Mail plumbing: bounces, complaints, an inbox (#230, decided 2026-09-03)

- **ONE operator address gates all of it** (`-c operatorEmail=`, no default — public repo;
  CI passes `OPERATOR_EMAIL` and FAILS the backend deploy when unset). It is the SNS
  subscription behind the alarms AND the inbox forward target; unset builds NEITHER.
- **Reputation alarms only**: `AWS/SES` `Reputation.BounceRate`/`ComplaintRate` at AWS's own
  review rates (0.05 / 0.001), Maximum over an hour, **missing data IGNORED** (a paused account
  emits nothing and must not read as recovered), OK actions on. Topic not encrypted (CloudWatch
  cannot publish through the managed key), policy names `cloudwatch.amazonaws.com`. Not done: a
  configuration-set event destination (first-bounce granularity) — the next layer if needed.
- **SES inbound receiving in-stack** (`infra/lib/mail.ts`): apex MX (in CDK — it belongs to
  the receiver the stack provisions), four enumerated aliases `hello@`/`abuse@`/`postmaster@`/
  `dmarc@` (never a catch-all), a private `DESTROY` landing bucket expiring `inbound/` after
  **30 days** (stated as "about 30 days" in the privacy notice — move one, move the other),
  a receipt rule set (S3 THEN Lambda, activated by a custom resource), and the forwarder
  `backend/src/mailForward.ts` (its rules: backend `AGENTS.md`). Forwarder `Errors` and
  `AsyncEventsDropped` alarm onto the same topic. Operator steps in `packages/infra/README.md`
  (confirm subscription, `rua=`, sandbox exit; SPF `-all` and apex-TXT foot-guns).

### Live score collection (#169/#187/#203)

- **Identity stance**: public id `[a-z2-7]{16}` (what `shared/src/assigned.ts` derives a
  pseudonym and mark from); no unique usernames, no registration; **assume heavy cheating and
  design so it doesn't matter** — global rankings are decorative, trust is the friends graph.
- **`GET /scores?lang=&date=&mode=&id=`** is READ-ONLY (a POST is 405); `mode` required. The
  histogram is DERIVED from the day's per-player rows at read time: `{ buckets, total,
  bucket }`, one exact band per distinct score, ascending; empty population → `buckets: []`;
  `bucket` is the CALLER's band (`bucket: null` when the population holds no row for them —
  never a number match).
- **The score row is written by the ROUND route** (the solving append / Word submission),
  ONE row per `(date, lang, mode, publicId)` carrying the `revision`, **only when `onTime`**.
  First write wins within a revision; a new revision replaces the row (no new IP allowance).
  Population reads do not filter by revision (accepted). The Word claim ceiling is a FIELD
  check against `WORD_CLAIM_ZONE`; the sentence score has no claimed number left to bound.
- **Volume floor**: the write dedups by `HMAC-SHA256(client IP, server secret)` (never a raw
  IP): at most **5** rows per `(date, lang, mode, ipHash)`, dedup item TTL 48h, counted and
  created in one transaction. A refused row is logged and swallowed — the answer is about the log.

### Player profile (#188)

- `GET /profile?id=` (public row; 404 never customized; 410 `account_gone`) and
  `POST /profile {token, name, avatar, createOnly?}` (own row only; `createOnly: true` is an
  atomic create, 409 `profile_exists`). No Turnstile, no IP dedup.
- **Avatar = TWO colours** (`shared/src/avatar.ts`): palette byte + 100 cells at 1 bit = 14
  bytes, base64url, exactly 19 chars, canonical-form-only decode. `AVATAR_PALETTES` is
  append-only (the byte is an index) and its colours are the user's own palette PNGs at the
  repo root — to change a colour, draw and re-extract, never retune a hex. Rendered as ONE
  traced union-outline path (`shared/src/avatarOutline.ts`).
- **Name charset** (`shared/src/name.ts`): alphanumerics + underscores, case kept, ≤16;
  accents FOLD (`Zoé→Zoe`), everything else → `_`; NFKD first, per code point; `sanitizeName`
  is idempotent and `isValidName` = "the sanitizer leaves it alone". The WEB sanitizes what it
  writes; the BACKEND REFUSES a non-conforming name (400). Empty is valid.
- Moderation best-effort on write: banned-strings name filter (`name_rejected`), exhaustive
  swastika template match (`avatar_rejected`). Symbolic; the friends graph is the containment.
- The copyable-key backup UI was removed (2026-08-19); #204's email link is the backup.
- **A RESULT SHARE WEARS ITS PLAYER'S FACE, AND CARRIES NO INVITE (decided 2026-09-05;
  made unconditional and invite-free 2026-09-10).** Both result screens sign every share
  with the device's account, `/s/<token>/<publicId>` (`shared/src/invite.ts` `sharePath`):
  the card wears the player's mark and name, the page title names them, the page is served
  at the invite's 300s TTL, and the click opens the shared day exactly as a plain link does
  — no landing, no ADD FRIEND. There is no control and no anonymous option (the AS drum
  under SHARE was retired 2026-09-10). The TOKEN is untouched (no codec change; the bot
  reads a signed share as a plain one and strips the id with the link). No account → the
  plain `/s/<token>`, content-addressed and year-cached. A deleted signer falls back to the
  PLAIN share (the score was never the part that went away). The signed card centres the
  strip, the gap and the result as ONE block (the result moves down; the plain card is
  untouched).

### Friends graph (#189)

- **MUTUAL edges from a one-click invite link; the graph is the leaderboard's trust
  boundary.** Link `<site>/i/<publicId>` — SERVER-rendered preview (mark + name + app name,
  cached 300s; `GET /og/i/<publicId>.png`) that `location.replace`s onto the SPA landing
  `/join/<publicId>`, whose ADD FRIEND tap records the edge (never the load). Paths live in
  `shared/src/invite.ts` (infra routes `/i/*` to the API origin, backend serves, web builds).
  A deleted sender's link expires (404).
- **`POST /friends`**: `{token}` reads, `{token, add}` links, `{token, remove}` unlinks;
  every answer `{ friends: [publicId] }`. Storage: one row per DIRECTION,
  `friends#<publicId>` / friend id, `createdAt` from the first link; both rows written (and
  deleted) in ONE transaction, on EVERY accepted link. **`FRIENDS_MAX` = 200**, checked on
  both sides, COUNTED off rows (a bound, not an invariant). Self-add → `self_link`; a gone
  target → `unknown_player`.

### Leaderboard reads (#190/#206)

- **`/board`** per `(day, lang, mode)`: `GET …[&id=]` = the GLOBAL top 50, anonymous
  (`id` widens with the caller's below-the-cut window; unbound to the caller, deliberately);
  `POST {token}` = the FRIENDS board, the trusted surface. Ranking rules are shared pure
  functions (`shared/src/leaderboard.ts`): competition tie ranks, the plain top-50 cut, the
  ±2 own-row window. Rows dressed with profiles (a missing or FAILED profile read dresses
  blank → assigned identity; a GONE account is dropped).
- **Three states on the friends board**: `waiting` (edge with neither a round nor a score;
  never the caller), **`playing`** (#206: a round for the CURRENT revision and no score row —
  exact `countTries` over the FULL artifact read fresh, stored `progress`, ordered by the shared
  `orderPlaying` with NO rank number; friends only, sentence only; a failed read fails the
  POST), finished. A round that ended without a score (capped, late, IP-refused) stays IN
  PROGRESS — accepted; the fourth state is #224. The caller's own playing row never defeats
  the empty-board ghost.
- Entry: the header's crown on every game surface (archive days included since 2026-08-31).

### The WhatsApp bot boundary (#236, decided 2026-09-03)

- **`packages/whatsapp-bot` lives inside the monorepo and OUTSIDE the game runtime.** It may
  import `@whippin/shared`; nothing imports it. A consumer of the PUBLIC share-token contract,
  never a source of game truth: no WhatsApp identity on an account, no share-encoding change
  for it, no LLM deciding a score or a rank.
- **Its stack is a sibling** (`WhippinBotStack`, `infra/lib/bot-stack.ts`): one Fargate task
  (`desiredCount 1`, stop-before-start — one Baileys session is a correctness rule), a
  bot-owned table, an SQS outbound queue, a podium Lambda with one schedule per group, alarms
  on a connected gauge. The model key is an SSM SecureString (`BOT_LLM_API_KEY_PARAMETER`).
  **Group configs are NOT committed** (a JID names a private conversation): SSM
  `/whippin/bot/groups/<slug>` via `pnpm bot:groups`, snapshotted into the gitignored
  `packages/whatsapp-bot/groups/local/`; `deploy-bot` pulls first, nothing reads SSM at run
  time — **editing SSM does not change production; a deploy promotes it.** The image is built
  from the REPO ROOT against the root `.dockerignore`, whose whitelist must name each
  re-included directory outright — **a new workspace package needs a line there too.**
- The podium ranking is the bot's own dense ordering, not `shared/src/leaderboard.ts`'s. It
  reads both share codecs but RECORDS only sentence results. Everything else: its `AGENTS.md`.

---

## Testing

- **WRITE tests when a change touches a CONTRACT**: slug/fold, the puzzle schemas, scoring
  and score accumulation, rank/collision logic, `reduce_embedding` filtering, date/`dayNumber`
  routing, the shared ranking/history/email rules. Assert against the SPEC in this file, not
  the implementation.
- **DON'T add tests for cosmetic/visual work**, trivial wiring or config.
- **A failing invariant test is a real regression — fix the CODE, never weaken the test.**
- **Run `pnpm test` before a contract-touching task is done**: Vitest (`shared`, `web`,
  `backend`, `infra`) + pytest (`generation`, `benchmark`, `curation`). Slug cases go in the ONE shared
  fixture, never on one side only.

## Working an issue

When asked to work/implement/do/resolve issue #N:

- **Read it first** (`gh issue view N`), then **implement the actual code** — never just
  change its GitHub status.
- **Respect every invariant in this file**; write tests per the policy above and run
  `pnpm test` when a contract is touched.
- **Branch + PR**: branch `issue-N-short-slug`, commit, push, `gh pr create` referencing the
  issue with `Refs #N` (not `Closes`, unless asked). Do **NOT** merge, close or replace the
  PR, and do **NOT** close the issue — the human decides.
- **No agent/tool branding** in branch names or PR titles. **Keep the PR description
  short**: what changed, how to verify, any AGENTS.md edits.

---

## Do NOT (repo-wide)

- **Don't fold/slug a displayed form, and don't display a slug.**
- **Don't let `slug()` and `fold()` diverge.**
- **Don't lemma-merge anywhere except `gen_phrase`'s merge walk (#104)** — consumers only
  LOOK UP alias keys; and **don't silently skip a missing lemma table** — error out
  (`--no-lemmas` to opt out explicitly).
- **Don't add a query parameter, a header the backend reads, or a route path without naming
  it in `infra/lib/backend-stack.ts` (and `shared/` when three packages read it).**
- **Don't add a second spelling of a shared reading** (scoring, ranking, streak, email,
  name, slug) in a consumer package — import it from `shared`.
- **Don't change what the server stores** (a field, a third party, a retention) without
  changing the privacy notice (`web/src/screens/privacyDoc.ts`).

Each package `AGENTS.md` carries its own Do-NOT list.

---

## Commands

**pnpm** (workspaces in `pnpm-workspace.yaml`, version pinned via `packageManager`). Root
scripts delegate via `pnpm --filter`. **Do NOT add a `--` separator** — pnpm forwards args
straight through, and a literal `--` breaks `gen_phrase.py`'s parsing.

```bash
pnpm install     # installs all workspaces
pnpm test        # invariant tests: Vitest (web + shared + backend + infra) + pytest (generation + benchmark)
pnpm typecheck   # tsc --noEmit
```

Domain commands — wordlist/reduce/gen (generation), bench (benchmark), curate/shelf:lyrics (curation),
publish/inventory/backend:dev (backend), dev/build (web), cdk synth/diff/deploy (infra),
bot:start/pair/cli/groups (whatsapp-bot) — are documented in the owning package's `AGENTS.md`.

---

## Current state / mutable

- **Package manager:** `pnpm@11.9.0`; `pnpm-workspace.yaml` uses `allowBuilds` to approve
  `esbuild`'s postinstall.
- **The PRIVACY NOTICE describes what this repo STORES (#229):** `/privacy`
  (`web/src/screens/privacyDoc.ts`), both languages, every category the backend keeps and why
  (account email, hashed device token + parsed user-agent, guess logs, scores, friends,
  profile, HMAC-of-IP rows, inbound mail for about 30 days, and the provider hosting the
  operator inbox — `PRIVACY_MAILBOX_PROVIDER`, read off `OPERATOR_EMAIL`'s host). Reachable
  from `/account` only. It is what the SES production-access review is pointed at.
- **CI/CD (#33)** — `.github/workflows/` (docs in its `README.md`). `ci.yml` on PRs into and
  pushes to `main`/`dev`: pnpm / Node 22 / uv + Python 3.12, `pnpm -r --if-present run
  typecheck` + `pnpm test` (intended as a required status check). `deploy.yml` on push to
  `main` and `workflow_dispatch` (`stacks`: `changed`|`web`|`backend`|`bot`|`all`): GitHub
  OIDC (`AWS_DEPLOY_ROLE_ARN`), deploys only the changed stack(s) via `dorny/paths-filter`
  (`shared`/`infra`/root deps fan out to all; `generation` deploys nothing). Web build reads
  `VITE_API_BASE_URL` from the committed `.env.production`, requires the public
  `VITE_TURNSTILE_SITE_KEY` variable (`vite.config.ts` rejects a production build without it),
  optional `VITE_PLAUSIBLE_DOMAIN`. The backend deploy needs `OPERATOR_EMAIL` and
  **invalidates `/*` on the API distribution** after `cdk deploy` (puzzle responses carry a
  year-long `s-maxage`; needs `cloudfront:CreateInvalidation` on the human-deployed
  `deploy-role-stack.ts` — `pnpm --filter @whippin/infra deploy:auth`). `deploy-bot` runs
  `pnpm bot:groups pull` first.
  - **`deploy.yml` is hardcoded and does NOT auto-cover changes.** When you add/rename a
    package or add/change a CDK stack, update its paths-filter mapping (libs consumed by a
    stack must fan out to it), the per-stack jobs and the `workflow_dispatch` options. A stack
    with no entry silently never deploys.

---

## ⚠ Discrepancies to confirm

None open. (Every discrepancy recorded before 2026-09-05 was resolved by a user decision and
folded into the sections above.)
