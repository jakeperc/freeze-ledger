"""Keccak against published vectors, and the registry's derived topics."""

from freeze_ledger import registry
from freeze_ledger.keccak import event_topic, keccak256_hex, to_checksum_address


def test_keccak_empty_string_vector():
    assert keccak256_hex(b"") == "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"


def test_erc20_transfer_topic_vector():
    # The ERC-20 Transfer topic is the most widely published Keccak-256 value in existence.
    assert event_topic("Transfer(address,address,uint256)") == (
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    )


def test_checksum_reproduces_issuer_published_casing():
    # Circle and Tether publish their contract addresses in EIP-55 form; our
    # checksum must reproduce them exactly from the lowercase hex.
    assert to_checksum_address("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") == "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    assert to_checksum_address("0xdac17f958d2ee523a2206206994597c13d831ec7") == "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    assert to_checksum_address("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") == "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def test_registry_topics_are_distinct_and_mapped():
    topics = {}
    for c in registry.EVM_CONTRACTS:
        for e in c.events:
            topics.setdefault(e.topic0, set()).add(e.action)
    # every topic maps to exactly one action
    assert all(len(v) == 1 for v in topics.values())
    # Tether's and Circle's signatures differ
    tether = {e.signature for e in registry.TETHER_EVENTS}
    circle = {e.signature for e in registry.CIRCLE_EVENTS}
    assert not tether & circle


def test_registry_describe_lists_every_source():
    for entry in registry.describe():
        assert entry["source"].startswith("http")
