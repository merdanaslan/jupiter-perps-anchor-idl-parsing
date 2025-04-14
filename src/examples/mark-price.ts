import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { IDL as DovesIDL } from "../idl/doves-idl";
import { CUSTODY_PUBKEY, RPC_CONNECTION } from "../constants";
import { BNToUSDRepresentation } from "../utils";

// Doves oracle program that provides mark prices
const DOVES_PROGRAM_ID = new PublicKey(
  "DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e"
);

// Create a program instance to interact with the Doves oracle
const dovesProgram = new Program(
  DovesIDL,
  DOVES_PROGRAM_ID,
  new AnchorProvider(RPC_CONNECTION, new Wallet(Keypair.generate()), {
    preflightCommitment: "processed",
  })
);

// The oracle accounts for each perp asset
const PERP_ORACLE_ACCOUNTS = {
  [CUSTODY_PUBKEY.SOL]: new PublicKey("39cWjvHrpHNz2SbXv6ME4NPhqBDBd4KsjUYv5JkHEAJU"),
  [CUSTODY_PUBKEY.ETH]: new PublicKey("5URYohbPy32nxK1t3jAHVNfdWY2xTubHiFvLrE3VhXEp"),
  [CUSTODY_PUBKEY.BTC]: new PublicKey("4HBbPx9QJdjJ7GUe6bsiJjGybvfpDhQMMPXP1UEa7VT5"),
  // Add USDC and USDT oracle accounts
  [CUSTODY_PUBKEY.USDC]: new PublicKey("A28T5pKtscnhDo6C1Sz786Tup88aTjt8uyKewjVvPrGk"),
  [CUSTODY_PUBKEY.USDT]: new PublicKey("AGW7q2a3WxCzh5TB2Q6yNde1Nf41g3HLaaXdybz7cbBU"),
};

// Define types for price data
interface MarkPrice {
  price: BN;
  priceUsd: string;
  timestamp: number;
  formattedTimestamp: string;
  expo: number;
}

type AssetMarkPrices = {
  [key: string]: MarkPrice;
};

/**
 * Asset names for friendly display
 */
const ASSET_NAMES: { [key: string]: string } = {
  [CUSTODY_PUBKEY.SOL]: "SOL",
  [CUSTODY_PUBKEY.ETH]: "ETH",
  [CUSTODY_PUBKEY.BTC]: "BTC",
  [CUSTODY_PUBKEY.USDC]: "USDC",
  [CUSTODY_PUBKEY.USDT]: "USDT",
};

/**
 * Fetch current mark prices for Jupiter perpetual assets
 * @param includingStablecoins Whether to include stablecoins (USDC, USDT) in the results
 * @returns Object containing mark price data for each asset
 */
export async function fetchMarkPrices(includingStablecoins: boolean = false): Promise<AssetMarkPrices> {
  try {
    // Determine which assets to fetch
    const custodyKeys = [CUSTODY_PUBKEY.SOL, CUSTODY_PUBKEY.ETH, CUSTODY_PUBKEY.BTC];
    
    // Add stablecoins if requested
    if (includingStablecoins) {
      custodyKeys.push(CUSTODY_PUBKEY.USDC, CUSTODY_PUBKEY.USDT);
    }
    
    const oracleAccountsToFetch = custodyKeys.map(key => PERP_ORACLE_ACCOUNTS[key]);
    
    const feeds = await dovesProgram.account.priceFeed.fetchMultiple(oracleAccountsToFetch);
    
    const markPrices: AssetMarkPrices = {};
    
    feeds.forEach((feed, index) => {
      if (!feed) {
        console.error(`Failed to fetch oracle price for ${ASSET_NAMES[custodyKeys[index]] || custodyKeys[index]}`);
        return;
      }
      
      const timestamp = feed.timestamp.toNumber();
      
      markPrices[custodyKeys[index]] = {
        price: feed.price,
        priceUsd: BNToUSDRepresentation(feed.price, Math.abs(feed.expo)),
        timestamp,
        formattedTimestamp: new Date(timestamp * 1000).toISOString(),
        expo: feed.expo,
      };
    });
    
    return markPrices;
  } catch (error) {
    console.error("Error fetching mark prices:", error);
    throw error;
  }
}

/**
 * Print mark prices to console in a readable format
 * @param includingStablecoins Whether to include stablecoins (USDC, USDT) in the results
 */
export async function printMarkPrices(includingStablecoins: boolean = false): Promise<void> {
  try {
    const markPrices = await fetchMarkPrices(includingStablecoins);
    
    console.log("Jupiter Perp Mark Prices:");
    console.log("------------------------");
    
    Object.entries(markPrices).forEach(([custodyKey, priceData]) => {
      const assetName = ASSET_NAMES[custodyKey] || "Unknown";
      
      console.log(
        `${assetName}: $${priceData.priceUsd} (as of ${priceData.formattedTimestamp})`
      );
    });
  } catch (error) {
    console.error("Error printing mark prices:", error);
  }
}

/**
 * Example usage
 */
if (require.main === module) {
  printMarkPrices(true) // Include stablecoins
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Error in mark price example:", error);
      process.exit(1);
    });
} 