"""Address normalization. One canonical form per chain, so joins are exact.

- EVM (Ethereum, Base): lowercase 0x-prefixed hex, 40 digits.
- Tron: Base58Check (the "T..." form); hex input of either 40 or 42 digits is
  converted.
- Solana: Base58 as given (case-sensitive by definition).
"""

from __future__ import annotations

import hashlib

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58)}
TRON_PREFIX = 0x41


def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = []
    while n > 0:
        n, r = divmod(n, 58)
        out.append(_B58[r])
    pad = 0
    for b in raw:
        if b == 0:
            pad += 1
        else:
            break
    return "1" * pad + "".join(reversed(out))


def b58decode(s: str) -> bytes:
    n = 0
    for ch in s:
        if ch not in _B58_INDEX:
            raise ValueError(f"invalid base58 character {ch!r}")
        n = n * 58 + _B58_INDEX[ch]
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + body


def _checksum(payload: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]


def b58check_encode(payload: bytes) -> str:
    return b58encode(payload + _checksum(payload))


def b58check_decode(s: str) -> bytes:
    raw = b58decode(s)
    payload, check = raw[:-4], raw[-4:]
    if _checksum(payload) != check:
        raise ValueError("base58check checksum mismatch")
    return payload


def evm(address: str) -> str:
    a = address.strip().lower()
    if a.startswith("0x"):
        a = a[2:]
    if len(a) == 64:  # a 32-byte ABI word
        a = a[-40:]
    if len(a) != 40 or any(c not in "0123456789abcdef" for c in a):
        raise ValueError(f"not an EVM address: {address!r}")
    return "0x" + a


def tron_from_hex(hexstr: str) -> str:
    h = hexstr.strip().lower()
    if h.startswith("0x"):
        h = h[2:]
    if len(h) == 64:
        h = h[-40:]
    if len(h) == 40:
        h = "41" + h
    if len(h) != 42 or not h.startswith("41"):
        raise ValueError(f"not a Tron hex address: {hexstr!r}")
    return b58check_encode(bytes.fromhex(h))


def tron_to_hex(address: str) -> str:
    payload = b58check_decode(address)
    if len(payload) != 21 or payload[0] != TRON_PREFIX:
        raise ValueError(f"not a Tron address: {address!r}")
    return payload.hex()


def tron(address: str) -> str:
    """Canonical Base58Check form from either a T-address or hex."""
    a = address.strip()
    if a.startswith("T") and len(a) == 34:
        b58check_decode(a)  # validates the checksum
        return a
    return tron_from_hex(a)


def solana(address: str) -> str:
    a = address.strip()
    raw = b58decode(a)
    if len(raw) != 32:
        raise ValueError(f"not a Solana public key: {address!r}")
    return a


def for_chain(chain: str, address: str) -> str:
    if chain in ("ethereum", "base"):
        return evm(address)
    if chain == "tron":
        return tron(address)
    if chain == "solana":
        return solana(address)
    raise ValueError(f"unknown chain {chain}")
