// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IGameVaultEvents} from "./interfaces/IGameVaultEvents.sol";
import {GameRegistry} from "./GameRegistry.sol";

/// @title GameLicense — one token = one game copy.
/// @notice ownerOf() is what ticketd checks before sealing a ticket and what
///         the launcher checks live for instant revocation. EIP-2981 royalty
///         is set per-token at mint from the edition's royaltyBps — the
///         Marketplace READS it (load-bearing, not decorative).
///
///         LENDING (ERC-4907 views + guarded writes): lend() hands the play
///         right to a friend — like handing over the cartridge: while the
///         loan runs, ticketd refuses the OWNER and serves the borrower
///         (userOf). Friendship lives OFF-CHAIN (ticketd DB, wallet
///         signatures, zero gas): lend() takes a platform ATTESTATION
///         ("owner and borrower friends since T", signed by the platform
///         key) and enforces the age ON-CHAIN, plus per-token cooldown and
///         bounded duration. A transfer (resale) kills the loan — the
///         standard UpdateUser event makes that indexable.
contract GameLicense is ERC721, ERC2981, ReentrancyGuard, IGameVaultEvents {
    GameRegistry public immutable registry;
    /// Signs friendship attestations (ticketd's platform key).
    address public immutable platformSigner;
    uint256 public nextTokenId;
    mapping(uint256 tokenId => uint256) public editionOf;

    // ── Lending (ERC-4907 data model) ────────────────────────────
    struct UserInfo {
        address user;
        uint64 expires;
    }

    mapping(uint256 tokenId => UserInfo) private _users;
    /// When the last loan ENDED EARLY (endLoan/transfer). Natural expiry is
    /// read from the stale _users record — see _loanEndedAt().
    mapping(uint256 tokenId => uint64) public lastLoanEnd;

    /// Lending guard durations — set at deploy (prod: 3 d / 14 d / 24 h;
    /// a demo deployment can shrink them without touching the code).
    uint64 public immutable MIN_FRIEND_AGE;
    uint64 public immutable MAX_LOAN_DURATION;
    uint64 public immutable LOAN_COOLDOWN;

    /// ERC-4907 standard event — subgraphs and wallets understand it.
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    constructor(
        GameRegistry registryContract,
        address platformSigner_,
        uint64 minFriendAge,
        uint64 maxLoanDuration,
        uint64 loanCooldown
    ) ERC721("GameVault License", "GVL") {
        registry = registryContract;
        platformSigner = platformSigner_;
        MIN_FRIEND_AGE = minFriendAge;
        MAX_LOAN_DURATION = maxLoanDuration;
        LOAN_COOLDOWN = loanCooldown;
    }

    // ── ERC-4907 views ───────────────────────────────────────────

    /// @notice Current borrower, or address(0) when no live loan.
    function userOf(uint256 tokenId) public view returns (address) {
        UserInfo memory u = _users[tokenId];
        return (u.expires >= block.timestamp) ? u.user : address(0);
    }

    function userExpires(uint256 tokenId) external view returns (uint256) {
        return _users[tokenId].expires;
    }

    function _loanEndedAt(uint256 tokenId) private view returns (uint64) {
        uint64 ended = lastLoanEnd[tokenId];
        uint64 prev = _users[tokenId].expires; // stale after natural expiry
        return prev > ended ? prev : ended;
    }

    // ── Lending writes (guarded — this is NOT bare setUser) ─────

    /// @notice Digest the platform signs to attest a friendship — bound to
    ///         this chain and this contract so it cannot be replayed.
    function attestationDigest(address owner_, address to, uint64 since, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("GAMEVAULT_FRIEND_ATTEST", block.chainid, address(this), owner_, to, since, deadline));
    }

    /// @notice Lend the play right to a friend, for at most MAX_LOAN_DURATION.
    ///         One borrower per token; LOAN_COOLDOWN between loans of the
    ///         same token (anti rental-rotation). `since`/`deadline`/`sig`
    ///         form the platform's friendship attestation (fetched gas-free
    ///         from ticketd); the age rule is still enforced HERE.
    function lend(uint256 tokenId, address to, uint64 expires, uint64 since, uint64 deadline, bytes calldata sig)
        external
    {
        require(ownerOf(tokenId) == msg.sender, "GameLicense: not owner");
        require(to != msg.sender && to != address(0), "GameLicense: bad borrower");
        require(userOf(tokenId) == address(0), "GameLicense: loan active");
        uint64 nowTs = uint64(block.timestamp);
        require(nowTs >= _loanEndedAt(tokenId) + LOAN_COOLDOWN || _loanEndedAt(tokenId) == 0, "GameLicense: cooldown");
        require(nowTs <= deadline, "GameLicense: attestation expired");
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(attestationDigest(msg.sender, to, since, deadline));
        require(ECDSA.recover(digest, sig) == platformSigner, "GameLicense: bad attestation");
        require(since != 0, "GameLicense: not friends");
        require(nowTs >= since + MIN_FRIEND_AGE, "GameLicense: friendship too young");
        require(expires > nowTs && expires <= nowTs + MAX_LOAN_DURATION, "GameLicense: bad duration");

        _users[tokenId] = UserInfo(to, expires);
        emit UpdateUser(tokenId, to, expires);
    }

    /// @notice End a loan early — the owner reclaims, or the borrower
    ///         returns the game. Starts the cooldown.
    function endLoan(uint256 tokenId) external {
        UserInfo memory u = _users[tokenId];
        require(u.user != address(0) && u.expires >= block.timestamp, "GameLicense: no active loan");
        require(msg.sender == ownerOf(tokenId) || msg.sender == u.user, "GameLicense: not a party");
        lastLoanEnd[tokenId] = uint64(block.timestamp);
        delete _users[tokenId];
        emit UpdateUser(tokenId, address(0), 0);
    }

    /// A transfer is a resale: the loan dies with it (the new owner never
    /// inherits a borrower). Mint (from == 0) is untouched.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && _users[tokenId].user != address(0)) {
            lastLoanEnd[tokenId] = uint64(block.timestamp);
            delete _users[tokenId];
            emit UpdateUser(tokenId, address(0), 0);
        }
    }

    /// @notice Primary sale: pay the edition price, receive the license.
    ///         100% of the primary price goes to the studio.
    function buy(uint256 editionId) external payable nonReentrant returns (uint256 tokenId) {
        (address studioOwner, uint96 royaltyBps, uint256 price) = registry.recordMint(editionId);
        require(msg.value == price, "GameLicense: wrong price");

        tokenId = ++nextTokenId;
        editionOf[tokenId] = editionId;
        _safeMint(msg.sender, tokenId);
        _setTokenRoyalty(tokenId, studioOwner, royaltyBps);
        emit LicenseMinted(tokenId, editionId, msg.sender);

        Address.sendValue(payable(studioOwner), msg.value);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        // 0xad092b5c = ERC-4907
        return interfaceId == 0xad092b5c || super.supportsInterface(interfaceId);
    }
}
