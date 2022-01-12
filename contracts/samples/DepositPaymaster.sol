// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.7;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../BasePaymaster.sol";

interface IOracle {

    /**
     * return amount of tokens that are required to receive that much eth.
     */
    function getTokenToEthOutputPrice(uint ethOutput) external view returns (uint);
}

/**
 * A token-based paymaster that accepts token deposit
 * The deposit is only a safeguard: the user pays with his token balance.
 *  only if the user didn't approve() the paymaster, or if the token balance is not enough, the deposit will be used.
 *  thus the required deposit is to cover just one method call.
 *
 * paymasterData holds the token to use.
*/
contract DepositPaymaster is BasePaymaster {

    IOracle constant nullOracle = IOracle(address(0));
    mapping(IERC20 => IOracle) public oracles;
    mapping(IERC20 => mapping(address => uint)) public balances;
    mapping(address => uint) unlockBlock;

    constructor(EntryPoint _entryPoint) BasePaymaster(_entryPoint) {}

    /**
     * owner of the paymaster should add supported tokens
     */
    function addToken(IERC20 token, IOracle tokenPriceOracle) external onlyOwner {
        require(oracles[token] == nullOracle);
        oracles[token] = tokenPriceOracle;
    }

    /**
     * approve owner-selected address to withdraw collected tokens.
     */
    function approve(IERC20 token, address target, uint amount) external onlyOwner {
        token.approve(target, amount);
    }

    /**
     * deposit tokens that a specific account can use to pay for gas.
     * The sender must first approve this paymaster to withdraw these tokens (they are only withdrawn in this method).
     * Note depositing the tokens is equivalent to transferring them to the "account" - only the account can later
     *  use them - either as gas, or using withdrawTo()
     *
     * @param token the token to deposit.
     * @param account the account to deposit for.
     * @param amount the amount of token to deposit.
     */
    function addDepositFor(IERC20 token, address account, uint amount) external {
        //(sender must have approval for the paymaster)
        token.transferFrom(msg.sender, address(this), amount);
        require(oracles[token] != nullOracle, "unsupported token");
        balances[token][account] += amount;
        if (msg.sender == account) {
            lockDeposit();
        }
    }

    /**
     * unlock deposit, so that it can be withdrawn.
     * can't be called on in the same block as withdrawTo()
     */
    function unlockDeposit() external {
        unlockBlock[msg.sender] = block.number;
    }

    /**
     * lock the tokens deposited for this account so they can be used to pay for gas.
     * after calling unlock(), the account can't use this paymaster until the deposit is locked.
     */
    function lockDeposit() public {
        unlockBlock[msg.sender] = 0;
    }

    /**
     * withdraw tokens.
     * can only be called after unlock() is called in a previous block.
     */
    function withdrawTo(IERC20 token, address target, uint amount) public {
        require(unlockBlock[msg.sender] != 0 && block.number > unlockBlock[msg.sender]);
        balances[token][msg.sender] -= amount;
        token.transfer(target, amount);
    }

    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32 requestId, uint maxCost)
    external view override returns (bytes memory context) {

        (requestId);
        require(userOp.paymasterData.length == 32, "DepositPaymaster: paymasterData must specify token");
        IERC20 token = abi.decode(userOp.paymasterData, (IERC20));
        IOracle oracle = oracles[token];
        require(oracle != nullOracle, "DepositPaymaster: unsupported token in paymasterData");
        address account = userOp.sender;
        uint maxTokenCost = oracle.getTokenToEthOutputPrice(maxCost);
        require(unlockBlock[account] == 0, "not locked");
        require(balances[token][account] >= maxTokenCost);
        return abi.encode(account, token, maxTokenCost, maxCost);
    }

    function _postOp(PostOpMode mode, bytes calldata context, uint actualGasCost) internal override {
        (mode);

        (address account, IERC20 token, uint maxTokenCost, uint maxCost) = abi.decode(context, (address, IERC20, uint, uint));
        //use same conversion rate as used for validation.
        uint actualTokenCost = actualGasCost * maxTokenCost / maxCost;
        balances[token][account] -= actualTokenCost;
    }
}