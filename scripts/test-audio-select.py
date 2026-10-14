#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pure-logic regression tests for output-slot routing and availability.

No real device is opened and no audio is produced: `audio_out.probe` is replaced
by a fake, so these run headless. They guard the bugs that made an unplugged
headphone jack look usable, and the routing rules that keep the agent honest:

  1. PortAudio enumerates an unplugged jack, and names two jacks of one sound card
     identically apart from a role prefix ("耳机 (Realtek(R) Audio)" vs
     "扬声器 (Realtek(R) Audio)"). The Realtek headphone jack is even reported as
     "耳机 ()" — an EMPTY parenthetical.
  2. Availability must come from OPENING the endpoint, never from its name.
  3. `primary` -> `backup` fall back to each other, but a slot the user explicitly
     named must fail rather than silently speaking through another output.

Run: python scripts/test-audio-select.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

import audio_out  # noqa: E402

PASS = 0
FAIL = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}" + (f"  — {detail}" if detail else ""))


def dev(index: int, name: str, hostapi: str = "Windows WASAPI", **kw) -> dict:
    row = {"index": index, "name": name, "hostapi": hostapi, "outChannels": 2,
           "defaultSamplerate": 48000.0}
    row.update(kw)
    return row


# Two jacks on one card: identical adapter name, different role. This is exactly
# the shape that made "is the headphone active?" answerable only by opening it.
SPEAKER = "扬声器 (Realtek(R) Audio)"
HEADPHONE = "耳机 (Realtek(R) Audio)"
HEADPHONE_BARE = "耳机 ()"          # PortAudio's lossy WDM-KS label
ACTIVE_NO_PHONES = {"扬声器 (Realtek(R) Audio)", "扬声器 (ToDesk Virtual Audio)"}
ACTIVE_WITH_PHONES = ACTIVE_NO_PHONES | {HEADPHONE}


def fake_probe(working: set[str]):
    """Stand-in for audio_out.probe: a row is usable iff its NAME is in `working`.

    Mirrors the real contract while letting the tests state the scenario by name,
    which is what the bugs were about.
    """
    def probe(row: dict) -> bool:
        return str(row.get("name", "")) in working
    return probe


print("===== 1. reachability by name (cheap hint only) =====")
check("speakers active -> speaker reachable",
      audio_out._endpoint_is_active(SPEAKER, ACTIVE_NO_PHONES))
check("headphones NOT in active set -> not reachable",
      not audio_out._endpoint_is_active(HEADPHONE, ACTIVE_NO_PHONES))
check("bare '耳机 ()' must STILL not match an unrelated endpoint",
      not audio_out._endpoint_is_active(HEADPHONE_BARE, ACTIVE_NO_PHONES))
check("headphones active -> reachable",
      audio_out._endpoint_is_active(HEADPHONE, ACTIVE_WITH_PHONES))
check("empty active set -> nothing reachable",
      not audio_out._endpoint_is_active(SPEAKER, set()))

print("\n===== 2. the four slot names the agent may use =====")
for alias, expected in [("primary", "primary"), ("backup", "backup"),
                        ("speakers", "speakers"), ("headphones", "headphones"),
                        ("扬声器", "speakers"), ("耳机", "headphones"),
                        ("备用", "backup"), ("默认", "primary")]:
    check(f"slot_of({alias!r}) == {expected!r}", audio_out.slot_of(alias) == expected)
for nonsense in ("Realtek", "扬声器 (Realtek(R) Audio)", "3"):
    check(f"slot_of({nonsense!r}) is not a slot", audio_out.slot_of(nonsense) == "")
check("the chain is primary -> backup -> speakers -> headphones",
      audio_out.expand_chain({}) == ["primary", "backup", "speakers", "headphones"])

print("\n===== 3. availability is decided by OPENING, not by name =====")
original_probe = audio_out.probe
try:
    rows = [dev(34, SPEAKER), dev(33, HEADPHONE)]
    audio_out.probe = fake_probe({SPEAKER})

    # `speakers` bound to the speakers and `headphones` bound to the jack: while
    # the jack is dead the headphone slot must not resolve.
    bindings = {"primary": "speakers", "backup": "headphones",
                "speakers": SPEAKER, "headphones": HEADPHONE}
    check("headphone slot does not resolve while the jack is dead",
          audio_out.resolve_slot(rows, "headphones", bindings) is None)
    got = audio_out.resolve_slot(rows, "speakers", bindings)
    check("speaker slot resolves while it opens",
          got is not None and got["name"] == SPEAKER, str(got))

    # primary -> backup: primary dead, backup alive -> backup wins.
    dead_primary = {"primary": "headphones", "backup": "speakers",
                    "speakers": SPEAKER, "headphones": HEADPHONE}
    picked = audio_out.resolve_chain(rows, audio_out.expand_chain(dead_primary), dead_primary)
    check("primary unavailable -> falls back to backup",
          picked is not None and picked["used"] == "backup", str(picked))
    check("the fallback records what it skipped",
          picked is not None and picked["tried"] == ["primary"], str(picked))

    # Now both jacks are dead: nothing resolves, so the caller can give up.
    audio_out.probe = fake_probe(set())
    check("everything dead -> chain yields nothing",
          audio_out.resolve_chain(rows, audio_out.expand_chain(dead_primary), dead_primary) is None)
    check("everything dead -> no candidates for a slot",
          audio_out.port_candidates(rows, "headphones", bindings) == [])

    # The user plugs the headphones in: same names, only the open test changes.
    audio_out.probe = fake_probe({SPEAKER, HEADPHONE})
    got = audio_out.resolve_slot(rows, "headphones", bindings)
    check("headphone slot resolves once it opens",
          got is not None and got["name"] == HEADPHONE, str(got))
    # And a previously-skipped primary is honoured once it becomes reachable.
    picked = audio_out.resolve_chain(rows, audio_out.expand_chain(dead_primary), dead_primary)
    check("primary wins as soon as it is usable",
          picked is not None and picked["used"] == "primary", str(picked))

    print("\n===== 4. an unbound slot still resolves by kind =====")
    audio_out.probe = fake_probe({SPEAKER, HEADPHONE})
    empty = {"primary": "", "backup": "", "speakers": "", "headphones": ""}
    got = audio_out.resolve_slot(rows, "headphones", empty)
    check("unbound headphones slot finds a headset-like endpoint",
          got is not None and "耳机" in got["name"], str(got))
    got = audio_out.resolve_slot(rows, "speakers", empty)
    check("unbound speakers slot finds a loudspeaker-like endpoint",
          got is not None and "扬声器" in got["name"], str(got))
    got = audio_out.resolve_device(rows, None, empty)
    check("auto-pick never lands on a dead endpoint",
          got is not None and got["name"] == SPEAKER, str(got))

    print("\n===== 5. unknown name vs existing-but-dead must differ =====")
    rows2 = [dev(34, SPEAKER), dev(33, HEADPHONE, "Windows WDM-KS")]
    # The headphone jack is dead here, which is the whole point of the section:
    # the name matches but nothing behind it can be opened.
    audio_out.probe = fake_probe({SPEAKER})
    check("a name that matches nothing -> no candidates at all",
          audio_out.name_matches_candidates(rows2, "根本不存在的设备XYZ") == [])
    check("a name that matches a dead endpoint -> matched but not usable",
          len(audio_out.name_matches_candidates(rows2, "耳机")) == 1
          and audio_out.devices_for_spec(rows2, "耳机") == [])
finally:
    audio_out.probe = original_probe

print("\n===== 6. probe cache (the short-TTL re-check path) =====")
# Assert the cache structure rather than swapping probe_device out: the cache
# lives INSIDE probe_device, so replacing the function would bypass the thing
# being tested. A short TTL on failures is what lets a just-plugged jack be
# noticed quickly while a working endpoint is not re-opened on every call.
audio_out.clear_probe_cache()
check("clear_probe_cache empties the cache", audio_out._PROBE_CACHE == {})
check("a failed probe is re-tested sooner than a successful one",
      audio_out._PROBE_TTL_FAIL < audio_out._PROBE_TTL_OK,
      f"fail={audio_out._PROBE_TTL_FAIL}s ok={audio_out._PROBE_TTL_OK}s")
key = (4242, "test")
audio_out._PROBE_CACHE[key] = (0.0, False)          # recorded long ago
age = time.time() - audio_out._PROBE_CACHE[key][0]
check("a stale failure entry is treated as expired",
      age >= audio_out._PROBE_TTL_FAIL, f"age={age:.1f}s")
audio_out.clear_probe_cache()
check("cache is empty again after clearing", not audio_out._PROBE_CACHE)

print(f"\nPASS: {PASS}   FAIL: {FAIL}")
print("RESULT: " + ("ALL CHECKS PASSED" if FAIL == 0 else "FAILED"))
sys.exit(1 if FAIL else 0)
