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
	"log"
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
	"github.com/offchainlabs/arbitrum/packages/arb-validator/ethbridge/executionchallenge"
	"github.com/offchainlabs/arbitrum/packages/arb-validator/structures"
	"github.com/offchainlabs/arbitrum/packages/arb-validator/valprotocol"
)

var bisectedAssertionID ethcommon.Hash
var oneStepProofCompletedID ethcommon.Hash

func init() {
	parsed, err := abi.JSON(strings.NewReader(executionchallenge.ExecutionChallengeABI))
	if err != nil {
		panic(err)
	}
	bisectedAssertionID = parsed.Events["BisectedAssertion"].ID()
	oneStepProofCompletedID = parsed.Events["OneStepProofCompleted"].ID()
}

type executionChallenge struct {
	*bisectionChallenge
	challenge *executionchallenge.ExecutionChallenge
}

func newExecutionChallenge(address ethcommon.Address, client *ethclient.Client, auth *bind.TransactOpts) (*executionChallenge, error) {
	bisectionChallenge, err := newBisectionChallenge(address, client, auth)
	if err != nil {
		return nil, err
	}
	vm := &executionChallenge{bisectionChallenge: bisectionChallenge}
	err = vm.setupContracts()
	return vm, err
}

func (c *executionChallenge) setupContracts() error {
	challengeManagerContract, err := executionchallenge.NewExecutionChallenge(c.address, c.client)
	if err != nil {
		return errors2.Wrap(err, "Failed to connect to ChallengeManager")
	}

	c.challenge = challengeManagerContract
	return nil
}

func (c *executionChallenge) topics() []ethcommon.Hash {
	tops := []ethcommon.Hash{
		bisectedAssertionID,
		oneStepProofCompletedID,
	}
	return append(tops, c.bisectionChallenge.topics()...)
}

func (c *executionChallenge) StartConnection(ctx context.Context, outChan chan arbbridge.Notification, errChan chan error) error {
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

func (c *executionChallenge) processEvents(ctx context.Context, log types.Log, outChan chan arbbridge.Notification) error {
	event, err := func() (arbbridge.Event, error) {
		if log.Topics[0] == bisectedAssertionID {
			bisectChal, err := c.challenge.ParseBisectedAssertion(log)
			if err != nil {
				return nil, err
			}
			return arbbridge.ExecutionBisectionEvent{
				Assertions: translateBisectionEvent(bisectChal),
				TotalSteps: bisectChal.TotalSteps,
				Deadline:   common.TimeTicks{Val: bisectChal.DeadlineTicks},
			}, nil
		} else if log.Topics[0] == oneStepProofCompletedID {
			_, err := c.challenge.ParseOneStepProofCompleted(log)
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

	if event == nil {
		return nil
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

func (c *executionChallenge) BisectAssertion(
	ctx context.Context,
	precondition *valprotocol.Precondition,
	assertions []*valprotocol.ExecutionAssertionStub,
	totalSteps uint32,
) error {
	machineHashes := make([][32]byte, 0, len(assertions)+1)
	didInboxInsns := make([]bool, 0, len(assertions))
	messageAccs := make([][32]byte, 0, len(assertions)+1)
	logAccs := make([][32]byte, 0, len(assertions)+1)
	gasses := make([]uint64, 0, len(assertions))
	machineHashes = append(machineHashes, precondition.BeforeHash)
	messageAccs = append(messageAccs, assertions[0].FirstMessageHash)
	logAccs = append(logAccs, assertions[0].FirstLogHash)
	for _, assertion := range assertions {
		machineHashes = append(machineHashes, assertion.AfterHash)
		didInboxInsns = append(didInboxInsns, assertion.DidInboxInsn)
		messageAccs = append(messageAccs, assertion.LastMessageHash)
		logAccs = append(logAccs, assertion.LastLogHash)
		gasses = append(gasses, assertion.NumGas)
	}
	c.auth.Context = ctx
	tx, err := c.challenge.BisectAssertion(
		c.auth,
		precondition.BeforeInbox.Hash(),
		precondition.TimeBounds.AsIntArray(),
		machineHashes,
		didInboxInsns,
		messageAccs,
		logAccs,
		gasses,
		totalSteps,
	)
	if err != nil {
		return err
	}
	return c.waitForReceipt(ctx, tx, "BisectAssertion")
}

func (c *executionChallenge) OneStepProof(
	ctx context.Context,
	precondition *valprotocol.Precondition,
	assertion *valprotocol.ExecutionAssertionStub,
	proof []byte,
) error {
	log.Println("Calling OneStepProof proof with size", len(proof))
	c.auth.Context = ctx
	tx, err := c.challenge.OneStepProof(
		c.auth,
		precondition.BeforeHash,
		precondition.BeforeInbox.Hash(),
		precondition.TimeBounds.AsIntArray(),
		assertion.AfterHash,
		assertion.DidInboxInsn,
		assertion.FirstMessageHash,
		assertion.LastMessageHash,
		assertion.FirstLogHash,
		assertion.LastLogHash,
		assertion.NumGas,
		proof,
	)
	if err != nil {
		return err
	}
	return c.waitForReceipt(ctx, tx, "OneStepProof")
}

func (c *executionChallenge) ChooseSegment(
	ctx context.Context,
	assertionToChallenge uint16,
	preconditions []*valprotocol.Precondition,
	assertions []*valprotocol.ExecutionAssertionStub,
	totalSteps uint32,
) error {
	bisectionHashes := make([]common.Hash, 0, len(assertions))
	for i := range assertions {
		stepCount := structures.CalculateBisectionStepCount(uint32(i), uint32(len(assertions)), totalSteps)
		bisectionHashes = append(
			bisectionHashes,
			structures.ExecutionDataHash(stepCount, preconditions[i].Hash(), assertions[i].Hash()),
		)
	}
	return c.bisectionChallenge.chooseSegment(
		ctx,
		assertionToChallenge,
		bisectionHashes,
	)
}

func translateBisectionEvent(event *executionchallenge.ExecutionChallengeBisectedAssertion) []*valprotocol.ExecutionAssertionStub {
	bisectionCount := len(event.MachineHashes) - 1
	assertions := make([]*valprotocol.ExecutionAssertionStub, 0, bisectionCount)
	for i := 0; i < bisectionCount; i++ {
		assertion := &valprotocol.ExecutionAssertionStub{
			AfterHash:        event.MachineHashes[i+1],
			DidInboxInsn:     event.DidInboxInsns[i],
			NumGas:           event.Gases[i],
			FirstMessageHash: event.MessageAccs[i],
			LastMessageHash:  event.MessageAccs[i+1],
			FirstLogHash:     event.LogAccs[i],
			LastLogHash:      event.LogAccs[i+1],
		}
		assertions = append(assertions, assertion)
	}
	return assertions
}
