# -*- coding: utf-8 -*-
"""Read and set the Windows endpoint volume/mute of one output device.

Tree debugging for "the agent rendered audio but nobody heard it": a render
stream can complete while the endpoint itself is muted or at 0 %, which is
invisible from PortAudio's point of view.

Implements the documented Core Audio COM interfaces with ctypes (no extra
dependency): IMMDeviceEnumerator -> IMMDevice -> IAudioEndpointVolume.
"""

from __future__ import annotations

import ctypes
import json
import sys
from ctypes import POINTER, byref, c_float, c_int, c_uint, c_void_p, c_wchar_p, WINFUNCTYPE

ole32 = ctypes.oledll.ole32

CLSID_MMDeviceEnumerator = "{BCDE0395-E52F-467C-8E3D-C4579291692E}"
IID_IMMDeviceEnumerator = "{A95664D2-9614-4F35-A746-DE8DB63617E6}"
IID_IAudioEndpointVolume = "{5CDF2C82-841E-4546-9722-0CF74078229A}"
PKEY_Device_FriendlyName = ("{a45c254e-df1c-4efd-8020-67d146a850e0}", 14)


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    def __init__(self, text: str = "") -> None:
        super().__init__()
        if text:
            ole32.CLSIDFromString(c_wchar_p(text), byref(self))


class PropertyKey(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", ctypes.c_ulong)]


class PropVariant(ctypes.Structure):
    # x64: vt(2) + 6 reserved, then the union at offset 8.
    _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort),
                ("r2", ctypes.c_ulong), ("ptr", c_void_p), ("pad", ctypes.c_ulonglong)]


class GUID2(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


def vcall(ptr, index: int, *argtypes):
    """Call COM vtable slot `index` (0..2 = IUnknown) on interface `ptr`."""
    vtbl = ctypes.cast(ptr, POINTER(POINTER(c_void_p)))[0]
    proto = WINFUNCTYPE(ctypes.c_long, c_void_p, *argtypes)
    fn = proto(vtbl[index])
    return lambda *args: fn(ptr, *args)


def release(ptr) -> None:
    try:
        vcall(ptr, 2)()
    except Exception:  # noqa: BLE001
        pass


def _enumerator():
    enum = c_void_p()
    hr = ole32.CoCreateInstance(byref(GUID(CLSID_MMDeviceEnumerator)), None, 1,
                                byref(GUID(IID_IMMDeviceEnumerator)), byref(enum))
    if hr != 0:
        raise OSError("CoCreateInstance(MMDeviceEnumerator) hr=%#x" % hr)
    return enum


def _friendly_name(dev) -> str:
    store = c_void_p()
    if vcall(dev, 4, c_int, POINTER(c_void_p))(0, byref(store)) != 0:
        return ""
    key = PropertyKey()
    key.fmtid = GUID(PKEY_Device_FriendlyName[0])
    key.pid = PKEY_Device_FriendlyName[1]
    pv = PropVariant()
    name = ""
    if vcall(store, 5, POINTER(PropertyKey), POINTER(PropVariant))(byref(key), byref(pv)) == 0 and pv.ptr:
        name = ctypes.wstring_at(pv.ptr)
        ole32.PropVariantClear(byref(pv))
    release(store)
    return name


def render_devices() -> list[tuple[int, c_void_p, str]]:
    enum = _enumerator()
    coll = c_void_p()
    # EnumAudioEndpoints(eRender=0, DEVICE_STATE_ACTIVE=1)
    hr = vcall(enum, 3, c_int, c_uint, POINTER(c_void_p))(0, 1, byref(coll))
    if hr != 0:
        raise OSError("EnumAudioEndpoints hr=%#x" % hr)
    count = c_uint()
    vcall(coll, 3, POINTER(c_uint))(byref(count))
    out: list[tuple[int, c_void_p, str]] = []
    for i in range(count.value):
        dev = c_void_p()
        if vcall(coll, 4, c_uint, POINTER(c_void_p))(i, byref(dev)) == 0:
            out.append((i, dev, _friendly_name(dev)))
    release(coll)
    release(enum)
    return out


class EndpointVolume:
    """IAudioEndpointVolume wrapper."""

    def __init__(self, dev) -> None:
        ptr = c_void_p()
        hr = vcall(dev, 3, POINTER(GUID), c_uint, c_void_p, POINTER(c_void_p))(
            byref(GUID(IID_IAudioEndpointVolume)), 1, None, byref(ptr))
        if hr != 0:
            raise OSError("Activate(IAudioEndpointVolume) hr=%#x" % hr)
        self.ptr = ptr

    def scalar(self) -> float:
        value = c_float()
        if vcall(self.ptr, 9, POINTER(c_float))(byref(value)) != 0:
            raise OSError("GetMasterVolumeLevelScalar failed")
        return float(value.value)

    def set_scalar(self, level: float) -> None:
        # vtable slot 7 is SetMasterVolumeLevelScalar; slot 6 is
        # SetMasterVolumeLevel and slot 8/9 are the Get readers. Using the
        # reader's index (9) here faults with an access violation.
        hr = vcall(self.ptr, 7, c_float, c_void_p)(c_float(level), c_void_p(None))
        if hr != 0:
            raise OSError("SetMasterVolumeLevelScalar hr=%#x" % hr)

    def muted(self) -> bool:
        flag = c_int()
        if vcall(self.ptr, 15, POINTER(c_int))(byref(flag)) != 0:
            raise OSError("GetMute failed")
        return bool(flag.value)

    def set_mute(self, muted: bool) -> None:
        # S_FALSE (0x1) means "already in the requested state" — not an error.
        hr = vcall(self.ptr, 14, c_int, c_void_p)(1 if muted else 0, c_void_p(None))
        if hr not in (0, 1):
            raise OSError("SetMute hr=%#x" % hr)

    def close(self) -> None:
        release(self.ptr)


def report() -> list[dict]:
    rows = []
    for index, dev, name in render_devices():
        row = {"index": index, "name": name}
        try:
            volume = EndpointVolume(dev)
            row["volume"] = round(volume.scalar(), 4)
            row["muted"] = volume.muted()
            volume.close()
        except Exception as exc:  # noqa: BLE001
            row["error"] = str(exc)
        rows.append(row)
    return rows


def main() -> int:
    ole32.CoInitialize(None)
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "set":
            needle = sys.argv[2]
            level = float(sys.argv[3])
            changed = []
            for index, dev, name in render_devices():
                if needle.lower() in name.lower():
                    volume = EndpointVolume(dev)
                    volume.set_mute(False)
                    volume.set_scalar(level)
                    # Read back through the same interface to prove it stuck.
                    changed.append({
                        "name": name,
                        "volume": round(volume.scalar(), 4),
                        "muted": volume.muted(),
                    })
                    volume.close()
            print(json.dumps({"ok": bool(changed), "changed": changed},
                             ensure_ascii=False, indent=1))
            return 0 if changed else 1
        print(json.dumps({"ok": True, "devices": report()}, ensure_ascii=False, indent=1))
        return 0
    finally:
        ole32.CoUninitialize()


if __name__ == "__main__":
    sys.exit(main())
