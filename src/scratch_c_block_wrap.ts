/**
 * Copyright 2026 Scratch Foundation
 * SPDX-License-Identifier: Apache-2.0
 */
import * as Blockly from 'blockly/core'

/**
 * When a C-block (a block with a statement input) is dropped onto a block that
 * is already in the middle of a stack, Blockly's default behaviour reconnects
 * the displaced block to the C-block's *next* connection (i.e. after the
 * C-block), leaving the C-block's "mouth" empty.  Scratch expects the
 * displaced block to be placed *inside* the C-block (wrap behaviour).
 *
 * We fix this by patching `Connection.getConnectionForOrphanedConnection` so
 * that it prefers an available statement-input connection on the dragging block
 * over the last-next-in-stack connection when the orphan is a statement block.
 * This applies to both real blocks and insertion markers (drag previews) so
 * that the preview matches the actual drop result.
 */
const originalGetConnectionForOrphanedConnection = Blockly.Connection.getConnectionForOrphanedConnection.bind(
  Blockly.Connection,
)

Blockly.Connection.getConnectionForOrphanedConnection = function (
  startBlock: Blockly.Block,
  orphanConnection: Blockly.Connection,
): Blockly.Connection | null {
  // Apply the wrapping logic when the orphaned connection is a statement
  // connection (PREVIOUS_STATEMENT).  Value connections (OUTPUT_VALUE) are
  // already handled by the original implementation.
  if ((orphanConnection.type as Blockly.ConnectionType) === Blockly.ConnectionType.PREVIOUS_STATEMENT) {
    const checker = orphanConnection.getConnectionChecker()
    for (const input of startBlock.inputList) {
      const conn = input.connection
      // Look for an unoccupied statement input (NEXT_STATEMENT) on the
      // dragging block.  Statement inputs are connections owned by an input
      // (getParentInput() !== null) rather than the block's own nextConnection.
      if (
        conn?.type === Blockly.ConnectionType.NEXT_STATEMENT &&
        !conn.isConnected() &&
        checker.canConnect(orphanConnection, conn, false)
      ) {
        return conn
      }
    }
  }
  return originalGetConnectionForOrphanedConnection(startBlock, orphanConnection)
}

/**
 * When a drag preview (insertion marker) is cleaned up, Blockly calls
 * `marker.unplug(true)` which heals the stack by reconnecting the block before
 * the marker to whatever block was after it (via `marker.nextConnection`).
 *
 * Because we now send the displaced block (B2) into the insertion marker's
 * statement input for a correct visual preview, B2 is no longer at
 * `marker.nextConnection` when cleanup runs.  The heal step therefore skips B2
 * and it gets lost when the marker is disposed.
 *
 * We fix this by patching `hideInsertionMarker` to restore B2 from the
 * marker's statement input back to `marker.nextConnection` before the original
 * cleanup runs, so the standard healing logic reconnects B1.next → B2.
 */
const previewerProto = Blockly.InsertionMarkerPreviewer.prototype
const hideInsertionMarker: unknown = Reflect.get(previewerProto, 'hideInsertionMarker')
if (typeof hideInsertionMarker !== 'function') {
  throw new Error('Expected InsertionMarkerPreviewer.hideInsertionMarker to be a function')
}
const originalHideInsertionMarker = hideInsertionMarker as (
  this: Blockly.InsertionMarkerPreviewer,
  markerConn: Blockly.Connection,
) => void
Reflect.set(
  previewerProto,
  'hideInsertionMarker',
  function (this: Blockly.InsertionMarkerPreviewer, markerConn: Blockly.Connection) {
    const marker = markerConn.getSourceBlock()
    const markerPreviousConnection = marker.previousConnection
    const markerNextConnection = marker.nextConnection

    // Restore a real block from a statement input so the stack heals correctly
    // when the marker is disposed. For C-blocks with a next connection (e.g.
    // repeat), we move the displaced block to marker.nextConnection so
    // unplug(true) can reconnect predecessor → displaced. For C-blocks without
    // a next connection (e.g. forever), we disconnect the marker from the stack
    // and reconnect predecessor → displaced directly.
    if (markerPreviousConnection?.isConnected()) {
      const displacedBlock = (() => {
        for (const input of marker.inputList) {
          const conn = input.connection
          const connType = conn?.type as Blockly.ConnectionType | undefined
          if (connType !== Blockly.ConnectionType.NEXT_STATEMENT || !conn?.isConnected()) {
            continue
          }
          const blockInInput = conn.targetBlock()
          if (blockInInput && !blockInInput.isInsertionMarker() && blockInInput.previousConnection) {
            return blockInInput
          }
        }
        return null
      })()

      if (displacedBlock) {
        const prev = displacedBlock.previousConnection
        if (prev) {
          prev.disconnect()
          if (markerNextConnection && !markerNextConnection.isConnected()) {
            // C-block with next connection: move to nextConnection so unplug(true) heals.
            markerNextConnection.connect(prev)
          } else if (!markerNextConnection) {
            // C-block without next connection (e.g. forever): no nextConnection
            // for unplug to use. Reconnect predecessor → displaced directly.
            const predecessor = markerPreviousConnection.targetBlock()
            markerPreviousConnection.disconnect()
            predecessor?.nextConnection?.connect(prev)
          }
        }
      }
    }

    originalHideInsertionMarker.call(this, markerConn)
  },
)
