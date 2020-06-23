// SPDX-License-Identifier: Apache-2.0

/*
 * Copyright 2019-2020, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

pragma solidity ^0.5.3;

import "./RollupUtils.sol";
import "./NodeGraphUtils.sol";
import "./VM.sol";
import "../IGlobalInbox.sol";

import "../arch/Value.sol";
import "../arch/Protocol.sol";

import "../libraries/RollupTime.sol";


contract NodeGraph {

    using SafeMath for uint256;

    // invalid leaf
    string constant MAKE_LEAF = "MAKE_LEAF";
    // Can only disputable assert if machine is not errored or halted
    string constant MAKE_RUN = "MAKE_RUN";
    // Tried to execute too many steps
    string constant MAKE_STEP = "MAKE_STEP";
    // Precondition: not within time bounds
    string constant MAKE_TIME = "MAKE_TIME";
    // Imported messages without reading them
    string constant MAKE_MESSAGES = "MAKE_MESSAGES";
    // Tried to import more messages than exist in ethe inbox
    string constant MAKE_MESSAGE_CNT = "MAKE_MESSAGE_CNT";

    string constant PRUNE_LEAF = "PRUNE_LEAF";
    string constant PRUNE_PROOFLEN = "PRUNE_PROOFLEN";
    string constant PRUNE_CONFLICT = "PRUNE_CONFLICT";

    uint256 constant VALID_CHILD_TYPE = 3;
    uint256 constant MAX_CHILD_TYPE = 3;

    // Fields
    //  prevLeaf
    //  inboxValue
    //  afterInboxTop
    //  importedMessagesSlice
    //  afterVMHash
    //  messagesAccHash
    //  logsAccHash
    //  validNodeHash

    event RollupAsserted(
        bytes32[8] fields,
        uint256 inboxCount,
        uint256 importedMessageCount,
        uint128[4] timeBounds,
        uint64 numArbGas,
        uint64 numSteps,
        bool didInboxInsn
    );

    event RollupConfirmed(bytes32 nodeHash);

    event RollupPruned(bytes32 leaf);

    event RollupCreated(bytes32 initVMHash);

    IGlobalInbox public globalInbox;
    VM.Params public vmParams;
    mapping (bytes32 => bool) private leaves;
    bytes32 private latestConfirmedPriv;

    function init(
        bytes32 _vmState,
        uint128 _gracePeriodTicks,
        uint128 _arbGasSpeedLimitPerTick,
        uint64 _maxExecutionSteps,
        uint64[2] memory _maxTimeBoundsWidth,
        address _globalInboxAddress
    )
        internal
    {
        globalInbox = IGlobalInbox(_globalInboxAddress);

        // VM protocol state
        bytes32 vmProtoStateHash = RollupUtils.protoStateHash(
            _vmState,
            Value.hashEmptyTuple(),
            0
        );
        bytes32 initialNode = RollupUtils.childNodeHash(
            0,
            0,
            0,
            0,
            vmProtoStateHash
        );
        latestConfirmedPriv = initialNode;
        leaves[initialNode] = true;

        // VM parameters
        vmParams.gracePeriodTicks = _gracePeriodTicks;
        vmParams.arbGasSpeedLimitPerTick = _arbGasSpeedLimitPerTick;
        vmParams.maxExecutionSteps = _maxExecutionSteps;
        vmParams.maxBlockBoundsWidth = _maxTimeBoundsWidth[0];
        vmParams.maxTimestampBoundsWidth = _maxTimeBoundsWidth[1];

        emit RollupCreated(_vmState);
    }

    function makeAssertion(NodeGraphUtils.AssertionData memory data) internal returns(bytes32, bytes32) {
        (bytes32 prevLeaf, bytes32 vmProtoHashBefore) = NodeGraphUtils.computePrevLeaf(data);
        require(isValidLeaf(prevLeaf), MAKE_LEAF);
        _verifyAssertionData(data);

        (bytes32 inboxValue, uint256 inboxCount) = globalInbox.getInbox(address(this));
        require(data.importedMessageCount <= inboxCount.sub(data.beforeInboxCount), MAKE_MESSAGE_CNT);

        bytes32 validLeaf = _initializeAssertionLeaves(
            data, 
            prevLeaf, 
            vmProtoHashBefore, 
            inboxValue, 
            inboxCount);

        delete leaves[prevLeaf];

        emitAssertedEvent(data, prevLeaf, validLeaf, inboxValue, inboxCount);
        return (prevLeaf, validLeaf);
    }

    function pruneLeaves(
        bytes32[] memory fromNodes,
        bytes32[] memory leafProofs,
        uint256[] memory leafProofLengths,
        bytes32[] memory latestConfProofs,
        uint256[] memory latestConfirmedProofLengths
    )
        public
    {
        uint pruneCount = fromNodes.length;

        require(
            leafProofLengths.length == pruneCount &&
            latestConfirmedProofLengths.length == pruneCount,
            "input length mistmatch"
        );
        uint256 prevLeafOffset = 0;
        uint256 prevConfOffset = 0;

        for (uint256 i = 0; i < pruneCount; i++) {
            (prevLeafOffset, prevConfOffset) = _pruneLeaf(
                fromNodes[i], 
                latestConfirmedProofLengths[i], 
                leafProofLengths[i],
                leafProofs,
                latestConfProofs,
                prevLeafOffset,
                prevConfOffset);
        }
    }

    function latestConfirmed() public view returns (bytes32) {
        return latestConfirmedPriv;
    }

    function isValidLeaf(bytes32 leaf) public view returns(bool) {
        return leaves[leaf];
    }

    function confirmNode(bytes32 to) internal {
        latestConfirmedPriv = to;
        emit RollupConfirmed(to);
    }

    function emitAssertedEvent(
        NodeGraphUtils.AssertionData memory data,
        bytes32 prevLeaf,
        bytes32 validLeaf,
        bytes32 inboxValue,
        uint256 inboxCount
    )
        private
    {
        emit RollupAsserted(
            [
                prevLeaf,
                inboxValue,
                data.afterInboxTop,
                data.importedMessagesSlice,
                data.afterVMHash,
                data.messagesAccHash,
                data.logsAccHash,
                validLeaf
            ],
            inboxCount,
            data.importedMessageCount,
            data.timeBounds,
            data.numArbGas,
            data.numSteps,
            data.didInboxInsn
        );
    }

    function _pruneLeaf(
        bytes32 from,
        uint256 latestConfirmedProofLength,
        uint256 leafProofLength,
        bytes32[] memory leafProofs,
        bytes32[] memory latestConfProofs,
        uint256 prevLeafOffset,
        uint256 prevConfOffset

    ) 
        private returns (uint256, uint256)
    {
        require(leafProofLength > 0 && latestConfirmedProofLength > 0, PRUNE_PROOFLEN);
        uint256 nextLeafOffset = prevLeafOffset + leafProofLength;
        uint256 nextConfOffset = prevConfOffset + latestConfirmedProofLength;

        // If the function call was produced valid at any point, either all these checks will pass or all will fail
        bool isValidNode = RollupUtils.calculateLeafFromPath(
            from, 
            latestConfProofs, 
            prevConfOffset, 
            nextConfOffset) == latestConfirmed();

        require(isValidNode && leafProofs[prevLeafOffset] != latestConfProofs[prevConfOffset], PRUNE_CONFLICT);

        bytes32 leaf = RollupUtils.calculateLeafFromPath(from, leafProofs, prevLeafOffset, nextLeafOffset);
        if (isValidLeaf(leaf)) {
            delete leaves[leaf];
            emit RollupPruned(leaf);
        }

        return (nextLeafOffset, nextConfOffset);
    }

    function _verifyAssertionData(NodeGraphUtils.AssertionData memory data) private view {
        require(!VM.isErrored(data.beforeVMHash) && !VM.isHalted(data.beforeVMHash), MAKE_RUN);
        require(data.numSteps <= vmParams.maxExecutionSteps, MAKE_STEP);
        require(data.timeBounds[1] <= data.timeBounds[0]+vmParams.maxBlockBoundsWidth);
        require(data.timeBounds[2] <= data.timeBounds[3]+vmParams.maxTimestampBoundsWidth);
        require(VM.withinTimeBounds(data.timeBounds), MAKE_TIME);
        require(data.importedMessageCount == 0 || data.didInboxInsn, MAKE_MESSAGES);
    }

    function _initializeAssertionLeaves(
        NodeGraphUtils.AssertionData memory data, 
        bytes32 prevLeaf,
        bytes32 vmProtoHashBefore,
        bytes32 inboxValue,
        uint256 inboxCount
    ) 
        private returns (bytes32) 
    {
        ( uint256 checkTimeTicks, 
          uint256 deadlineTicks ) = NodeGraphUtils.getTimeData(vmParams, data, block.number);

        bytes32 invalidInboxLeaf = NodeGraphUtils.generateInvalidInboxTopLeaf(
            data,
            prevLeaf,
            deadlineTicks,
            inboxValue,
            inboxCount,
            vmProtoHashBefore,
            vmParams.gracePeriodTicks
        );
        bytes32 invalidMsgsLeaf = NodeGraphUtils.generateInvalidMessagesLeaf(
            data,
            prevLeaf,
            deadlineTicks,
            vmProtoHashBefore,
            vmParams.gracePeriodTicks
        );
        bytes32 invalidExecLeaf = NodeGraphUtils.generateInvalidExecutionLeaf(
            data,
            prevLeaf,
            deadlineTicks,
            vmProtoHashBefore,
            vmParams.gracePeriodTicks,
            checkTimeTicks
        );
        bytes32 validLeaf = NodeGraphUtils.generateValidLeaf(
            data,
            prevLeaf,
            deadlineTicks
        );

        leaves[invalidInboxLeaf] = true;
        leaves[invalidMsgsLeaf] = true;
        leaves[invalidExecLeaf] = true;
        leaves[validLeaf] = true;

        return validLeaf;
    }
}
