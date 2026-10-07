// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FriendRegistry — mutual friendships with a timestamp.
/// @notice The lending guard in GameLicense reads friendsSince(): a loan is
///         only possible between MUTUAL friends of at least MIN_FRIEND_AGE.
///         The timestamp is the anti-Sybil anchor — combined with the friend
///         cap, it makes throwaway "friends" useless for commercial lending.
contract FriendRegistry {
    /// Hard cap on friends per address (Steam-Family style). Keeps the
    /// lending surface small and the friendsOf() view cheap.
    uint256 public constant MAX_FRIENDS = 16;

    /// requestedAt[from][to] — pending, not yet mutual.
    mapping(address => mapping(address => uint64)) public requestedAt;

    /// Canonical pair (lo, hi) -> timestamp the friendship became MUTUAL.
    mapping(address => mapping(address => uint64)) private _since;

    /// Enumeration for UIs: friendsOf(who).
    mapping(address => address[]) private _friends;
    /// index+1 of friend in _friends[who] (0 = absent)
    mapping(address => mapping(address => uint256)) private _idx;

    event FriendRequested(address indexed from, address indexed to);
    event FriendsSince(address indexed a, address indexed b, uint64 since);
    event Unfriended(address indexed a, address indexed b);

    function _pair(address x, address y) private pure returns (address lo, address hi) {
        (lo, hi) = x < y ? (x, y) : (y, x);
    }

    /// @notice When x and y became mutual friends — 0 if they are not.
    function friendsSince(address x, address y) public view returns (uint64) {
        (address lo, address hi) = _pair(x, y);
        return _since[lo][hi];
    }

    function friendsOf(address who) external view returns (address[] memory) {
        return _friends[who];
    }

    function friendCount(address who) external view returns (uint256) {
        return _friends[who].length;
    }

    function request(address to) external {
        require(to != msg.sender, "FriendRegistry: self");
        require(friendsSince(msg.sender, to) == 0, "FriendRegistry: already friends");
        require(_friends[msg.sender].length < MAX_FRIENDS, "FriendRegistry: friend cap");
        requestedAt[msg.sender][to] = uint64(block.timestamp);
        emit FriendRequested(msg.sender, to);
    }

    function accept(address from) external {
        require(requestedAt[from][msg.sender] != 0, "FriendRegistry: no request");
        require(friendsSince(msg.sender, from) == 0, "FriendRegistry: already friends");
        require(_friends[msg.sender].length < MAX_FRIENDS, "FriendRegistry: friend cap");
        require(_friends[from].length < MAX_FRIENDS, "FriendRegistry: their friend cap");
        delete requestedAt[from][msg.sender];
        delete requestedAt[msg.sender][from];

        (address lo, address hi) = _pair(msg.sender, from);
        _since[lo][hi] = uint64(block.timestamp);
        _friends[msg.sender].push(from);
        _idx[msg.sender][from] = _friends[msg.sender].length;
        _friends[from].push(msg.sender);
        _idx[from][msg.sender] = _friends[from].length;
        emit FriendsSince(lo, hi, uint64(block.timestamp));
    }

    /// @notice Either side can end a friendship. The 3-day clock restarts
    ///         from zero if they befriend again — that is the point.
    function remove(address friend_) external {
        require(friendsSince(msg.sender, friend_) != 0, "FriendRegistry: not friends");
        (address lo, address hi) = _pair(msg.sender, friend_);
        delete _since[lo][hi];
        _removeFromList(msg.sender, friend_);
        _removeFromList(friend_, msg.sender);
        emit Unfriended(lo, hi);
    }

    function _removeFromList(address who, address friend_) private {
        uint256 i = _idx[who][friend_];
        if (i == 0) return;
        address[] storage list = _friends[who];
        address last = list[list.length - 1];
        list[i - 1] = last;
        _idx[who][last] = i;
        list.pop();
        delete _idx[who][friend_];
    }
}
