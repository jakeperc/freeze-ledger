import { laneName } from "../lib/copy";
import { DATA_BASE, type Ledger } from "../lib/data";
import { fmtDate } from "../lib/format";

const REPO = "https://github.com/jakeperc/freeze-ledger";

export function Method({ ledger }: { ledger: Ledger }) {
  const gen = ledger.latest.generated_at;
  const open = Object.values(ledger.latest.coverage ?? {}).filter((c) => !c.complete);
  return (
    <section id="method" className="px-5 py-16 md:px-8 md:py-20">
      <div className="max-w-[72rem]">
        <h2 className="display text-[34px] md:text-[44px]">Method, in short</h2>
        <div className="mt-6 grid gap-10 md:grid-cols-3">
          <div className="rule pt-4">
            <div className="text-[15px]">What counts</div>
            <p className="mt-2 text-[13.5px] text-paper-2">
              A row is one action by the issuer against one address: a freeze (Tether's <span className="mono">AddedBlackList</span>, Circle's <span className="mono">Blacklisted</span>, Solana's <span className="mono">freezeAccount</span>), a release, or Tether destroying a frozen balance. Events are stored; "frozen now" is derived from the last action. Issuers' own contracts are kept, flagged, and excluded from the counts.
            </p>
          </div>
          <div className="rule pt-4">
            <div className="text-[15px]">What a record means</div>
            <p className="mt-2 text-[13.5px] text-paper-2">
              A public record is an OFAC SDN entry, Federal Register notice, DOJ filing or issuer statement that names the address, graded high, moderate or low with a sentence saying why it is not one level higher. High needs the record to be public no later than 30 days after the freeze; a freeze earlier than that is Moderate, because the record names the actor but cannot have triggered it. "No public record found" means exactly that. Attributions are the author's reading of public records, not the issuer's stated reason.
            </p>
          </div>
          <div className="rule pt-4">
            <div className="text-[15px]">What is missing</div>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13.5px] text-paper-2">
              {open.map((c) => <li key={c.chain + c.token}>{laneName(c)}: {c.note || "not complete"}.</li>)}
              <li>Polygon, Arbitrum, Avalanche and the other chains carrying these contracts are out of scope.</li>
              <li>Attribution reads the OFAC list as it stands and as it stood. DOJ filings, court orders and issuer statements are added by hand, and few are in yet.</li>
              <li>OFAC listing dates are known to the day only for addresses added after September 2022. Earlier ones are bounded, and graded no higher than the bounds allow.</li>
            </ul>
            <p className="mt-2 text-[12.5px] text-paper-3">The first line comes from the indexer's checkpoints, so it changes when the data does. The rest is in <a href={`${REPO}/blob/main/METHODOLOGY.md`} target="_blank" rel="noopener">METHODOLOGY.md</a>.</p>
          </div>
        </div>

        <div className="rule mt-12 grid gap-8 pt-6 md:grid-cols-[1fr_1fr]">
          <div>
            <div className="text-[13px] text-paper-3">Downloads</div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13.5px]">
              <a className="mono" href={DATA_BASE + "freeze_events.csv"} download>freeze_events.csv</a>
              <a className="mono" href={DATA_BASE + "attributions.csv"} download>attributions.csv</a>
              <a className="mono" href={DATA_BASE + "evidence.csv"} download>evidence.csv</a>
              <a className="mono" href={DATA_BASE + "sdn_addresses.csv"} download>sdn_addresses.csv</a>
              <a className="mono" href={DATA_BASE + "sdn_address_history.csv"} download>sdn_address_history.csv</a>
              <a className="mono" href={DATA_BASE + "latest.json"} download>latest.json</a>
              <a className="mono" href={REPO} target="_blank" rel="noopener">repository</a>
            </div>
            <p className="mt-3 text-[12.5px] text-paper-3">Data CC BY 4.0, code MIT. Cite as <span className="mono">Percy, J. Freeze Ledger, data as of {fmtDate(gen)}, {REPO.replace("https://", "")}</span>.</p>
          </div>
          <div className="text-[12.5px] text-paper-3">
            <div className="text-[13px]">About</div>
            <p className="mt-2">
              Built and maintained by <a href="https://jakepercy.com" target="_blank" rel="noopener">Jake Percy</a>. The indexer, grading rules, verification suite and this page are open; the nightly run commits only when the suite passes.
              Prior art: BlockSec's USDT tracker and a few commercial blacklist APIs publish live status; none publishes a versioned dataset with receipts, Solana freezes, or graded public-record attribution. Those three gaps are what this fills.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
