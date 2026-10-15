"""The only place an address, event signature or endpoint is written down.

Every entry links to the issuer or protocol page it was copied from, so the
registry is itself a receipt. Nothing else in the package hard-codes a
contract, a mint, a topic hash or a URL.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .keccak import event_topic


@dataclass(frozen=True)
class EventSpec:
    """One ABI event: name, parameter types, which parameters are indexed, and
    the action it maps to in the ledger."""

    name: str
    params: tuple[tuple[str, str, bool], ...]  # (param name, solidity type, indexed)
    action: str  # freeze | unfreeze | destroy

    @property
    def signature(self) -> str:
        return f"{self.name}({','.join(t for _, t, _ in self.params)})"

    @property
    def topic0(self) -> str:
        return event_topic(self.signature)


@dataclass(frozen=True)
class EvmContract:
    chain: str
    issuer: str
    token: str
    address: str  # EIP-55 as published by the issuer
    events: tuple[EventSpec, ...]
    source: str  # where the address was copied from


@dataclass(frozen=True)
class TronContract:
    chain: str
    issuer: str
    token: str
    address: str  # Base58
    events: tuple[EventSpec, ...]
    source: str


@dataclass(frozen=True)
class SolanaMint:
    chain: str
    issuer: str
    token: str
    mint: str  # Base58 mint address
    source: str
    # The freeze authority is read from the mint account on every run and
    # logged; it is deliberately not written here.


# --- Tether's contract: Solidity 0.4.x, no indexed event parameters -------------
# Source for the ABI: the verified contract at
# https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7#code
TETHER_EVENTS: tuple[EventSpec, ...] = (
    EventSpec("AddedBlackList", (("_user", "address", False),), "freeze"),
    EventSpec("RemovedBlackList", (("_user", "address", False),), "unfreeze"),
    EventSpec(
        "DestroyedBlackFunds",
        (("_blackListedUser", "address", False), ("_balance", "uint256", False)),
        "destroy",
    ),
)

# --- Circle's FiatToken: the account is an indexed parameter -------------------
# Source for the ABI: https://github.com/circlefin/stablecoin-evm (Blacklistable.sol)
CIRCLE_EVENTS: tuple[EventSpec, ...] = (
    EventSpec("Blacklisted", (("_account", "address", True),), "freeze"),
    EventSpec("UnBlacklisted", (("_account", "address", True),), "unfreeze"),
)

EVM_CONTRACTS: tuple[EvmContract, ...] = (
    EvmContract(
        chain="ethereum",
        issuer="tether",
        token="USDT",
        address="0xdAC17F958D2ee523a2206206994597C13D831ec7",
        events=TETHER_EVENTS,
        source="https://tether.to/en/transparency/ (Ethereum ERC-20 contract) and "
        "https://etherscan.io/token/0xdAC17F958D2ee523a2206206994597C13D831ec7",
    ),
    EvmContract(
        chain="ethereum",
        issuer="circle",
        token="USDC",
        address="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        events=CIRCLE_EVENTS,
        source="https://developers.circle.com/stablecoins/usdc-contract-addresses",
    ),
    EvmContract(
        chain="base",
        issuer="circle",
        token="USDC",
        address="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        events=CIRCLE_EVENTS,
        source="https://developers.circle.com/stablecoins/usdc-contract-addresses",
    ),
)

TRON_CONTRACTS: tuple[TronContract, ...] = (
    TronContract(
        chain="tron",
        issuer="tether",
        token="USDT",
        address="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        events=TETHER_EVENTS,
        source="https://tether.to/en/transparency/ (Tron TRC-20 contract) and "
        "https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    ),
)

SOLANA_MINTS: tuple[SolanaMint, ...] = (
    SolanaMint(
        chain="solana",
        issuer="circle",
        token="USDC",
        mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        source="https://developers.circle.com/stablecoins/usdc-contract-addresses",
    ),
    SolanaMint(
        chain="solana",
        issuer="tether",
        token="USDT",
        mint="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        source="https://tether.to/en/transparency/ (Solana SPL mint)",
    ),
)

# --- Endpoints -------------------------------------------------------------------
# Public, keyless endpoints first so a stranger can reproduce a run. Override
# with environment variables; a comma-separated list gives fallbacks and the
# verification suite uses a *different* endpoint from the one that indexed.

DEFAULT_RPCS: dict[str, tuple[str, ...]] = {
    # mevblocker and drpc still serve pre-merge receipts and logs, which
    # verify.py needs for 2017-2022 rows; most public nodes have expired them.
    "ethereum": (
        "https://ethereum-rpc.publicnode.com",
        "https://rpc.mevblocker.io",
        "https://eth.drpc.org",
        "https://eth.llamarpc.com",
    ),
    "base": (
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
    ),
    "solana": (
        "https://api.mainnet-beta.solana.com",
        "https://solana-rpc.publicnode.com",
    ),
}

TRONGRID_BASE = "https://api.trongrid.io"

ENV_RPC = {"ethereum": "FL_ETH_RPC", "base": "FL_BASE_RPC", "solana": "FL_SOL_RPC"}
ENV_TRON_KEY = "FL_TRON_API_KEY"

# Reorg margin re-read on every incremental run, per chain.
REORG_MARGIN = {"ethereum": 64, "base": 64, "tron": 100, "solana": 150}

# Attribution sources
SDN_ADVANCED_XML = "https://www.treasury.gov/ofac/downloads/sanctions/1.0/sdn_advanced.xml"
B10C_LISTS = {
    # Nightly extracts of the SDN digital-currency addresses, used as a cross-check only.
    "ETH": "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json",
    "USDT": "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_USDT.json",
    "TRX": "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_TRX.json",
}
FEDERAL_REGISTER_API = "https://www.federalregister.gov/api/v1/documents.json"


def rpc_urls(chain: str) -> list[str]:
    env = os.environ.get(ENV_RPC.get(chain, ""), "")
    if env.strip():
        return [u.strip() for u in env.split(",") if u.strip()]
    return list(DEFAULT_RPCS[chain])


def tron_api_key() -> str | None:
    key = os.environ.get(ENV_TRON_KEY, "").strip()
    return key or None


def all_chains() -> list[str]:
    return ["ethereum", "base", "tron", "solana"]


def describe() -> list[dict]:
    """Flat listing of every contract and mint with its events, for `status`
    and for METHODOLOGY cross-checks."""
    out: list[dict] = []
    for c in EVM_CONTRACTS:
        out.append(
            {
                "chain": c.chain,
                "issuer": c.issuer,
                "token": c.token,
                "address": c.address,
                "events": {e.signature: {"topic0": e.topic0, "action": e.action} for e in c.events},
                "source": c.source,
            }
        )
    for c in TRON_CONTRACTS:
        out.append(
            {
                "chain": c.chain,
                "issuer": c.issuer,
                "token": c.token,
                "address": c.address,
                "events": {e.signature: {"action": e.action} for e in c.events},
                "source": c.source,
            }
        )
    for m in SOLANA_MINTS:
        out.append(
            {
                "chain": m.chain,
                "issuer": m.issuer,
                "token": m.token,
                "mint": m.mint,
                "instructions": {"freezeAccount": "freeze", "thawAccount": "unfreeze"},
                "source": m.source,
            }
        )
    return out
