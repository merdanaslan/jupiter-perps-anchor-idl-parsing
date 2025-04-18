import { BN } from "@coral-xyz/anchor";
import { JUPITER_PERPETUALS_PROGRAM, USDC_DECIMALS } from "../constants";
import { PublicKey } from "@solana/web3.js";
import { BNToUSDRepresentation } from "../utils";

// Note that the calculation below gets the position's PNL before fees
export async function getPositionPnl(positionPubkey: PublicKey) {
  const position =
    await JUPITER_PERPETUALS_PROGRAM.account.position.fetch(positionPubkey);

  // NOTE: We assume the token price is $100 (scaled to 6 decimal places as per the USDC mint) as an example here for simplicity
  const tokenPrice = new BN(84573.05);

  const hasProfit = position.side.long
    ? tokenPrice.gt(position.price)
    : position.price.gt(tokenPrice);

  const tokenPriceDelta = tokenPrice.sub(position.price).abs();

  const pnl = position.sizeUsd.mul(tokenPriceDelta).div(position.price);

  console.log(
    "Position PNL ($): ",
    BNToUSDRepresentation(hasProfit ? pnl : pnl.neg(), USDC_DECIMALS),
  );
}

// Use a position PDA instead of wallet address
// This is the PDA for "Long SOL (using SOL as collateral)" for the wallet address
getPositionPnl(new PublicKey("EgvqoPV3QnUMEvhTSnxiqouye7bmDpT3p8HtuQ3AtiwJ"));

// Uncomment to check Short SOL with USDC
// getPositionPnl(new PublicKey("2oVLxJwCdU4eDqy7Koe5QGH71W26bxBuYaTYk6kYg23z"));

// Uncomment to check Short SOL with USDT
// getPositionPnl(new PublicKey("GjhRnptPCa6qXuTyK9UsvA2NBRpKGPURXjVHFCnoq5qH"));