import { PublicKey } from "@solana/web3.js";
import {
  BPS_POWER,
  JUPITER_PERPETUALS_PROGRAM,
  RATE_POWER,
  USDC_DECIMALS,
} from "../constants";
import { BNToUSDRepresentation } from "../utils";

/**
 * Calculate the liquidation price for a Jupiter Perpetuals position
 * 
 * Liquidation price is the price at which the position would be forcibly closed
 * due to insufficient margin to cover potential losses and fees.
 * 
 * @param positionPubkey The public key of the position account
 */
export async function getLiquidationPrice(positionPubkey: PublicKey) {
  // Fetch the position data from the blockchain
  const position =
    await JUPITER_PERPETUALS_PROGRAM.account.position.fetch(positionPubkey);

  // Check if this is a closed position (sizeUsd = 0)
  if (position.sizeUsd.isZero()) {
    console.log(`Position ${positionPubkey.toString()} is closed (sizeUsd = 0). Liquidation price is not applicable.`);
    
    // Print some basic position info
    const side = position.side.long !== undefined ? "Long" : "Short";
    const entryPrice = BNToUSDRepresentation(position.price, USDC_DECIMALS);
    
    console.log(`Position type: ${side}`);
    console.log(`Entry price: $${entryPrice}`);
    return;
  }

  // Fetch the custody account for the asset being traded (e.g., SOL)
  const custody = await JUPITER_PERPETUALS_PROGRAM.account.custody.fetch(
    position.custody,
  );

  // Fetch the custody account for the collateral asset (e.g., USDC, SOL, etc.)
  const collateralCustody =
    await JUPITER_PERPETUALS_PROGRAM.account.custody.fetch(
      position.collateralCustody,
    );

  // STEP 1: Calculate closing fees
  
  // Calculate price impact fee based on position size and market depth
  // Larger positions relative to market depth have higher impact fees
  const priceImpactFeeBps = position.sizeUsd
    .mul(BPS_POWER)  // BPS_POWER = 10,000 (basis points scaling factor)
    .div(custody.pricing.tradeImpactFeeScalar); // Market depth factor
  
  // Get the base fee rate from the custody account (in basis points)
  const baseFeeBps = custody.decreasePositionBps;
  
  // Calculate total fee rate (base + impact)
  const totalFeeBps = baseFeeBps.add(priceImpactFeeBps);

  // Calculate closing fee in USD
  const closeFeeUsd = position.sizeUsd.mul(totalFeeBps).div(BPS_POWER);

  // STEP 2: Calculate borrowing/funding fees
  
  // Funding fees are based on the difference between the current cumulative interest rate
  // and the snapshot taken when the position was opened
  const borrowFeeUsd = collateralCustody.fundingRateState.cumulativeInterestRate
    .sub(position.cumulativeInterestSnapshot)  // Difference since position opened
    .mul(position.sizeUsd)  // Applied to position size
    .div(RATE_POWER);  // RATE_POWER = 1,000,000,000 (scaling factor for rates)

  // STEP 3: Calculate total fees
  const totalFeeUsd = closeFeeUsd.add(borrowFeeUsd);

  // STEP 4: Calculate maximum loss based on leverage
  
  // The maximum loss is determined by the position's size divided by max leverage
  // This represents how much the position can lose before being liquidated
  const maxLossUsd = position.sizeUsd
    .mul(BPS_POWER)
    .div(custody.pricing.maxLeverage)  // Higher leverage = smaller denominator = higher risk
    .add(totalFeeUsd);  // Add fees to the maximum loss

  // STEP 5: Get available margin (collateral)
  const marginUsd = position.collateralUsd;

  // STEP 6: Calculate the price difference needed to trigger liquidation
  
  // The price difference depends on the difference between max possible loss and available margin
  let maxPriceDiff = maxLossUsd.sub(marginUsd).abs();
  
  // Convert this USD amount to an equivalent price movement
  // by scaling it relative to position size and current price
  maxPriceDiff = maxPriceDiff.mul(position.price).div(position.sizeUsd);

  // STEP 7: Determine the liquidation price based on position side and margin status
  const liquidationPrice = (() => {
    if (position.side.long) {
      // For LONG positions:
      if (maxLossUsd.gt(marginUsd)) {
        // If potential loss > margin, price must DROP to liquidate (entry price - price diff)
        // This is the typical case: price drops, long position loses value
        return position.price.sub(maxPriceDiff);
      } else {
        // If margin > potential loss, price must RISE to liquidate (entry price + price diff)
        // This unusual case happens when funding fees accumulate in a profitable position
        // causing the position to be liquidated despite price moving favorably
        return position.price.add(maxPriceDiff);
      }
    } else {
      // For SHORT positions:
      if (maxLossUsd.gt(marginUsd)) {
        // If potential loss > margin, price must RISE to liquidate (entry price + price diff)
        // This is the typical case: price rises, short position loses value
        return position.price.add(maxPriceDiff);
      } else {
        // If margin > potential loss, price must DROP to liquidate (entry price - price diff)
        // This unusual case happens when funding fees accumulate in a profitable position
        // causing the position to be liquidated despite price moving favorably
        return position.price.sub(maxPriceDiff);
      }
    }
  })();

  // Display the calculated liquidation price
  console.log(
    "Liquidation price ($): ",
    BNToUSDRepresentation(liquidationPrice, USDC_DECIMALS),
  );
}

// Call the function directly with the Long SOL position PDA
console.log("\nChecking Long SOL position:");
getLiquidationPrice(new PublicKey("5BEUw4D4MQvgknkpG8uDTq5DgxJha6Fft4ei1QX5VGjK"));

// Also check other positions
console.log("\nChecking Short SOL with USDC position:");
getLiquidationPrice(new PublicKey("2oVLxJwCdU4eDqy7Koe5QGH71W26bxBuYaTYk6kYg23z")); 

console.log("\nChecking Short SOL with USDT position:");
getLiquidationPrice(new PublicKey("GjhRnptPCa6qXuTyK9UsvA2NBRpKGPURXjVHFCnoq5qH"));
