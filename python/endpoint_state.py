# -*- coding: utf-8 -*-
"""List Core Audio render endpoints that are DEVICE_STATE_ACTIVE.

This is the authoritative "is this output actually reachable" list. Windows
reports a physically disconnected jack as inactive, whereas PortAudio's own
enumeration happily lists WDM-KS/DirectSound entries for jacks that are not
plugged in — which is exactly how a pre-flight check can pass on a headphone
endpoint with no headphones attached.

Output: JSON, one object per endpoint, plus a flat `activeNames` list for quick
membership tests.
"""
from __future__ import annotations

import ctypes
import json
import sys
from ctypes import POINTER, byref, c_int, c_uint, c_void_p, c_wchar_p, WINFUNCTYPE

ole32 = ctypes.oledll.ole32
CLSID_MMDeviceEnumerator = "{BCDE0395-E52F-467C-8E3D-C4579291692E}"
IID_IMMDeviceEnumerator = "{A95664D2-9614-4F35-A746-DE8DB63617E6}"
PKEY_FRIENDLY = ("{a45c254e-df1c-4efd-8020-67d146a850e0}", 14)
DEVICE_STATE_ACTIVE = 1


class GUID(ctypes.Structure):
    _fields_ = [("D1", ctypes.c_ulong), ("D2", ctypes.c_ushort),
                ("D3", ctypes.c_ushort), ("D4", ctypes.c_ubyte * 8)]

    def __init__(self, s=""):
        super().__init__()
        if s:
            ole32.CLSIDFromString(c_wchar_p(s), byref(self))


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", ctypes.c_ulong)]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort),
                ("r2", ctypes.c_ulong), ("ptr", c_void_p), ("pad", ctypes.c_ulonglong)]


def vc(ptr, idx, *at):
    vt = ctypes.cast(ptr, POINTER(POINTER(c_void_p)))[0]
    fn = WINFUNCTYPE(ctypes.c_long, c_void_p, *at)(vt[idx])
    return lambda *a: fn(ptr, *a)


def active_render_endpoints() -> list[dict]:
    """[{name, id}] for every render endpoint Windows currently considers active."""
    ole32.CoInitialize(None)
    out: list[dict] = []
    try:
        enum = c_void_p()
        hr = ole32.CoCreateInstance(byref(GUID(CLSID_MMDeviceEnumerator)), None, 1,
                                    byref(GUID(IID_IMMDeviceEnumerator)), byref(enum))
        if hr != 0:
            return out
        coll = c_void_p()
        hr = vc(enum, 3, c_int, c_uint, POINTER(c_void_p))(0, DEVICE_STATE_ACTIVE, byref(coll))
        if hr != 0:
            vc(enum, 2)
            return out
        n = c_uint()
        vc(coll, 3, POINTER(c_uint))(byref(n))
        for i in range(n.value):
            dev = c_void_p()
            if vc(coll, 4, c_uint, POINTER(c_void_p))(i, byref(dev)) != 0:
                continue
            dev_id = c_wchar_p()
            vc(dev, 5, POINTER(c_wchar_p))(byref(dev_id))
            store = c_void_p()
            name = ""
            if vc(dev, 4, c_int, POINTER(c_void_p))(0, byref(store)) == 0:
                pk = PROPERTYKEY()
                pk.fmtid = GUID(PKEY_FRIENDLY[0])
                pk.pid = PKEY_FRIENDLY[1]
                pv = PROPVARIANT()
                if vc(store, 5, POINTER(PROPERTYKEY), POINTER(PROPVARIANT))(byref(pk), byref(pv)) == 0 and pv.ptr:
                    name = ctypes.wstring_at(pv.ptr)
                    ole32.PropVariantClear(byref(pv))
                vc(store, 2)
            out.append({"name": name or "", "id": dev_id.value or ""})
        vc(coll, 2)
        vc(enum, 2)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
    finally:
        ole32.CoUninitialize()
    return out


def main() -> int:
    rows = active_render_endpoints()
    print(json.dumps({
        "count": len(rows),
        "activeNames": [r["name"] for r in rows],
        "endpoints": rows,
    }, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
