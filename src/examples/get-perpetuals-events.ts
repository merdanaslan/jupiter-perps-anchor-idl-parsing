import { DISCRIMINATOR_SIZE, utils } from "@coral-xyz/anchor";
import {
  JUPITER_PERPETUALS_EVENT_AUTHORITY_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM,
  RPC_CONNECTION,
} from "../constants";

// The Jupiter Perpetuals program emits events (via Anchor's CPI events: https://book.anchor-lang.com/anchor_in_depth/events.html)
// for most trade events. These events can be parsed and analyzed to track things like trades, executed TPSL requests, liquidations
// and so on.
// This function shows how to listen to these onchain events and parse / filter them.
export async function getPerpetualsEvents() {
  // Retrieve only confirmed transactions
  const confirmedSignatureInfos = await RPC_CONNECTION.getSignaturesForAddress(
    JUPITER_PERPETUALS_EVENT_AUTHORITY_PUBKEY,
  );

  // We ignore failed transactions, unless you're interested in tracking failed transactions as well
  const successSignatures = confirmedSignatureInfos
    .filter(({ err }) => err === null)
    .map(({ signature }) => signature);

  const txs = await RPC_CONNECTION.getTransactions(successSignatures, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  const allEvents = txs.flatMap((tx) => {
    return tx?.meta?.innerInstructions?.flatMap((ix) => {
      return ix.instructions.map((iix, ixIndex) => {
        const ixData = utils.bytes.bs58.decode(iix.data);

        // Anchor has an 8 byte discriminator at the start of the data buffer, which is why we need to remove it
        // from the final buffer so that the event decoder does not fail.
        const eventData = utils.bytes.base64.encode(
          ixData.subarray(DISCRIMINATOR_SIZE),
        );
        const event = JUPITER_PERPETUALS_PROGRAM.coder.events.decode(eventData);

        return {
          event,
          ixIndex,
          tx,
        };
      });
    });
  });

  // This is an example of filtering the `allEvents` array to only return close position request events
  // The full list of event names and types can be found in the `jupiter-perpetuals-idl.ts` file under the
  // `events` key
  const closePositionRequestEvents = allEvents.filter(
    (data) => data?.event?.name === "ClosePositionRequestEvent",
  );
}
