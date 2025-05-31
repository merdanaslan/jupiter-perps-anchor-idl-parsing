import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM_ID,
  CUSTODY_PUBKEYS,
  CUSTODY_PUBKEY,
} from "../constants";

// The `positionRequest` PDA holds the requests for all the perpetuals actions. Once the `positionRequest`
// is submitted on chain, the keeper(s) will pick them up and execute the requests (hence the request
// fulfillment model)
//
// https://station.jup.ag/guides/perpetual-exchange/onchain-accounts#positionrequest-account
export function generatePositionRequestPda({
  counter,
  positionPubkey,
  requestChange,
}: {
  counter?: BN;
  positionPubkey: PublicKey;
  requestChange: "increase" | "decrease";
}) {
  // The `counter` constant acts a random seed so we can generate a unique PDA every time the user
  // creates a position request
  if (!counter) {
    counter = new BN(Math.floor(Math.random() * 1_000_000_000));
  }

  const requestChangeEnum = requestChange === "increase" ? [1] : [2];
  const [positionRequest, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_request"),
      new PublicKey(positionPubkey).toBuffer(),
      counter.toArrayLike(Buffer, "le", 8),
      Buffer.from(requestChangeEnum),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );

  return { positionRequest, counter, bump };
}

// The `Position` PDA stores the position data for a trader's positions (both open and closed).
// https://station.jup.ag/guides/perpetual-exchange/onchain-accounts#position-account
export function generatePositionPda({
  custody,
  collateralCustody,
  walletAddress,
  side,
}: {
  custody: PublicKey;
  collateralCustody: PublicKey;
  walletAddress: PublicKey;
  side: "long" | "short";
}) {
  const [position, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      walletAddress.toBuffer(),
      JLP_POOL_ACCOUNT_PUBKEY.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      // @ts-ignore
      side === "long" ? [1] : [2], // This is due to how the `Side` enum is structured in the contract
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );

  return { position, bump };
}

// Helper function to get asset name from custody pubkey
function getAssetNameFromCustody(custodyPubkey: string): string {
  switch(custodyPubkey) {
    case CUSTODY_PUBKEY.SOL:
      return "SOL";
    case CUSTODY_PUBKEY.ETH:
      return "ETH";
    case CUSTODY_PUBKEY.BTC:
      return "BTC";
    case CUSTODY_PUBKEY.USDC:
      return "USDC";
    case CUSTODY_PUBKEY.USDT:
      return "USDT";
    default:
      return "Unknown";
  }
}

// Generate all possible position PDAs for a wallet
function generateAllPositionPdas(walletAddress: string) {
  const walletPubkey = new PublicKey(walletAddress);
  
  // Results container
  const results: Array<{
    type: string;
    positionPda: string;
    description: string;
  }> = [];
  
  // Loop through all custodies (SOL, BTC, ETH)
  for (let i = 0; i < 3; i++) {
    const assetCustody = CUSTODY_PUBKEYS[i];
    const assetName = getAssetNameFromCustody(assetCustody.toBase58());
    
    // Generate Long position PDA
    const longPosition = generatePositionPda({
      custody: assetCustody,
      collateralCustody: assetCustody, // For long, custody and collateralCustody are the same
      walletAddress: walletPubkey,
      side: "long",
    });
    
    results.push({
      type: "Long",
      positionPda: longPosition.position.toBase58(),
      description: `Long ${assetName} (using ${assetName} as collateral)`,
    });
    
    // Generate Short positions with USDC and USDT as collateral
    for (let j = 3; j < 5; j++) { // USDC and USDT are at index 3 and 4
      const stableCustody = CUSTODY_PUBKEYS[j];
      const stableName = getAssetNameFromCustody(stableCustody.toBase58());
      
      const shortPosition = generatePositionPda({
        custody: assetCustody,
        collateralCustody: stableCustody,
        walletAddress: walletPubkey,
        side: "short",
      });
      
      results.push({
        type: "Short",
        positionPda: shortPosition.position.toBase58(),
        description: `Short ${assetName} (using ${stableName} as collateral)`,
      });
    }
  }
  
  console.log(`Generated ${results.length} possible position PDAs for wallet ${walletAddress}:`);
  
  // Display results in a nice format
  results.forEach((item, index) => {
    console.log(`\n${index + 1}. ${item.description}`);
    console.log(`   PDA: ${item.positionPda}`);
    console.log(`   Type: ${item.type}`);
  });
  
  return results;
}

// Run for the specified wallet
generateAllPositionPdas("Ah1jvD1TrnS5DG49JABHHLqMmex9yQhCkF9sycKsqABC");

// DEaGQpCsnZDgvsZ3WdLgUSRAJP3Nv28DsGipLPgopdvb small wallet used for testing
// 4qXroAUadM5akVdBrt6ZNL3iRLVE3YboCF5TiKkFsZSp large wallet used for testing

/*generatePositionRequestPda({
  counter: new BN(1),
  positionPubkey: new PublicKey("5BEUw4D4MQvgknkpG8uDTq5DgxJha6Fft4ei1QX5VGjK"),
  requestChange: "increase",
});*/