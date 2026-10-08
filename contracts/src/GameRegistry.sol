// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGameVaultEvents} from "./interfaces/IGameVaultEvents.sol";

/// @title GameRegistry — studios, games, editions.
/// @notice Each edition carries buildCid + buildHash: the IPFS location and
///         integrity commitment of the encrypted build (public bytes; the
///         right to decrypt is what tickets sell).
contract GameRegistry is IGameVaultEvents {
    struct Studio {
        address owner;
        string name;
    }

    struct Game {
        uint256 studioId;
        string title;
    }

    struct Edition {
        uint256 gameId;
        uint256 supply;
        uint256 price; // wei, primary sale
        uint96 royaltyBps; // resale royalty to the studio (EIP-2981)
        string buildCid;
        bytes32 buildHash;
        uint256 minted;
        /// The studio's choice, fixed at creation so buyers know before they
        /// pay: false = copies can never change hands (no resale, no
        /// royalty). Lending still works: a loan is not a transfer.
        bool resellable;
    }

    uint96 public constant MAX_ROYALTY_BPS = 2000; // 20% hard cap

    address public immutable deployer;
    /// GameLicense — the only address allowed to record mints. Set once.
    address public license;

    uint256 public studioCount;
    uint256 public gameCount;
    uint256 public editionCount;
    mapping(uint256 studioId => Studio) public studios;
    mapping(uint256 gameId => Game) public games;
    mapping(uint256 editionId => Edition) public editions;

    constructor() {
        deployer = msg.sender;
    }

    function setLicense(address licenseContract) external {
        require(msg.sender == deployer, "GameRegistry: not deployer");
        require(license == address(0), "GameRegistry: license already set");
        license = licenseContract;
    }

    function registerStudio(string calldata name) external returns (uint256 studioId) {
        studioId = ++studioCount;
        studios[studioId] = Studio(msg.sender, name);
        emit StudioRegistered(studioId, msg.sender, name);
    }

    function createGame(uint256 studioId, string calldata title) external returns (uint256 gameId) {
        require(studios[studioId].owner == msg.sender, "GameRegistry: not studio owner");
        gameId = ++gameCount;
        games[gameId] = Game(studioId, title);
        emit GameCreated(gameId, studioId, title);
    }

    function createEdition(
        uint256 gameId,
        uint256 supply,
        uint256 price,
        uint96 royaltyBps,
        bool resellable,
        string calldata buildCid,
        bytes32 buildHash
    ) external returns (uint256 editionId) {
        require(studios[games[gameId].studioId].owner == msg.sender, "GameRegistry: not studio owner");
        require(supply > 0, "GameRegistry: zero supply");
        require(royaltyBps <= MAX_ROYALTY_BPS, "GameRegistry: royalty too high");
        require(resellable || royaltyBps == 0, "GameRegistry: royalty needs resale");
        editionId = ++editionCount;
        editions[editionId] = Edition(gameId, supply, price, royaltyBps, buildCid, buildHash, 0, resellable);
        emit EditionCreated(editionId, gameId, supply, price, royaltyBps, resellable, buildCid, buildHash);
    }

    function isResellable(uint256 editionId) external view returns (bool) {
        return editions[editionId].resellable;
    }

    /// @notice Called by GameLicense on primary purchase. Enforces supply.
    function recordMint(uint256 editionId)
        external
        returns (address studioOwner, uint96 royaltyBps, uint256 price)
    {
        require(msg.sender == license, "GameRegistry: only license");
        Edition storage e = editions[editionId];
        require(e.supply > 0, "GameRegistry: unknown edition");
        require(e.minted < e.supply, "GameRegistry: sold out");
        e.minted++;
        return (studios[games[e.gameId].studioId].owner, e.royaltyBps, e.price);
    }
}
