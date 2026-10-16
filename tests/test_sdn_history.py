"""Address listing dates from the SDN extract's git history, the bounded
grade they feed, and the join for addresses removed from the list."""

import io
import json
import shutil
import subprocess

import pytest

from freeze_ledger.attribution import grade as grading
from freeze_ledger.attribution.join import build_attributions
from freeze_ledger.attribution.sdn import parse_sdn_advanced
from freeze_ledger.attribution.sdn_history import listing_window, walk
from tests.conftest import quiet
from tests.test_attribution import ETH_ADDR, SDN_FIXTURE, TRX_ADDR

TORNADO = "0x" + "7" * 40
TRX_LATE = "TKfjV9RNKJJCqPvBtK8L7Knykh7DNWvnYt"

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


def _commit(repo, day, lists):
    for asset, addrs in lists.items():
        (repo / f"sanctioned_addresses_{asset}.json").write_text(json.dumps(addrs))
    env = {"GIT_AUTHOR_DATE": f"{day}T02:30:00Z", "GIT_COMMITTER_DATE": f"{day}T02:30:00Z"}
    run = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, env={**__import__("os").environ, **env})
    run("add", "-A")
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", day)


@needs_git
def test_walk_dates_listing_and_removal(tmp_path):
    repo = tmp_path / "lists"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "README.md").write_text("lists")
    _commit(repo, "2021-02-15", {})  # README only: ignored
    _commit(repo, "2022-09-03", {"ETH": [TORNADO], "XBT": ["bc1qnotinscope"]})  # first snapshot: bounded only
    _commit(repo, "2023-04-10", {"ETH": [TORNADO, ETH_ADDR]})
    _commit(repo, "2024-05-01", {"ETH": [TORNADO, ETH_ADDR], "TRX": [TRX_ADDR]})
    _commit(repo, "2025-03-22", {"ETH": [ETH_ADDR], "TRX": [TRX_ADDR]})
    _commit(repo, "2025-06-01", {"ETH": [ETH_ADDR], "TRX": [TRX_ADDR, TRX_LATE]})
    rows = {r["address_norm"]: r for r in walk(repo)}
    assert set(rows) == {TORNADO, ETH_ADDR, TRX_ADDR, TRX_LATE}  # bitcoin is out of scope
    t = rows[TORNADO]
    assert (t["first_seen"], t["not_before"], t["removed_at"]) == ("2022-09-03", "", "2025-03-22")
    assert t["last_seen"] == "2024-05-01"
    e = rows[ETH_ADDR]
    assert (e["first_seen"], e["not_before"], e["removed_at"]) == ("2023-04-10", "2023-04-09", "")
    # TRX_ADDR arrived with the TRX file itself: listed on or before that day, not on it
    assert rows[TRX_ADDR]["chain_hint"] == "tron" and rows[TRX_ADDR]["first_seen"] == "2024-05-01"
    assert rows[TRX_ADDR]["not_before"] == ""
    # a later addition to an existing file is dated to the day
    assert rows[TRX_LATE]["first_seen"] == "2025-06-01" and rows[TRX_LATE]["not_before"] == "2025-05-31"


def test_listing_window_uses_party_date_only_as_a_lower_bound():
    precise = {"first_seen": "2025-04-02", "not_before": "2025-04-01"}
    assert listing_window(precise, "2010-06-16") == ("2025-04-01", "2025-04-02")
    bounded = {"first_seen": "2022-09-03", "not_before": ""}
    assert listing_window(bounded, "2020-09-16") == ("2020-09-16", "2022-09-03")
    assert listing_window(None, "2019-09-13") == ("2019-09-13", "2019-09-13")


def test_party_designated_long_before_its_address_was_listed_grades_moderate():
    # a central bank designated in 2010, its address added in 2024, frozen in 2022
    g = grading.grade(source_class="ofac_sdn", match_basis="address", freeze_date="2022-06-01",
                      record_date="2024-05-01", record_date_earliest="2024-04-30")
    assert g.confidence == "moderate" and "predates it by at least" in g.basis
    # graded on the party's date, the same freeze used to pass as High
    assert grading.grade(source_class="ofac_sdn", match_basis="address", freeze_date="2022-06-01", record_date="2010-06-16").confidence == "high"
    # listing only bounded and the freeze inside the bounds: may postdate, so Moderate
    g = grading.grade(source_class="ofac_sdn", match_basis="address", freeze_date="2021-06-01",
                      record_date="2022-09-03", record_date_earliest="2020-09-16")
    assert g.confidence == "moderate" and "falls in that window" in g.basis
    # after the latest possible listing date: High
    g = grading.grade(source_class="ofac_sdn", match_basis="address", freeze_date="2022-09-10",
                      record_date="2022-09-03", record_date_earliest="2020-09-16")
    assert g.confidence == "high"


def test_join_grades_on_address_listing_and_attributes_removed_addresses(stores):
    _, _, attr, _ = stores
    events = [
        {"event_id": "tron:bb:0", "chain": "tron", "token": "USDT", "action": "freeze", "address": TRX_ADDR,
         "block_time": "2022-06-01T00:00:00Z", "block_number": "2", "log_index": "0", "issuer_internal": ""},
        {"event_id": "ethereum:0xdd:0", "chain": "ethereum", "token": "USDC", "action": "freeze", "address": TORNADO,
         "block_time": "2022-11-09T00:00:00Z", "block_number": "3", "log_index": "0", "issuer_internal": ""},
    ]
    sdn_rows = parse_sdn_advanced(io.BytesIO(SDN_FIXTURE.encode()))  # party designated 2019-09-13
    history = {
        ("tron", TRX_ADDR): {"first_seen": "2024-05-01", "not_before": "2024-04-30", "removed_at": "", "first_commit": "c1", "assets": "TRX"},
        ("evm", TORNADO): {"first_seen": "2022-11-09", "not_before": "2022-11-08", "removed_at": "2025-03-22", "first_commit": "c2", "assets": "ETH"},
    }
    build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=[], use_federal_register=False, history=history, store=attr, log=quiet)
    rows = {r["chain"]: r for r in attr.rows()}
    assert rows["tron"]["confidence"] == "moderate" and rows["tron"]["record_date"] == "2024-05-01"
    assert "party designated 2019-09-13" in rows["tron"]["basis"]
    removed = rows["ethereum"]
    assert removed["confidence"] == "high" and removed["entity"] == ""
    assert "removed from the SDN list on 2025-03-22" in removed["basis"]
    assert removed["evidence_url"].endswith("/commit/c2")


def test_join_withdraws_automatic_rows_no_rule_produces(stores):
    _, _, attr, _ = stores
    events = [{"event_id": "ethereum:0xaa:1", "chain": "ethereum", "token": "USDT", "action": "freeze", "address": ETH_ADDR,
               "block_time": "2023-05-01T00:00:00Z", "block_number": "1", "log_index": "1", "issuer_internal": ""}]
    stale = {"attribution_id": "at_old_notice", "address": ETH_ADDR, "chain": "ethereum", "source_class": "federal_register",
             "entity": "EXAMPLE GROUP", "program": "", "record_date": "2010-06-16", "confidence": "high",
             "basis": "notice for the party's 2010 designation", "evidence_url": "https://www.federalregister.gov/d/2010-1",
             "judged_at": "2026-01-01", "superseded_by": ""}
    attr.append([stale])
    sdn_rows = parse_sdn_advanced(io.BytesIO(SDN_FIXTURE.encode()))
    summary = build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=[], use_federal_register=False, history={}, store=attr, log=quiet)
    old = next(r for r in attr.rows() if r["attribution_id"] == "at_old_notice")
    assert old["superseded_by"].startswith("withdrawn:") and summary["attributions_superseded"] == 1


def test_solana_listing_matches_the_wallet_that_owns_the_frozen_token_account(stores):
    _, _, attr, _ = stores
    wallet, account = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi", "75SiuK87vRHQWdsBzami36z773DAqyekM6R5LNnvW6et"
    events = [{"event_id": "solana:sig:100", "chain": "solana", "token": "USDC", "action": "freeze", "address": account,
               "owner_address": wallet, "block_time": "2025-01-01T00:00:00Z", "block_number": "1", "log_index": "100", "issuer_internal": ""}]
    sdn_rows = [{"asset": "SOL", "address": wallet, "address_norm": wallet, "chain_hint": "solana", "entity": "X", "program": "CYBER2",
                 "listed_date": "2024-06-01", "fixed_ref": "1", "feature_id": "2", "source_url": ""}]
    build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=[], use_federal_register=False, history={}, store=attr, log=quiet)
    (row,) = attr.rows()
    assert row["address"] == account and row["chain"] == "solana" and "owns this frozen token account" in row["basis"]


def test_an_address_listed_under_two_asset_codes_settles_after_one_run(stores):
    _, _, attr, _ = stores
    events = [{"event_id": "ethereum:0xaa:1", "chain": "ethereum", "token": "USDT", "action": "freeze", "address": ETH_ADDR,
               "block_time": "2023-05-01T00:00:00Z", "block_number": "1", "log_index": "1", "issuer_internal": ""}]
    eth = parse_sdn_advanced(io.BytesIO(SDN_FIXTURE.encode()))[0]
    sdn_rows = [eth, {**eth, "asset": "USDT"}]  # same party and address, two asset codes
    history = {("evm", ETH_ADDR): {"first_seen": "2022-09-03", "not_before": "", "removed_at": "", "first_commit": "c", "assets": "ETH;USDT"}}
    first = build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=[], use_federal_register=False, history=history, store=attr, log=quiet)
    second = build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=[], use_federal_register=False, history=history, store=attr, log=quiet)
    assert first["attributions_written"] == 1
    assert second["attributions_written"] == 0 and second["attributions_superseded"] == 0


def test_returning_to_an_earlier_judgment_keeps_a_live_row(stores):
    _, _, attr, _ = stores
    events = [{"event_id": "ethereum:0xaa:1", "chain": "ethereum", "token": "USDT", "action": "freeze", "address": ETH_ADDR,
               "block_time": "2023-05-01T00:00:00Z", "block_number": "1", "log_index": "1", "issuer_internal": ""}]
    sdn_rows = parse_sdn_advanced(io.BytesIO(SDN_FIXTURE.encode()))[:1]
    run = lambda first_seen: build_attributions(
        events=events, sdn_rows=sdn_rows, manual_rows=[], use_federal_register=False, store=attr, log=quiet,
        history={("evm", ETH_ADDR): {"first_seen": first_seen, "not_before": "", "removed_at": "", "first_commit": "c", "assets": "ETH"}})
    run("2022-09-03")
    run("2024-01-01")
    run("2022-09-03")  # back to the first judgment
    live = [r for r in attr.rows() if not r["superseded_by"]]
    assert len(live) == 1 and live[0]["record_date"] == "2022-09-03"
    assert len({r["attribution_id"] for r in attr.rows()}) == len(attr.rows())
