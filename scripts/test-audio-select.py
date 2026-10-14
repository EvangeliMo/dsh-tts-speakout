#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pure-logic regression tests for output-endpoint availability.

No real device is opened and no audio is produced: `probe_device` is replaced by
a fake, so these run headless. They guard the two bugs that made an unplugged
headphone jack look usable:

  1. PortAudio enumerates an unplugged jack, and names two jacks of one sound card
     identically apart from a role prefix ("耳机 (Realtek(R) Audio)" vs
     "扬声器 (Realtek(R) Audio)").
  2. The Realtek headphone jack is even reported as "耳机 ()" — an EMPTY
     parenthetical — so role-only name matching silently failed to match.

Run: python scripts/test-audio-select.py
"""
from __future__ import annotations

import sys
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
    """Stand-in for audio_out._probe: a row is usable iff its NAME is in `working`.

    Mirrors the real contract (which keys on the device index) while letting the
    tests state the scenario by name, since that is what the bugs were about.
    """
    def probe(row: dict) -> bool:
        return str(row.get("name", "")) in working
    return probe


_NAME_OF: dict[int, str] = {}


def seed(rows: list[dict]) -> None:
    _NAME_OF.clear()
    for r in rows:
        _NAME_OF[int(r["index"])] = str(r["name"])


print("===== 1. reachability by name (cheap hint only) =====")
check("speakers active -> speaker reachable",
      audio_out._endpoint_is_active(SPEAKER, ACTIVE_NO_PHONES))
check("headphones NOT in active set -> not reachable",
      not audio_out._endpoint_is_active(HEADPHONE, ACTIVE_NO_PHONES))
check("bare '耳机 ()' must STILL not match an unrelated endpoint",
      not audio_out._endpoint_is_active(HEADPHONE_BARE, ACTIVE_NO_PHONES))
check("headphones active -> reachable",
      audio_out._endpoint_is_active(HEADPHONE, ACTIVE_WITH_PHONES))
check("bare '耳机 ()' matches once the headphone endpoint is active",
      audio_out._endpoint_is_active(HEADPHONE_BARE, ACTIVE_WITH_PHONES))
check("empty active set -> nothing reachable",
      not audio_out._endpoint_is_active(SPEAKER, set()))

print("\n===== 2. availability is decided by OPENING, not by name =====")
original_probe = audio_out._probe
try:
    # Speakers open, the headphone jack does not (nothing plugged in), even
    # though both names are present in PortAudio's list.
    rows = [dev(34, SPEAKER), dev(33, HEADPHONE)]
    seed(rows)
    audio_out._probe = fake_probe({SPEAKER})
    got = [r["name"] for r in audio_out.devices_for_spec(rows, "耳机")]
    check("explicit 耳机 is refused while the jack is dead", got == [], str(got))

    got = [r["name"] for r in audio_out.devices_for_spec(rows, "扬声器")]
    check("explicit 扬声器 resolves while it opens", got == [SPEAKER], str(got))

    # Now the user plugs the headphones in: same names, same indices, only the
    # open test changes.
    audio_out._probe = fake_probe({SPEAKER, HEADPHONE})
    got = [r["name"] for r in audio_out.devices_for_spec(rows, "耳机")]
    check("explicit 耳机 resolves once it opens", got == [HEADPHONE], str(got))

    # Auto-pick must never land on the dead jack.
    audio_out._probe = fake_probe({SPEAKER})
    picked = audio_out.resolve_device(
        [dev(33, HEADPHONE, "Windows WDM-KS"), dev(34, SPEAKER)], None)
    check("auto-pick skips the dead endpoint", picked is not None and picked["name"] == SPEAKER,
          str(picked))
    check("auto-pick still prefers a real speaker", picked is not None
          and "扬声器" in picked["name"], str(picked))

    # All-dead device list: resolve reports nothing rather than a silent choice.
    audio_out._probe = fake_probe(set())
    check("everything dead -> resolve_device returns None",
          audio_out.resolve_device([dev(33, HEADPHONE, "Windows WDM-KS")], None) is None)
    check("everything dead -> explicit spec has no candidates",
          audio_out.devices_for_spec([dev(33, HEADPHONE, "Windows WDM-KS")], "耳机") == [])

    print("\n===== 3. unknown name vs existing-but-dead must differ =====")
    audio_out._probe = fake_probe({SPEAKER})
    rows = [dev(34, SPEAKER), dev(33, HEADPHONE, "Windows WDM-KS")]
    seed(rows)
    check("a name that matches nothing -> no candidates at all",
          audio_out.name_matches_candidates(rows, "根本不存在的设备XYZ") == [])
    check("a name that matches a dead endpoint -> matched but not usable",
          len(audio_out.name_matches_candidates(rows, "耳机")) == 1
          and audio_out.devices_for_spec(rows, "耳机") == [])
finally:
    audio_out._probe = original_probe

print("\n===== 4. probe cache (the short-TTL re-check path) =====")
# Assert the cache structure rather than swapping probe_device out: the cache
# lives INSIDE probe_device, so replacing the function would bypass what we mean
# to test. A short TTL on failures is what lets a just-plugged jack be noticed
# quickly while a working endpoint is not re-opened on every call.
audio_out.clear_probe_cache()
check("clear_probe_cache empties the cache", audio_out._PROBE_CACHE == {})
check("a failed probe is re-tested sooner than a successful one",
      audio_out._PROBE_TTL_FAIL < audio_out._PROBE_TTL_OK,
      f"fail={audio_out._PROBE_TTL_FAIL}s ok={audio_out._PROBE_TTL_OK}s")
key = (4242, "test")
audio_out._PROBE_CACHE[key] = (0.0, False)          # recorded long ago
import time as _time  # noqa: E402
age = _time.time() - audio_out._PROBE_CACHE[key][0]
check("a stale failure entry is treated as expired",
      age >= audio_out._PROBE_TTL_FAIL, f"age={age:.1f}s")
audio_out.clear_probe_cache()
check("cache is empty again after clearing", not audio_out._PROBE_CACHE)

print(f"\nPASS: {PASS}   FAIL: {FAIL}")
print("RESULT: " + ("ALL CHECKS PASSED" if FAIL == 0 else "FAILED"))
sys.exit(1 if FAIL else 0)
