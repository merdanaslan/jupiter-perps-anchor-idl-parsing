import { BN } from "@coral-xyz/anchor";
import {
  BPS_POWER,
  CUSTODY_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM,
  USDC_DECIMALS,
} from "../constants";
import { BNToUSDRepresentation } from "../utils";
import { PublicKey } from "@solana/web3.js";

/**
 * Calculate the base fee for opening or closing a position
 * 
 * @param tradeSizeUsd The size of the trade in USD (atomic units)
 * @param custodyPubkey The public key of the asset's custody account
 * @param isOpen Whether to calculate open fee (true) or close fee (false)
 */
export async function getOpenCloseBaseFee(
  tradeSizeUsd: BN,
  custodyPubkey: PublicKey | string,
  isOpen: boolean = true
) {
  console.log(`\nCalculating ${isOpen ? 'open' : 'close'} fee for ${custodyPubkey.toString()}:`);
  console.log(`Trade size: $${BNToUSDRepresentation(tradeSizeUsd, USDC_DECIMALS)}`);
  
  // Fetch the custody account data
  const custody =
    await JUPITER_PERPETUALS_PROGRAM.account.custody.fetch(custodyPubkey);

  // Get the appropriate fee rate based on whether we're opening or closing
  const baseFeeBps = isOpen ? custody.increasePositionBps : custody.decreasePositionBps;
  
  console.log(`Base fee rate: ${baseFeeBps.toString()} bps (${baseFeeBps.toNumber() / 100}%)`);

  // Calculate the fee by multiplying trade size by the fee rate (in basis points)
  const feeUsd = tradeSizeUsd.mul(baseFeeBps).div(BPS_POWER);

  console.log(`Base fee: $${BNToUSDRepresentation(feeUsd, USDC_DECIMALS)}`);
  
  return feeUsd;
}

// Calculate fees for multiple assets with different sizes
async function compareAllFees() {
  // Create a consistent trade size for comparison (1000 USD)
  const tradeSize = new BN(1000).mul(new BN(10).pow(new BN(USDC_DECIMALS))); // 1000 USD in atomic units
  const largeTradeSize = new BN(10000).mul(new BN(10).pow(new BN(USDC_DECIMALS))); // 10000 USD in atomic units
  
  console.log("===== COMPARING OPENING FEES =====");
  // SOL Open Fee
  await getOpenCloseBaseFee(tradeSize, CUSTODY_PUBKEY.SOL, true);
  await getOpenCloseBaseFee(largeTradeSize, CUSTODY_PUBKEY.SOL, true);
  
  // BTC Open Fee
  await getOpenCloseBaseFee(tradeSize, CUSTODY_PUBKEY.BTC, true);
  
  // ETH Open Fee
  await getOpenCloseBaseFee(tradeSize, CUSTODY_PUBKEY.ETH, true);
  
  console.log("\n===== COMPARING CLOSING FEES =====");
  // SOL Close Fee
  await getOpenCloseBaseFee(tradeSize, CUSTODY_PUBKEY.SOL, false);
  
  // BTC Close Fee
  await getOpenCloseBaseFee(tradeSize, CUSTODY_PUBKEY.BTC, false);
  
  // ETH Close Fee
  await getOpenCloseBaseFee(tradeSize, CUSTODY_PUBKEY.ETH, false);
}

// Run the comparison
compareAllFees();