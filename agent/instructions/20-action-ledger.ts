import { defineDynamic, defineInstructions } from "eve/instructions";
import { actionLedger, renderLedgerInstructions } from "../lib/action-ledger.ts";

/** Re-resolve every turn so writes from the previous turn are visible to the voice. */
export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({
        markdown: renderLedgerInstructions(actionLedger.get()),
      }),
  },
});
