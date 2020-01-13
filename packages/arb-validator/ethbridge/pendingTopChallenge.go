/*
 * Copyright 2020, Offchain Labs, Inc.
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

package ethbridge

import (
	"context"
	"errors"
	"math/big"
	"strings"

	errors2 "github.com/pkg/errors"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	ethcommon "github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/offchainlabs/arbitrum/packages/arb-util/common"
	"github.com/offchainlabs/arbitrum/packages/arb-validator/arbbridge"
	"github.com/offchainlabs/arbitrum/packages/arb-validator/ethbridge/pendingtopchallenge"
	"github.com/offchainlabs/arbitrum/packages/arb-validator/structures"
)

var pendingTopBisectedID ethcommon.Hash
var pendingTopOneStepProofCompletedID ethcommon.Hash

func init() {
	parsed, err := abi.JSON(strings.NewReader(pendingtopchallenge.PendingTopChallengeABI))
	if err != nil {
		panic(err)
	}
	pendingTopBisectedID = parsed.Events["Bisected"].ID()
	pendingTopOneStepProofCompletedID = parsed.Events["OneStepProofCompleted"].ID()
}

type pendingTopChallenge struct {
	*bisectionChallenge
	contract *pendingtopchallenge.PendingTopChallenge
}

func newPendingTopChallenge(address ethcommon.Address, client *ethclient.Client, auth *bind.TransactOpts) (*pendingTopChallenge, error) {
	bisectionChallenge, err := newBisectionChallenge(address, client, auth)
	if err != nil {
		return nil, err
	}
	vm := &pendingTopChallenge{bisectionChallenge: bisectionChallenge}
	err = vm.setupContracts()
	return vm, err
}

func (c *pendingTopChallenge) setupContracts() error {
	challengeManagerContract, err := pendingtopchallenge.NewPendingTopChallenge(c.address, c.client)
	if err != nil {
		return errors2.Wrap(err, "Failed to connect to PendingTopChallenge")
	}

	c.contract = challengeManagerContract
	return nil
}

func (c *pendingTopChallenge) topics() []ethcommon.Hash {
	tops := []ethcommon.Hash{
		pendingTopBisectedID,
		pendingTopOneStepProofCompletedID,
	}
	return append(tops, c.bisectionChallenge.topics()...)
}

func (c *pendingTopChallenge) StartConnection(ctx context.Context, outChan chan arbbridge.Notification, errChan chan error) error {
	if err := c.setupContracts(); err != nil {
		return err
	}
	headers := make(chan *types.Header)
	headersSub, err := c.client.SubscribeNewHead(ctx, headers)
	if err != nil {
		return err
	}

	filter := ethereum.FilterQuery{
		Addresses: []ethcommon.Address{c.address},
		Topics:    [][]ethcommon.Hash{c.topics()},
	}

	logChan := make(chan types.Log, 1024)
	logErrChan := make(chan error, 10)

	if err := getLogs(ctx, c.client, filter, big.NewInt(0), logChan, logErrChan); err != nil {
		return err
	}

	go func() {
		defer headersSub.Unsubscribe()

		for {
			select {
			case <-ctx.Done():
				break
			case evmLog, ok := <-logChan:
				if !ok {
					errChan <- errors.New("logChan terminated early")
					return
				}
				if err := c.processEvents(ctx, evmLog, outChan); err != nil {
					errChan <- err
					return
				}
			case err := <-logErrChan:
				errChan <- err
				return
			case err := <-headersSub.Err():
				errChan <- err
				return
			}
		}
	}()
	return nil
}

func (c *pendingTopChallenge) processEvents(ctx context.Context, log types.Log, outChan chan arbbridge.Notification) error {
	event, err := func() (arbbridge.Event, error) {
		if log.Topics[0] == pendingTopBisectedID {
			eventVal, err := c.contract.ParseBisected(log)
			if err != nil {
				return nil, err
			}
			return arbbridge.PendingTopBisectionEvent{
				ChainHashes: hashSliceToHashes(eventVal.ChainHashes),
				TotalLength: eventVal.TotalLength,
				Deadline:    common.TimeTicks{Val: eventVal.DeadlineTicks},
			}, nil
		} else if log.Topics[0] == pendingTopOneStepProofCompletedID {
			_, err := c.contract.ParseOneStepProofCompleted(log)
			if err != nil {
				return nil, err
			}
			return arbbridge.OneStepProofEvent{}, nil
		} else {
			event, err := c.bisectionChallenge.parseBisectionEvent(log)
			if event != nil || err != nil {
				return event, err
			}
		}
		return nil, errors2.New("unknown arbitrum event type")
	}()

	if err != nil {
		return err
	}

	header, err := c.client.HeaderByHash(ctx, log.BlockHash)
	if err != nil {
		return err
	}
	outChan <- arbbridge.Notification{
		BlockHeader: common.NewHashFromEth(header.Hash()),
		BlockHeight: header.Number,
		VMID:        common.NewAddressFromEth(c.address),
		Event:       event,
		TxHash:      log.TxHash,
	}
	return nil
}

func (c *pendingTopChallenge) Bisect(
	ctx context.Context,
	chainHashes []common.Hash,
	chainLength *big.Int,
) error {
	c.auth.Context = ctx
	tx, err := c.contract.Bisect(
		c.auth,
		hashSliceToRaw(chainHashes),
		chainLength,
	)
	if err != nil {
		return err
	}
	return c.waitForReceipt(ctx, tx, "Bisect")
}

func (c *pendingTopChallenge) OneStepProof(
	ctx context.Context,
	lowerHashA common.Hash,
	topHashA common.Hash,
	value common.Hash,
) error {
	c.auth.Context = ctx
	tx, err := c.contract.OneStepProof(
		c.auth,
		lowerHashA,
		topHashA,
		value,
	)
	if err != nil {
		return err
	}
	return c.waitForReceipt(ctx, tx, "OneStepProof")
}

func (c *pendingTopChallenge) ChooseSegment(
	ctx context.Context,
	assertionToChallenge uint16,
	chainHashes []common.Hash,
	chainLength uint32,
) error {
	bisectionCount := uint32(len(chainHashes) - 1)
	bisectionHashes := make([]common.Hash, 0, bisectionCount)
	for i := uint32(0); i < bisectionCount; i++ {
		stepCount := structures.CalculateBisectionStepCount(i, bisectionCount, chainLength)
		bisectionHashes = append(
			bisectionHashes,
			structures.PendingTopChallengeDataHash(
				chainHashes[i],
				chainHashes[i+1],
				new(big.Int).SetUint64(uint64(stepCount)),
			),
		)
	}
	return c.bisectionChallenge.chooseSegment(
		ctx,
		assertionToChallenge,
		bisectionHashes,
	)
}
