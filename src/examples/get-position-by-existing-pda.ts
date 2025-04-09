import { PublicKey } from "@solana/web3.js";
import { type IdlAccounts } from "@coral-xyz/anchor";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import {
  CUSTODY_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM,
  RPC_CONNECTION,
  USDC_DECIMALS,
} from "../constants";
import { BNToUSDRepresentation } from "../utils";

/**
 * This file demonstrates how to fetch position data for a given position PDA.
 * Unlike get-positions-by-pda.ts which handles both PDA generation and position data retrieval,
 * this file only handles the position retrieval, with the PDA being passed in as a parameter.
 * 
 * Example usage:
 * ts-node src/examples/get-position-by-existing-pda.ts
 * 
 * The file will fetch and display all available data for the position.
 */

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

/**
 * Fetches position data for a given position PDA.
 * @param positionPda The PublicKey of the position PDA
 * @returns The decoded position data with readable format, or null if no position exists
 */
export async function getPositionByPda(
  positionPda: string | PublicKey
) {
  try {
    const positionPubkey = typeof positionPda === 'string' 
      ? new PublicKey(positionPda)
      : positionPda;
    
    // Fetch the position account
    console.log(`Fetching position data for PDA: ${positionPubkey.toBase58()}`);
    const accountInfo = await RPC_CONNECTION.getAccountInfo(positionPubkey);
    
    if (!accountInfo) {
      console.log("Position does not exist");
      return null;
    }
    
    // Decode the position data
    const decodedPosition = JUPITER_PERPETUALS_PROGRAM.coder.accounts.decode(
      "position",
      accountInfo.data
    ) as IdlAccounts<Perpetuals>["position"];
    
    // Determine asset and collateral names from the decoded position data
    const assetCustodyAddress = decodedPosition.custody.toBase58();
    const collateralCustodyAddress = decodedPosition.collateralCustody.toBase58();
    
    const assetName = getAssetNameFromCustody(assetCustodyAddress);
    const collateralName = getAssetNameFromCustody(collateralCustodyAddress);
    const side = decodedPosition.side.long !== undefined ? "Long" : "Short";
    
    // Generate description based on asset, collateral and side
    const description = `${side} ${assetName} (using ${collateralName} as collateral)`;
    
    const positionData = {
      publicKey: positionPubkey,
      account: decodedPosition,
      positionInfo: {
        type: side,
        custody: assetCustodyAddress,
        collateralCustody: collateralCustodyAddress,
        description
      },
      readable: {
        description,
        side,
        asset: assetName,
        collateral: collateralName,
        openTime: new Date(decodedPosition.openTime.toNumber() * 1000).toISOString(),
        updateTime: new Date(decodedPosition.updateTime.toNumber() * 1000).toISOString(),
        price: BNToUSDRepresentation(decodedPosition.price, USDC_DECIMALS),
        sizeUsd: BNToUSDRepresentation(decodedPosition.sizeUsd, USDC_DECIMALS),
        collateralUsd: BNToUSDRepresentation(decodedPosition.collateralUsd, USDC_DECIMALS),
        realisedPnlUsd: BNToUSDRepresentation(decodedPosition.realisedPnlUsd, USDC_DECIMALS),
        rawPrice: decodedPosition.price.toString(),
        rawRealisedPnl: decodedPosition.realisedPnlUsd.toString(),
        isOpen: decodedPosition.sizeUsd.gtn(0)
      }
    };
    
    // Print full position details including raw data
    console.log('\n========== POSITION DETAILS ==========');
    console.log('\n1. Basic Information:');
    console.log(`Position PDA: ${positionPubkey.toBase58()}`);
    console.log(`Description: ${positionData.readable.description}`);
    console.log(`Side: ${positionData.readable.side}`);
    console.log(`Status: ${positionData.readable.isOpen ? 'Open' : 'Closed'}`);
    
    console.log('\n2. Formatted Values:');
    console.log(`Price: $${positionData.readable.price}`);
    console.log(`Size: $${positionData.readable.sizeUsd}`);
    console.log(`Collateral: $${positionData.readable.collateralUsd}`);
    console.log(`Realized PnL: $${positionData.readable.realisedPnlUsd}`);
    console.log(`Opened: ${positionData.readable.openTime}`);
    console.log(`Last Updated: ${positionData.readable.updateTime}`);
    
    console.log('\n3. Raw Account Data:');
    console.log('--- Owner Information ---');
    console.log(`Owner: ${decodedPosition.owner.toBase58()}`);
    
    console.log('\n--- Market Information ---');
    console.log(`Pool: ${decodedPosition.pool.toBase58()}`);
    console.log(`Custody: ${decodedPosition.custody.toBase58()}`);
    console.log(`Collateral Custody: ${decodedPosition.collateralCustody.toBase58()}`);
    
    console.log('\n--- Position Status ---');
    console.log(`Side: ${JSON.stringify(decodedPosition.side)}`);
    
    console.log('\n--- Position Size & Value ---');
    console.log(`Size (USD): ${decodedPosition.sizeUsd.toString()}`);
    console.log(`Collateral (USD): ${decodedPosition.collateralUsd.toString()}`);
    console.log(`Price: ${decodedPosition.price.toString()}`);
    console.log(`Realized PnL (USD): ${decodedPosition.realisedPnlUsd.toString()}`);
    
    console.log('\n--- Timestamps ---');
    console.log(`Open Time: ${decodedPosition.openTime.toString()} (${positionData.readable.openTime})`);
    console.log(`Update Time: ${decodedPosition.updateTime.toString()} (${positionData.readable.updateTime})`);
    
    console.log('\n--- Full Raw Object ---');
    console.log(JSON.stringify(decodedPosition, (key, value) => {
      // Handle BN and PublicKey conversion for JSON display
      if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
        return value.toString();
      }
      if (value && typeof value === 'object' && 'toBase58' in value && typeof value.toBase58 === 'function') {
        return value.toBase58();
      }
      return value;
    }, 2));
    
    return positionData;
  } catch (error) {
    console.error(
      `Failed to fetch position for PDA ${positionPda}`,
      error
    );
    return null;
  }
}

// Example usage with just the PDA
getPositionByPda("5BEUw4D4MQvgknkpG8uDTq5DgxJha6Fft4ei1QX5VGjK");

