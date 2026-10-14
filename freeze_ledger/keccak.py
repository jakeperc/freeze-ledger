"""Pure-Python Keccak-256 (the pre-NIST padding Ethereum uses).

Used only to compute event topic hashes from their ABI signatures and EIP-55
checksums, so the indexer carries no cryptography dependency. Verified in
tests against the published test vectors (empty string, Transfer topic).
"""

from __future__ import annotations

_MASK = (1 << 64) - 1
_RATE = 136  # bytes, for a 256-bit output

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]

# Rotation offsets r[x][y]
_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]


def _rol(v: int, n: int) -> int:
    n %= 64
    if n == 0:
        return v
    return ((v << n) | (v >> (64 - n))) & _MASK


def _keccak_f(a: list[list[int]]) -> list[list[int]]:
    for rc in _RC:
        # theta
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        # rho + pi
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        # chi
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & _MASK & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        # iota
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    """Return the 32-byte Keccak-256 digest of `data`."""
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % _RATE:
        padded.append(0x00)
    padded[-1] |= 0x80

    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(padded), _RATE):
        block = padded[off : off + _RATE]
        for i in range(_RATE // 8):
            lane = int.from_bytes(block[8 * i : 8 * i + 8], "little")
            a[i % 5][i // 5] ^= lane
        a = _keccak_f(a)

    out = bytearray()
    for i in range(4):
        out += a[i % 5][i // 5].to_bytes(8, "little")
    return bytes(out)


def keccak256_hex(data: bytes) -> str:
    return "0x" + keccak256(data).hex()


def event_topic(signature: str) -> str:
    """`AddedBlackList(address)` -> its topic0, as a 0x-prefixed hex string."""
    return keccak256_hex(signature.encode("ascii"))


def to_checksum_address(address: str) -> str:
    """EIP-55 checksum form of a 20-byte hex address."""
    addr = address.lower().replace("0x", "")
    if len(addr) != 40:
        raise ValueError(f"not a 20-byte hex address: {address}")
    digest = keccak256(addr.encode("ascii")).hex()
    return "0x" + "".join(
        ch.upper() if int(digest[i], 16) >= 8 else ch for i, ch in enumerate(addr)
    )
