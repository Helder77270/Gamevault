import { Address, BigInt } from "@graphprotocol/graph-ts";
import { StudioRegistered, GameCreated, EditionCreated } from "../generated/GameRegistry/GameRegistry";
import { Transfer as TransferEvent, LicenseMinted, UpdateUser } from "../generated/GameLicense/GameLicense";
import { Listed, Unlisted, Sale, PaymentCredited, Withdrawn } from "../generated/Marketplace/Marketplace";
import { Studio, Game, Edition, License, Transfer, RoyaltyPayment, Loan, PendingPayout } from "../generated/schema";

// ── GameRegistry ─────────────────────────────────────────────

export function handleStudioRegistered(e: StudioRegistered): void {
  const studio = new Studio(e.params.studioId.toString());
  studio.owner = e.params.owner;
  studio.name = e.params.name;
  studio.save();
}

export function handleGameCreated(e: GameCreated): void {
  const game = new Game(e.params.gameId.toString());
  game.studio = e.params.studioId.toString();
  game.title = e.params.title;
  game.save();
}

export function handleEditionCreated(e: EditionCreated): void {
  const edition = new Edition(e.params.editionId.toString());
  edition.game = e.params.gameId.toString();
  edition.supply = e.params.supply;
  edition.price = e.params.price;
  edition.royaltyBps = BigInt.fromI32(e.params.royaltyBps.toI32());
  edition.buildCid = e.params.buildCid;
  edition.buildHash = e.params.buildHash;
  edition.minted = BigInt.zero();
  edition.save();
}

// ── GameLicense ──────────────────────────────────────────────
// ERC-721 _mint emits Transfer(0x0 -> to) BEFORE our LicenseMinted, and
// handlers run in log order — so handleTransfer creates the License lazily
// and handleLicenseMinted fills in the edition link right after.

export function handleTransfer(e: TransferEvent): void {
  const id = e.params.tokenId.toString();
  let license = License.load(id);
  if (license == null) {
    license = new License(id);
    license.mintedAt = e.block.timestamp;
    license.listed = false;
  }
  license.owner = e.params.to;
  // Any transfer kills an open listing: the Marketplace rejects listings
  // made before the token moved (transferNonce, audit K3).
  license.listed = false;
  license.listPrice = null;
  license.save();

  const transfer = new Transfer(e.transaction.hash.toHexString() + "-" + e.logIndex.toString());
  transfer.license = id;
  transfer.from = e.params.from;
  transfer.to = e.params.to;
  transfer.timestamp = e.block.timestamp;
  transfer.txHash = e.transaction.hash;
  transfer.save();
}

export function handleLicenseMinted(e: LicenseMinted): void {
  const id = e.params.tokenId.toString();
  const license = License.load(id);
  if (license == null) return; // Transfer always precedes — defensive only
  license.edition = e.params.editionId.toString();
  license.save();

  const edition = Edition.load(e.params.editionId.toString());
  if (edition != null) {
    edition.minted = edition.minted.plus(BigInt.fromI32(1));
    edition.save();
  }
}

// Lending (ERC-4907 UpdateUser): user = borrower, or 0x0 when the loan ends
// early or dies with a resale. Natural expiry emits nothing — readers
// compare loanExpires with the current time.
export function handleUpdateUser(e: UpdateUser): void {
  const id = e.params.tokenId.toString();
  const license = License.load(id);
  if (license == null) return;
  const ended = e.params.user.equals(Address.zero());
  license.borrower = ended ? null : e.params.user;
  license.loanExpires = ended ? null : e.params.expires;
  license.save();

  const loan = new Loan(e.transaction.hash.toHexString() + "-" + e.logIndex.toString());
  loan.license = id;
  loan.owner = license.owner;
  loan.borrower = e.params.user;
  loan.expires = e.params.expires;
  loan.ended = ended;
  loan.timestamp = e.block.timestamp;
  loan.txHash = e.transaction.hash;
  loan.save();
}

// ── Marketplace ──────────────────────────────────────────────

export function handleListed(e: Listed): void {
  const license = License.load(e.params.tokenId.toString());
  if (license == null) return;
  license.listed = true;
  license.listPrice = e.params.price;
  license.save();
}

export function handleUnlisted(e: Unlisted): void {
  const license = License.load(e.params.tokenId.toString());
  if (license == null) return;
  license.listed = false;
  license.listPrice = null;
  license.save();
}

export function handleSale(e: Sale): void {
  const id = e.params.tokenId.toString();
  const license = License.load(id);
  if (license != null) {
    license.listed = false;
    license.listPrice = null;
    license.save();
  }

  const payment = new RoyaltyPayment(e.transaction.hash.toHexString() + "-" + e.logIndex.toString());
  payment.license = id;
  payment.seller = e.params.seller;
  payment.buyer = e.params.buyer;
  payment.salePrice = e.params.price;
  payment.royaltyAmount = e.params.royaltyAmount;
  payment.platformFee = e.params.platformFee;
  payment.timestamp = e.block.timestamp;
  payment.txHash = e.transaction.hash;
  payment.save();
}

// Pull-payment fallback (audit K4)
function payout(payee: Address): PendingPayout {
  let p = PendingPayout.load(payee.toHexString());
  if (p == null) {
    p = new PendingPayout(payee.toHexString());
    p.payee = payee;
    p.pending = BigInt.zero();
    p.totalCredited = BigInt.zero();
    p.totalWithdrawn = BigInt.zero();
  }
  return p;
}

export function handlePaymentCredited(e: PaymentCredited): void {
  const p = payout(e.params.payee);
  p.pending = p.pending.plus(e.params.amount);
  p.totalCredited = p.totalCredited.plus(e.params.amount);
  p.save();
}

export function handleWithdrawn(e: Withdrawn): void {
  const p = payout(e.params.payee);
  p.pending = p.pending.minus(e.params.amount);
  p.totalWithdrawn = p.totalWithdrawn.plus(e.params.amount);
  p.save();
}
