#!/usr/bin/env python3
"""Print the CodeArts Agent login session as JSON.

Used by `dsh-codearts-connect login` and as the plugin's last-resort session
import. Reads the CodeArts Electron SecretStorage entry `HuaweiCloudSession`
(Windows DPAPI + Chromium OSCrypt) and prints only the fields the plugin needs.
"""

import base64
import ctypes
import ctypes.wintypes
import json
import os
import sqlite3
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def unprotect(data: bytes) -> bytes:
    blob_in = DATA_BLOB(
        len(data),
        ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_char)),
    )
    blob_out = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    )
    if not ok:
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def main() -> int:
    appdata = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    local_state_path = os.path.join(appdata, "codearts-agent", "Local State")
    state_db = os.path.join(appdata, "codearts-agent", "User", "globalStorage", "state.vscdb")
    if not os.path.exists(local_state_path) or not os.path.exists(state_db):
        print("CodeArts Agent state not found", file=sys.stderr)
        return 2

    local = json.loads(open(local_state_path, encoding="utf-8").read())
    encrypted_key = base64.b64decode(local["os_crypt"]["encrypted_key"])[5:]
    aes_key = unprotect(encrypted_key)

    con = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=5)
    try:
        row = con.execute(
            "select value from ItemTable where key like 'secret://%HuaweiCloudSession%'"
        ).fetchone()
    finally:
        con.close()
    if not row:
        print("CodeArts Agent is not signed in", file=sys.stderr)
        return 3

    blob = bytes(json.loads(row[0])["data"])
    if not blob.startswith(b"v10"):
        print("unsupported SecretStorage blob version", file=sys.stderr)
        return 4
    session = json.loads(AESGCM(aes_key).decrypt(blob[3:15], blob[15:], None))

    context = session.get("loginContext") or {}
    dpop = context.get("dpopKeyPair") or {}
    result = {
        "account_id": (session.get("account") or {}).get("id", ""),
        "refresh_token": session.get("refresh_token", ""),
        "code_verifier": (context.get("pkcePair") or {}).get("codeVerifier", ""),
        "dpop": {
            "privateKeyJwk": dpop.get("privateKeyJwk"),
            "publicKeyJwk": dpop.get("publicKeyJwk"),
        },
        "credentials": {
            "access_key_id": session.get("accessKey", ""),
            "secret_access_key": session.get("secretKey", ""),
            "security_token": session.get("securitytoken", ""),
            "expiration": session.get("expires_at", ""),
        },
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
