"""The judge's sentence pre-filter and shortlist order (#308, 2026-09-20): a filter
only removes, the survivors are ordered by image, the model reads the best."""

import curate


class FakeJudge:
    def __init__(self, table):
        self.table = table
        self.usage = {"input_tokens": 0, "output_tokens": 0}

    def noul(self, state, questions):
        out = {}
        for key, (instructions, _t, _f) in questions.items():
            i = int(instructions.split("phrases[")[1].split("]")[0])
            name = key.rstrip("0123456789")
            out[key] = self.table[state["phrases"][i]][name]
        return out


class Log(list):
    def __call__(self, line):
        self.append(line)


def test_judge_sentences_removes_the_failing_and_orders_the_rest_by_image():
    table = {
        "flat": {"autonome": 0.9, "image": 0.1, "celebre": 0.0},
        "dependent": {"autonome": 0.2, "image": 0.9, "celebre": 0.0},
        "famous": {"autonome": 0.9, "image": 0.9, "celebre": 0.8},
        "good": {"autonome": 0.6, "image": 0.7, "celebre": 0.1},
        "better": {"autonome": 0.5, "image": 0.9, "celebre": 0.1},
    }
    log = Log()
    kept = curate.judge_sentences(log, list(table), judge=FakeJudge(table))
    assert kept == ["better", "good"]
    assert any("2 of 5" in line for line in log)


def test_shortlist_reads_the_best_not_a_sample(monkeypatch):
    monkeypatch.setattr(curate, "MAX_SENTENCES", 2)
    seen = []
    monkeypatch.setattr(curate.llm, "pick_from_chunk", lambda _c, chunk, _n: seen.extend(chunk) or [])
    monkeypatch.setattr(curate.llm, "rank_sentences", lambda _c, picks, _n: picks)
    log = Log()
    curate.shortlist(object(), log, ["a", "b", "c"], set())
    assert seen == ["a", "b"] and any("best by image" in line for line in log)


def test_an_empty_list_asks_the_judge_nothing():
    assert curate.judge_sentences(Log(), [], judge=None) == []


def test_a_rerun_replays_the_previous_sidecar_instead_of_paying_the_judge(monkeypatch):
    seen = []
    monkeypatch.setattr(curate.subprocess, "run", lambda cmd, **_k: seen.append(cmd) or type("C", (), {"returncode": 1, "stdout": "", "stderr": ""})())
    curate.run_gen_phrase("une phrase", ["a", "b", "c"], {}, {}, "fr", {"a": "x"},
                          replay=curate._sidecar("/out/x_y_z.json"))
    assert "--contextual-replay" in seen[0]
    assert seen[0][seen[0].index("--contextual-replay") + 1] == "/out/x_y_z.contextual.json"
    curate.run_gen_phrase("une phrase", ["a", "b", "c"], {}, {}, "fr")
    assert "--contextual-replay" not in seen[1]
