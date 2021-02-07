package core

import (
	"context"
	"errors"
	"github.com/offchainlabs/arbitrum/packages/arb-util/value"
	"math/big"
	"time"
)

type LogReader struct {
	consumer    LogConsumer
	cursor      LogsCursor
	cursorIndex big.Int
	maxCount    big.Int
}

func (lr *LogReader) getLogs(ctx context.Context) error {
	for {
		err := lr.cursor.LogsCursorRequest(&lr.cursorIndex, &lr.maxCount)
		if err != nil {
			return err
		}

		var logs []value.Value
		var deletedLogs []value.Value
		for {
			// Loop until new logs retrieved, may get deleted logs if reorg happened
			// Cannot retrieve new logs until deleted logs have been retrieved
			logs, err = lr.cursor.LogsCursorGetLogs(&lr.cursorIndex)
			if err != nil {
				return err
			}
			if logs != nil || deletedLogs != nil {
				// Retrieved logs successfully
				break
			}

			// No new logs yet, check if deleted logs
			deletedLogs, err := lr.cursor.LogsCursorGetDeletedLogs(&lr.cursorIndex)
			if err != nil {
				return err
			}
			if deletedLogs != nil {
				// Got deleted logs successfully, retry loop to get any new logs without waiting
				continue
			}

			// No new logs or deleted logs so give some time for new logs to be added
			time.Sleep(1 * time.Second)
		}

		if len(logs) > 0 {
			err = lr.consumer.AddLogs(logs)
			if err != nil {
				return err
			}
		}

		if len(deletedLogs) > 0 {
			err = lr.consumer.DeleteLogs(deletedLogs)
			if err != nil {
				return err
			}
		}

		for {
			status, err := lr.cursor.LogsCursorConfirmReceived(&lr.cursorIndex)
			if err != nil {
				return err
			}
			if status {
				// Successfully confirmed receipt of logs
				break
			}

			// Reorg happened since previous call to GetLogs.  Post-retrieve reorg of logscursor will only include
			// extra deleted logs, won't add any new logs
			newDeletedLogs, err := lr.cursor.LogsCursorGetDeletedLogs(&lr.cursorIndex)
			if err != nil {
				return err
			}
			if newDeletedLogs == nil {
				return errors.New("missing expected deleted logs")
			}

			// Got deleted logs successfully0w
			if len(newDeletedLogs) > 0 {
				err = lr.consumer.DeleteLogs(newDeletedLogs)
				if err != nil {
					return err
				}
			}
		}
	}
}
