/** What stands in for the field when WebGL is missing, lost or throws. Lives
 *  outside Scene so it does not pull in three.js. */
export const FIELD_LABEL =
  "The field: every public freeze, release and destroyed balance as one point. The same rows are listed in the Registry below.";

export function FieldFallback() {
  return (
    <div role="img" aria-label={FIELD_LABEL} className="absolute inset-0 flex items-center justify-center px-6 text-center">
      <p className="max-w-[26rem] text-[13px] text-paper-3">
        The field needs WebGL, which this browser did not provide. Every row it draws is in the <a href="#registry">Registry</a> below.
      </p>
    </div>
  );
}
