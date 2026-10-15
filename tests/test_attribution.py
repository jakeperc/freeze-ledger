"""SDN parsing against a fixture in the advanced-XML shape, the grading
rules, and the join that writes attributions."""

import io

from freeze_ledger import registry
from freeze_ledger.attribution import grade as grading
from freeze_ledger.attribution.join import build_attributions
from freeze_ledger.attribution.sdn import parse_sdn_advanced
from tests.conftest import quiet

ETH_ADDR = "0x098b716b8aaf21512996dc57eb0615e2383e2f96"  # fixture value, lowercase on purpose
TRX_ADDR = "TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh"

SDN_FIXTURE = f"""<?xml version="1.0" encoding="utf-8"?>
<Sanctions xmlns="https://www.treasury.gov/ofac/DeltaFile/1.0">
  <ReferenceValueSets>
    <FeatureTypeValues>
      <FeatureType ID="345" FeatureTypeGroupID="1">Digital Currency Address - ETH</FeatureType>
      <FeatureType ID="800" FeatureTypeGroupID="1">Digital Currency Address - TRX</FeatureType>
      <FeatureType ID="25" FeatureTypeGroupID="2">Website</FeatureType>
    </FeatureTypeValues>
    <SanctionsTypeValues>
      <SanctionsType ID="1">Program</SanctionsType>
      <SanctionsType ID="2">Block</SanctionsType>
    </SanctionsTypeValues>
  </ReferenceValueSets>
  <DistinctParties>
    <DistinctParty FixedRef="36618">
      <Profile ID="36618" PartySubTypeID="3">
        <Identity ID="42" FixedRef="36618" Primary="true" False="false">
          <Alias AliasTypeID="1400" Primary="true">
            <DocumentedName ID="1" DocNameStatusID="1">
              <DocumentedNamePart><NamePartValue NamePartGroupID="9">EXAMPLE</NamePartValue></DocumentedNamePart>
              <DocumentedNamePart><NamePartValue NamePartGroupID="10">GROUP</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
          <Alias AliasTypeID="1403" Primary="false">
            <DocumentedName ID="2"><DocumentedNamePart><NamePartValue NamePartGroupID="9">AKA NAME</NamePartValue></DocumentedNamePart></DocumentedName>
          </Alias>
        </Identity>
        <Feature ID="9001" FeatureTypeID="345">
          <FeatureVersion ID="1" ReliabilityID="1"><VersionDetail DetailTypeID="1432">{ETH_ADDR}</VersionDetail></FeatureVersion>
          <IdentityReference IdentityID="42" IdentityFeatureLinkTypeID="1" />
        </Feature>
        <Feature ID="9002" FeatureTypeID="800">
          <FeatureVersion ID="1" ReliabilityID="1"><VersionDetail DetailTypeID="1432">{TRX_ADDR}</VersionDetail></FeatureVersion>
        </Feature>
        <Feature ID="9003" FeatureTypeID="25">
          <FeatureVersion ID="1"><VersionDetail>https://example.invalid</VersionDetail></FeatureVersion>
        </Feature>
      </Profile>
    </DistinctParty>
    <DistinctParty FixedRef="99">
      <Profile ID="99"><Identity ID="7" Primary="true"><Alias Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>NO ADDRESSES</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity></Profile>
    </DistinctParty>
  </DistinctParties>
  <SanctionsEntries>
    <SanctionsEntry ID="1" ProfileID="36618" ListID="1">
      <EntryEvent ID="1" EntryEventTypeID="1"><Date><Year>2019</Year><Month>9</Month><Day>13</Day></Date></EntryEvent>
      <SanctionsMeasure ID="1" SanctionsTypeID="1"><Comment>CYBER2</Comment></SanctionsMeasure>
      <SanctionsMeasure ID="2" SanctionsTypeID="1"><Comment>DPRK3</Comment></SanctionsMeasure>
      <SanctionsMeasure ID="3" SanctionsTypeID="2"><Comment>Block</Comment></SanctionsMeasure>
    </SanctionsEntry>
  </SanctionsEntries>
</Sanctions>
"""


def test_parse_sdn_fixture_extracts_addresses_entity_programs_and_date():
    rows = parse_sdn_advanced(io.BytesIO(SDN_FIXTURE.encode()))
    assert len(rows) == 2  # the website feature and the party without addresses are not rows
    eth = next(r for r in rows if r["asset"] == "ETH")
    trx = next(r for r in rows if r["asset"] == "TRX")
    assert eth["address_norm"] == ETH_ADDR and eth["chain_hint"] == "evm"
    assert trx["address_norm"] == TRX_ADDR and trx["chain_hint"] == "tron"
    assert eth["entity"] == "EXAMPLE GROUP"
    assert eth["program"] == "CYBER2;DPRK3"
    assert eth["listed_date"] == "2019-09-13"
    assert eth["fixed_ref"] == "36618" and eth["feature_id"] == "9001"


def test_grade_rules():
    g = grading.grade(source_class="ofac_sdn", match_basis="address", freeze_date="2023-05-01T00:00:00Z", record_date="2019-09-13")
    assert g.confidence == "high" and "after" in g.basis
    g = grading.grade(source_class="ofac_sdn", match_basis="address", freeze_date="2019-01-01T00:00:00Z", record_date="2019-09-13")
    assert g.confidence == "moderate" and "predates" in g.basis
    g = grading.grade(source_class="explorer_label", match_basis="address", freeze_date="2023-05-01", record_date="")
    assert g.confidence == "low"
    g = grading.grade(source_class="doj", match_basis="amount_date", freeze_date="2025-03-01", record_date="2025-03-04", amount_matches=True)
    assert g.confidence == "moderate"
    g = grading.grade(source_class="press", match_basis="date", freeze_date="2025-03-01", record_date="2025-03-04")
    assert g.confidence == "low"
    assert grading.corroborate("low", "low", both_primary=False) == "low"
    assert grading.corroborate("moderate", "moderate", both_primary=True) == "high"
    assert grading.corroborate("moderate", "moderate", both_primary=False) == "moderate"


def test_join_writes_graded_attributions_and_supersedes_on_change(stores):
    cps, store, attr, receipts = stores
    events = [
        {"event_id": "ethereum:0xaa:1", "chain": "ethereum", "token": "USDT", "action": "freeze", "address": ETH_ADDR,
         "block_time": "2023-05-01T00:00:00Z", "block_number": "1", "log_index": "1", "issuer_internal": ""},
        {"event_id": "tron:bb:0", "chain": "tron", "token": "USDT", "action": "freeze", "address": TRX_ADDR,
         "block_time": "2019-01-01T00:00:00Z", "block_number": "2", "log_index": "0", "issuer_internal": ""},
        {"event_id": "base:0xcc:0", "chain": "base", "token": "USDC", "action": "freeze", "address": "0x" + "9" * 40,
         "block_time": "2024-01-01T00:00:00Z", "block_number": "3", "log_index": "0", "issuer_internal": ""},
    ]
    sdn_rows = parse_sdn_advanced(io.BytesIO(SDN_FIXTURE.encode()))
    manual = [{"address": "0x" + "9" * 40, "chain": "base", "source_class": "explorer_label", "entity": "Fake_Phishing",
               "program": "", "record_date": "", "evidence_url": "https://basescan.org/address/0x" + "9" * 40,
               "match_basis": "address", "amount_matches": "", "notes": "tag seen 2024-02-01"}]
    summary = build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=manual, use_federal_register=False, store=attr, log=quiet)
    rows = attr.rows()
    assert summary["sdn_matches"] == 2 and len(rows) == 3
    by_chain = {r["chain"]: r for r in rows}
    assert by_chain["ethereum"]["confidence"] == "high" and by_chain["ethereum"]["program"] == "CYBER2;DPRK3"
    assert by_chain["tron"]["confidence"] == "moderate"  # frozen before the listing date
    assert by_chain["base"]["confidence"] == "low" and by_chain["base"]["source_class"] == "explorer_label"
    assert all(r["basis"] and r["judged_at"] for r in rows)
    assert by_chain["ethereum"]["evidence_url"].endswith("id=36618")

    # re-running with the same inputs writes nothing
    again = build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=manual, use_federal_register=False, store=attr, log=quiet)
    assert again["attributions_written"] == 0 and len(attr.rows()) == 3

    # a rating that changes appends a new row and supersedes the old one
    events[1]["block_time"] = "2020-01-01T00:00:00Z"  # now after the listing -> high
    third = build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=manual, use_federal_register=False, store=attr, log=quiet)
    rows = attr.rows()
    assert third["attributions_written"] == 1 and third["attributions_superseded"] == 1 and len(rows) == 4
    old = next(r for r in rows if r["chain"] == "tron" and r["confidence"] == "moderate")
    new = next(r for r in rows if r["chain"] == "tron" and r["confidence"] == "high")
    assert old["superseded_by"] == new["attribution_id"] and not new["superseded_by"]


def test_join_supersedes_rows_judged_from_the_independent_extract(stores):
    cps, store, attr, receipts = stores
    events = [{"event_id": "ethereum:0xaa:1", "chain": "ethereum", "token": "USDT", "action": "freeze", "address": ETH_ADDR,
               "block_time": "2023-05-01T00:00:00Z", "block_number": "1", "log_index": "1", "issuer_internal": ""}]
    placeholder = {"attribution_id": "at_placeholder", "address": ETH_ADDR, "chain": "ethereum", "source_class": "ofac_sdn",
                   "entity": "", "program": "", "record_date": "", "confidence": "high",
                   "basis": "exact address match in a primary record; entity and listing date pending the full SDN XML parse",
                   "evidence_url": registry.B10C_LISTS["ETH"], "judged_at": "2026-01-01", "superseded_by": ""}
    # the same address can sit on more than one independent list
    attr.append([placeholder, {**placeholder, "attribution_id": "at_placeholder_usdt", "evidence_url": registry.B10C_LISTS["USDT"]}])
    sdn_rows = parse_sdn_advanced(io.BytesIO(SDN_FIXTURE.encode()))
    summary = build_attributions(events=events, sdn_rows=sdn_rows, manual_rows=[], use_federal_register=False, store=attr, log=quiet)
    rows = {r["attribution_id"]: r for r in attr.rows()}
    graded = next(r for r in rows.values() if r["evidence_url"].endswith("id=36618"))
    assert summary["attributions_superseded"] == 2
    assert rows["at_placeholder"]["superseded_by"] == graded["attribution_id"]
    assert rows["at_placeholder_usdt"]["superseded_by"] == graded["attribution_id"] and not graded["superseded_by"]
