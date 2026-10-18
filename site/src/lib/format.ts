/** One CSV field, quoted only when it has to be (RFC 4180). */
export const csvCell = (v: string | number | boolean) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const fmtInt = (n: number | null | undefined) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US");

export const fmtUsd = (n: number | string | null | undefined, digits = 0) => {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};

export const fmtCompactUsd = (n: number | string | null | undefined) => {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "k";
  return "$" + v.toFixed(0);
};

export const fmtDate = (unixOrIso: number | string) => {
  const d = typeof unixOrIso === "number" ? new Date(unixOrIso * 1000) : new Date(unixOrIso);
  return d.toISOString().slice(0, 10);
};

export const fmtDateTime = (unixOrIso: number | string) => {
  const d = typeof unixOrIso === "number" ? new Date(unixOrIso * 1000) : new Date(unixOrIso);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
};

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

export const fmtPct = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined ? "—" : (x * 100).toFixed(digits) + "%";

export const short = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

export const fmtDays = (d: number | null | undefined) =>
  d === null || d === undefined ? "—" : d < 1 ? `${Math.round(d * 24)} h` : `${Math.round(d)} d`;

export const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
};
