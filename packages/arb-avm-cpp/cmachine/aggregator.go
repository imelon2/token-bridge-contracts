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

package cmachine

/*
#cgo CFLAGS: -I.
#cgo LDFLAGS: -L. -L../build/rocksdb -lcavm -lavm -ldata_storage -lavm_values -lavm_utils -lstdc++ -lm -lrocksdb
#include "../cavm/caggregator.h"
#include <stdio.h>
#include <stdlib.h>
*/
import "C"
import (
	"bytes"
	"errors"
	"unsafe"

	"github.com/offchainlabs/arbitrum/packages/arb-util/common"
	"github.com/offchainlabs/arbitrum/packages/arb-util/value"
)

type AggregatorStore struct {
	c unsafe.Pointer
}

type BlockInfo struct {
	Hash         common.Hash
	StartLog     uint64
	LogCount     uint64
	StartMessage uint64
	MessageCount uint64
}

func (as *AggregatorStore) LogCount() (uint64, error) {
	result := C.aggregatorLogCount(as.c)
	if result.found == 0 {
		return 0, errors.New("failed to load log count")
	}
	return uint64(result.value), nil
}

func (as *AggregatorStore) SaveLog(val value.Value) error {
	var buf bytes.Buffer
	if err := value.MarshalValue(val, &buf); err != nil {
		return err
	}

	cData := C.CBytes(buf.Bytes())
	defer C.free(cData)
	if C.aggregatorSaveLog(as.c, cData, C.uint64_t(buf.Len())) == 0 {
		return errors.New("failed to save block")
	}
	return nil
}

func (as *AggregatorStore) GetLog(index uint64) (value.Value, error) {
	result := C.aggregatorGetLog(as.c, C.uint64_t(index))
	if result.found == 0 {
		return nil, errors.New("failed to get log")
	}
	logBytes := toByteSlice(result.slice)
	return value.UnmarshalValue(bytes.NewBuffer(logBytes))
}

func (as *AggregatorStore) MessageCount() (uint64, error) {
	result := C.aggregatorMessageCount(as.c)
	if result.found == 0 {
		return 0, errors.New("failed to load message count")
	}
	return uint64(result.value), nil
}

func (as *AggregatorStore) SaveMessage(val value.Value) error {
	var buf bytes.Buffer
	if err := value.MarshalValue(val, &buf); err != nil {
		return err
	}

	cData := C.CBytes(buf.Bytes())
	defer C.free(cData)
	if C.aggregatorSaveMessage(as.c, cData, C.uint64_t(buf.Len())) == 0 {
		return errors.New("failed to save block")
	}

	return nil
}

func (as *AggregatorStore) GetMessage(index uint64) (value.Value, error) {
	result := C.aggregatorGetMessage(as.c, C.uint64_t(index))
	if result.found == 0 {
		return nil, errors.New("failed to get message")
	}
	logBytes := toByteSlice(result.slice)
	return value.UnmarshalValue(bytes.NewBuffer(logBytes))
}

func (as *AggregatorStore) BlockCount() (uint64, error) {
	result := C.aggregatorBlockCount(as.c)
	if result.found == 0 {
		return 0, errors.New("failed to load block count")
	}
	return uint64(result.value), nil
}

func (as *AggregatorStore) SaveBlock(id *common.BlockId) error {
	cHash := hashToData(id.HeaderHash)
	defer C.free(cHash)

	if C.aggregatorSaveBlock(as.c, C.uint64_t(id.Height.AsInt().Uint64()), cHash) == 0 {
		return errors.New("failed to save block")
	}
	return nil
}

func (as *AggregatorStore) GetBlock(height uint64) (BlockInfo, error) {
	blockData := C.aggregatorGetBlock(as.c, C.uint64_t(height))
	if blockData.found == 0 {
		return BlockInfo{}, errors.New("failed to get block")
	}
	return BlockInfo{
		Hash:         dataToHash(blockData.hash),
		StartLog:     uint64(blockData.start_log),
		LogCount:     uint64(blockData.log_count),
		StartMessage: uint64(blockData.start_message),
		MessageCount: uint64(blockData.message_count),
	}, nil
}

func (as *AggregatorStore) RestoreBlock(height uint64) error {
	if C.aggregatorRestoreBlock(as.c, C.uint64_t(height)) == 0 {
		return errors.New("failed to restore block")
	}
	return nil
}

func (as *AggregatorStore) GetRequest(requestId common.Hash) (value.Value, error) {
	cHash := hashToData(requestId)
	defer C.free(cHash)

	result := C.aggregatorGetRequest(as.c, cHash)
	if result.found == 0 {
		return nil, errors.New("failed to get request")
	}
	logBytes := toByteSlice(result.slice)
	return value.UnmarshalValue(bytes.NewBuffer(logBytes))
}

func (as *AggregatorStore) SaveRequest(requestId common.Hash, logIndex uint64) error {
	cHash := hashToData(requestId)
	defer C.free(cHash)

	if C.aggregatorSaveRequest(as.c, cHash, C.uint64_t(logIndex)) == 0 {
		return errors.New("failed to save request")
	}
	return nil
}
