import type { ReactNode } from "react";

/** One row of a phone list: two lines, a hairline under it, no box. The
 *  whole row is the tap target when it opens something. */
export function ListRow({
  top,
  topEnd,
  bottom,
  bottomEnd,
  onOpen,
  label,
}: {
  top: ReactNode;
  topEnd?: ReactNode;
  bottom?: ReactNode;
  bottomEnd?: ReactNode;
  onOpen?: () => void;
  /** accessible name when the row is a button */
  label?: string;
}) {
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0">{top}</span>
        {topEnd !== undefined && <span className="mono shrink-0 text-[12px] text-paper-3">{topEnd}</span>}
      </span>
      {(bottom !== undefined || bottomEnd !== undefined) && (
        <span className="mt-0.5 flex items-baseline justify-between gap-3 text-[12.5px]">
          <span className="min-w-0 truncate">{bottom}</span>
          {bottomEnd !== undefined && <span className="min-w-0 shrink truncate text-right">{bottomEnd}</span>}
        </span>
      )}
    </>
  );
  return (
    <li className="border-b border-rule">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={label}
          className="flex min-h-0 w-full flex-col rounded-none border-0 px-0 py-3 text-left text-[14px] hover:bg-[rgba(169,214,255,0.05)] active:bg-[rgba(169,214,255,0.09)]"
        >
          {body}
        </button>
      ) : (
        <div className="flex flex-col py-3 text-[14px]">{body}</div>
      )}
    </li>
  );
}
